import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { normalizeName } from '../common/matching/normalize';
import { parseImportFile, generateImportTemplate } from './file-parser.util';
import { ImportEntityType } from './types';

export { ImportEntityType };

export interface ImportRowResult {
  rowNumber: number;
  data: Record<string, string>;
  status: 'VALID' | 'INVALID' | 'DUPLICATE';
  errors: string[];
  insertError?: string;
}

export interface ImportSummary {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  importedRows: number;
  failedRows: number;
  rows: ImportRowResult[];
}

// Agency -> Advertiser -> Brand: Advertiser requires its Agency's code, Brand
// requires its Advertiser's code (both 1:N ownership chains, not link tables).
const REQUIRED_COLUMNS: Record<ImportEntityType, string[]> = {
  AGENCY: ['code', 'name'],
  ADVERTISER: ['code', 'name', 'agencyCode'],
  BRAND: ['code', 'name', 'advertiserCode'],
  MERCHANT: ['name'],
};

interface Resolved {
  exists: boolean;
  invalidReason?: string;
  insertData?: unknown;
}

/**
 * Excel/CSV/PDF Import (BRD section 17). Flow matches the BRD diagram: Upload ->
 * File Validation -> [parse] -> Data Validation -> Preview -> User Confirmation ->
 * Import -> Result - implemented as two stateless calls (preview, commit) instead
 * of an async import_jobs worker, since these files are small enough to parse
 * synchronously within a request.
 */
@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async parseFile(buffer: Buffer, filename: string): Promise<Record<string, string>[]> {
    return parseImportFile(buffer, filename);
  }

  async generateTemplate(entityType: ImportEntityType): Promise<Buffer> {
    return generateImportTemplate(entityType);
  }

  async preview(entityType: ImportEntityType, rows: Record<string, string>[]): Promise<ImportSummary> {
    return this.process(entityType, rows, false, undefined, []);
  }

  async commit(entityType: ImportEntityType, rows: Record<string, string>[], actorId: string, actorRoles: string[]): Promise<ImportSummary> {
    return this.process(entityType, rows, true, actorId, actorRoles);
  }

  private async process(
    entityType: ImportEntityType,
    rawRows: Record<string, string>[],
    doCommit: boolean,
    actorId: string | undefined,
    actorRoles: string[],
  ): Promise<ImportSummary> {
    const required = REQUIRED_COLUMNS[entityType];
    const seen = new Set<string>();
    const results: (ImportRowResult & { insertData?: unknown })[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      const rowNumber = i + 2; // row 1 is the header
      const missing = required.filter((col) => !row[col]?.trim()).map((col) => `${col} is required`);

      if (missing.length > 0) {
        results.push({ rowNumber, data: row, status: 'INVALID', errors: missing });
        continue;
      }

      const key = this.naturalKey(entityType, row, rowNumber);
      const inFileDup = seen.has(key);
      seen.add(key);

      const resolved = await this.resolve(entityType, row);

      if (resolved.invalidReason) {
        results.push({ rowNumber, data: row, status: 'INVALID', errors: [resolved.invalidReason] });
        continue;
      }

      if (inFileDup || resolved.exists) {
        results.push({
          rowNumber,
          data: row,
          status: 'DUPLICATE',
          errors: [inFileDup ? 'Duplicate within file' : 'Already exists in Master Data'],
          insertData: resolved.insertData,
        });
        continue;
      }

      results.push({ rowNumber, data: row, status: 'VALID', errors: [], insertData: resolved.insertData });
    }

    let importedRows = 0;
    let failedRows = 0;

    if (doCommit) {
      for (const r of results) {
        if (r.status !== 'VALID') continue;
        try {
          await this.insert(entityType, r.insertData, actorId as string, actorRoles);
          importedRows++;
        } catch (err) {
          failedRows++;
          r.insertError = err instanceof Error ? err.message : 'Insert failed';
        }
      }

      await this.audit.log({
        userId: actorId,
        action: 'IMPORT',
        objectType: entityType,
        newValue: { totalRows: rawRows.length, importedRows, failedRows },
      });
    }

    return {
      totalRows: rawRows.length,
      validRows: results.filter((r) => r.status === 'VALID').length,
      invalidRows: results.filter((r) => r.status === 'INVALID').length,
      duplicateRows: results.filter((r) => r.status === 'DUPLICATE').length,
      importedRows,
      failedRows,
      rows: results.map(({ insertData, ...rest }) => rest),
    };
  }

  private naturalKey(entityType: ImportEntityType, row: Record<string, string>, rowNumber: number): string {
    switch (entityType) {
      case 'AGENCY':
      case 'ADVERTISER':
      case 'BRAND':
        return `code:${row.code.trim().toUpperCase()}`;
      case 'MERCHANT':
        return `name:${normalizeName(row.name)}`;
    }
  }

  private async resolve(entityType: ImportEntityType, row: Record<string, string>): Promise<Resolved> {
    switch (entityType) {
      case 'AGENCY': {
        const code = row.code.trim();
        const existing = await this.prisma.agency.findUnique({ where: { code } });
        return { exists: !!existing, insertData: { code, name: row.name.trim() } };
      }
      case 'ADVERTISER': {
        const code = row.code.trim();
        const agencyCode = row.agencyCode.trim();
        const agency = await this.prisma.agency.findUnique({ where: { code: agencyCode } });
        if (!agency) return { exists: false, invalidReason: `Agency code "${agencyCode}" not found in Master Data` };
        const existing = await this.prisma.advertiser.findUnique({ where: { code } });
        return { exists: !!existing, insertData: { code, name: row.name.trim(), agencyId: agency.id } };
      }
      case 'BRAND': {
        const code = row.code.trim();
        const advertiserCode = row.advertiserCode.trim();
        const advertiser = await this.prisma.advertiser.findUnique({ where: { code: advertiserCode } });
        if (!advertiser) return { exists: false, invalidReason: `Advertiser code "${advertiserCode}" not found in Master Data` };
        const existing = await this.prisma.brand.findUnique({ where: { code } });
        return { exists: !!existing, insertData: { code, name: row.name.trim(), advertiserId: advertiser.id } };
      }
      case 'MERCHANT': {
        const name = row.name.trim();
        const normalizedName = normalizeName(name);
        const existing = await this.prisma.merchant.findFirst({ where: { normalizedName } });
        const alias = row.alias
          ? row.alias.split(',').map((a) => a.trim()).filter(Boolean)
          : [];
        return { exists: !!existing, insertData: { name, normalizedName, alias } };
      }
    }
  }

  private async insert(entityType: ImportEntityType, data: unknown, actorId: string, actorRoles: string[]): Promise<void> {
    switch (entityType) {
      case 'AGENCY':
        await this.prisma.agency.create({ data: data as any });
        return;
      case 'ADVERTISER':
        await this.prisma.advertiser.create({ data: data as any });
        return;
      case 'BRAND':
        await this.prisma.brand.create({ data: data as any });
        return;
      case 'MERCHANT':
        await this.prisma.merchant.create({ data: data as any });
        return;
    }
  }
}

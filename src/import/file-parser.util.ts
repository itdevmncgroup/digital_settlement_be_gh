import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { extractPdfText } from '../common/pdf/pdfjs-text.util';
import { ImportEntityType } from './types';

// exceljs is loaded lazily (not a top-level import) below - exceljs's
// zlib/inflate handling corrupts the old `pdf-parse` package's bundled pdf.js
// flate decoder when both are resident in the same process, which is why PDF
// text extraction here goes through pdfjs-text.util.ts instead (see there for
// the full story). Lazy-loading exceljs is kept anyway so a plain CSV/Excel-
// template request doesn't pull it in unnecessarily.

const TEMPLATE_COLUMNS: Record<ImportEntityType, string[]> = {
  AGENCY: ['code', 'name'],
  ADVERTISER: ['code', 'name', 'agencyCode'],
  BRAND: ['code', 'name', 'advertiserCode'],
  MERCHANT: ['name', 'alias'],
};

const TEMPLATE_EXAMPLE_ROW: Record<ImportEntityType, string[]> = {
  AGENCY: ['GRPM', 'GroupM Indonesia'],
  ADVERTISER: ['UNVR', 'PT Unilever Indonesia', 'GRPM'],
  BRAND: ['PEPSODENT', 'Pepsodent', 'UNVR'],
  MERCHANT: ['Sushi Tei', 'SUSHITEI,SUSHI TEI'],
};

/** Empty Excel template with a header row + one example row (BRD section 17 import flow). */
export async function generateImportTemplate(entityType: ImportEntityType): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(entityType);

  const columns = TEMPLATE_COLUMNS[entityType];
  const headerRow = sheet.addRow(columns);
  headerRow.font = { bold: true };
  sheet.addRow(TEMPLATE_EXAMPLE_ROW[entityType]);
  sheet.columns.forEach((col) => {
    col.width = 28;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Parses an uploaded Excel/CSV/PDF file into rows keyed by header (BRD section 17).
 * PDF support is best-effort: it assumes the file is a single simple table (e.g.
 * exported from a spreadsheet) and splits each line on runs of 2+ spaces or a tab -
 * accuracy depends entirely on how the PDF was generated, unlike CSV/Excel which are
 * parsed exactly.
 */
export async function parseImportFile(buffer: Buffer, filename: string): Promise<Record<string, string>[]> {
  const ext = filename.toLowerCase().split('.').pop();

  switch (ext) {
    case 'csv':
      return parseCsv(buffer);
    case 'xlsx':
    case 'xls':
      return parseExcel(buffer);
    case 'pdf':
      return parsePdf(buffer);
    default:
      throw new BadRequestException('Unsupported file type - use .csv, .xlsx, or .pdf');
  }
}

function parseCsv(buffer: Buffer): Record<string, string>[] {
  try {
    return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
  } catch (err) {
    throw new BadRequestException(`Could not parse CSV: ${err instanceof Error ? err.message : 'invalid file'}`);
  }
}

async function parseExcel(buffer: Buffer): Promise<Record<string, string>[]> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch (err) {
    throw new BadRequestException(`Could not parse Excel file: ${err instanceof Error ? err.message : 'invalid file'}`);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequestException('Excel file has no worksheets');

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '').trim();
  });

  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, string> = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (!header) return;
      const value = cell.text?.trim() ?? '';
      if (value) hasValue = true;
      obj[header] = value;
    });
    if (hasValue) rows.push(obj);
  });

  return rows;
}

async function parsePdf(buffer: Buffer): Promise<Record<string, string>[]> {
  let text: string;
  try {
    const data = await extractPdfText(buffer);
    text = data.text;
  } catch (err) {
    throw new BadRequestException(`Could not parse PDF: ${err instanceof Error ? err.message : 'invalid file'}`);
  }

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const splitLine = (line: string) => line.split(/\s{2,}|\t/).map((s) => s.trim()).filter(Boolean);
  const headers = splitLine(lines[0]);
  if (headers.length === 0) {
    throw new BadRequestException('Could not detect a header row in the PDF - expected columns separated by 2+ spaces or a tab');
  }

  return lines.slice(1).map((line) => {
    const cols = splitLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i] ?? '';
    });
    return obj;
  });
}

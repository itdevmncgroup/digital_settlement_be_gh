import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OdooSyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Pushes a fully signed-off Settlement (every member Expense COMPLETE - see
// ApprovalsService.settlementFullyComplete) to the external PR system (Odoo).
// Not triggered by the final approval tier: Sales CS picks the Unit and sends it
// manually (SettlementsService.sendDraftPr). A dead endpoint never throws - failures
// are persisted (odooSyncStatus=FAILED + odooSyncError), not just
// logged, and SettlementsService.retrySync lets an Admin retry a FAILED push -
// odooSyncStatus === SENT (not a null/date check) is the sole guard against
// double-sending an already-successful push.
@Injectable()
export class ExternalSyncService {
  private readonly logger = new Logger(ExternalSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get targetUrl(): string {
    return (
      this.config.get<string>('EXTERNAL_SETTLEMENT_API_URL') ||
      `${this.config.get<string>('API_PUBLIC_URL') || 'http://localhost:3000/api/v1'}/external/settlements`
    );
  }

  // orgId overrides the env default as the PR's org_id - the Unit Sales CS picked
  // in the Settlement list's "Create Draft PR" popup (Unit.code, e.g. RCTI).
  // attachment is the Draft PR PDF (SettlementPdfService.build), sent base64 as
  // `attachment`; the caller builds it first so a PDF failure never leaves the
  // Settlement stuck in PENDING.
  async pushSettlement(settlementId: string, opts: { orgId?: string; attachment: { buffer: Buffer; fileName: string } }): Promise<void> {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id: settlementId },
      include: { allocations: true },
    });
    if (!settlement) return;
    if (settlement.odooSyncStatus === OdooSyncStatus.SENT) return;

    await this.prisma.settlement.update({
      where: { id: settlementId },
      data: { odooSyncStatus: OdooSyncStatus.PENDING, odooSyncAttempts: { increment: 1 } },
    });

    const description = settlement.allocations.find((a) => a.description)?.description ?? '';

    const payload = {
      org_id: opts.orgId || this.config.get<string>('API_EXTERNAL_ORG_ID') || 'RCTI',
      referance: settlement.settlementNo,
      source: 'SALESCC',
      attachment: opts.attachment.buffer.toString('base64'),
      attachment_name: opts.attachment.fileName,
      description,
      pr_line: settlement.allocations.map((a) => ({
        product: a.account ?? '',
        qty: Number(a.qty),
        unit_price: Number(a.totalPrice),
        currency_code: a.curr,
        description: a.description ?? '',
        employee: '',
        project: '',
        task: '',
        sub_task: '',
        expenditure_type: '',
      })),
    };

    try {
      const res = await fetch(this.targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-key': this.config.get<string>('EXTERNAL_API_KEY') || '' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.logger.warn(`External settlement push for ${settlement.settlementNo} failed: HTTP ${res.status}`);
        await this.prisma.settlement.update({
          where: { id: settlementId },
          data: { odooSyncStatus: OdooSyncStatus.FAILED, odooSyncError: `HTTP ${res.status}` },
        });
        return;
      }
      await this.prisma.settlement.update({
        where: { id: settlementId },
        data: { odooSyncStatus: OdooSyncStatus.SENT, sentAt: new Date(), odooSyncError: null },
      });
      this.logger.log(`Settlement ${settlement.settlementNo} pushed to ${this.targetUrl}`);
    } catch (err) {
      this.logger.warn(`External settlement push for ${settlement.settlementNo} failed: ${(err as Error).message}`);
      await this.prisma.settlement.update({
        where: { id: settlementId },
        data: { odooSyncStatus: OdooSyncStatus.FAILED, odooSyncError: (err as Error).message.slice(0, 500) },
      });
    }
  }
}

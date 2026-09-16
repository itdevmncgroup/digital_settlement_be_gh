import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

// Pushes a fully signed-off Settlement (every member Expense COMPLETE - see
// ApprovalsService.settlementFullyComplete) to the external system. Fire-and-
// forget by design, same as the approval emails: a dead endpoint must never
// roll back or block the approval that triggered it, so failures are logged and
// externalSyncedAt simply stays null, leaving the batch eligible for a retry.
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

  async pushSettlement(settlementId: string): Promise<void> {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id: settlementId },
      include: {
        department: { select: { code: true, name: true } },
        createdBy: { select: { employeeId: true, name: true } },
        expenses: {
          include: {
            sales: { select: { employeeId: true, name: true } },
            advertiser: { select: { name: true } },
            brand: { select: { name: true } },
            paymentMethod: { select: { code: true, name: true } },
            items: { include: { category: { select: { name: true } } } },
          },
        },
      },
    });
    if (!settlement) return;
    if (settlement.externalSyncedAt) return;

    const payload = {
      settlementNo: settlement.settlementNo,
      status: settlement.status,
      department: settlement.department,
      totalAmount: Number(settlement.totalAmount),
      createdBy: settlement.createdBy,
      createdAt: settlement.createdAt,
      expenses: settlement.expenses.map((e) => ({
        expenseNo: e.expenseNo,
        status: e.status,
        expenseDate: e.expenseDate,
        amount: Number(e.amount),
        purpose: e.purpose,
        merchantName: e.merchantName,
        paymentMethod: e.paymentMethod ? { code: e.paymentMethod.code, name: e.paymentMethod.name } : null,
        sales: e.sales,
        advertiser: e.advertiser?.name ?? null,
        brand: e.brand?.name ?? null,
        items: e.items.map((i) => ({ description: i.description, amount: Number(i.amount), category: i.category?.name ?? null })),
      })),
    };

    try {
      const res = await fetch(this.targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.logger.warn(`External settlement push for ${settlement.settlementNo} failed: HTTP ${res.status}`);
        return;
      }
      await this.prisma.settlement.update({ where: { id: settlementId }, data: { externalSyncedAt: new Date() } });
      this.logger.log(`Settlement ${settlement.settlementNo} pushed to ${this.targetUrl}`);
    } catch (err) {
      this.logger.warn(`External settlement push for ${settlement.settlementNo} failed: ${(err as Error).message}`);
    }
  }
}

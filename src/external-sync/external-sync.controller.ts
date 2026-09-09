import { Body, Controller, Get, Logger, Post } from '@nestjs/common';

type ReceivedSettlement = { receivedAt: string; settlementNo: string; totalAmount: number; expenseCount: number; payload: unknown };

// Dummy stand-in for the real external system, so the end of the approval chain
// has something to push to until the actual endpoint exists: point
// EXTERNAL_SETTLEMENT_API_URL elsewhere and this becomes unused. Unauthenticated
// on purpose (it models a third-party receiver, not an app API) and keeps only
// the last few payloads in memory for eyeballing what was sent.
@Controller('external/settlements')
export class ExternalSettlementsController {
  private readonly logger = new Logger(ExternalSettlementsController.name);
  private static readonly received: ReceivedSettlement[] = [];
  private static readonly MAX_KEPT = 20;

  @Post()
  receive(@Body() body: { settlementNo?: string; totalAmount?: number; expenses?: unknown[] }) {
    const entry: ReceivedSettlement = {
      receivedAt: new Date().toISOString(),
      settlementNo: body?.settlementNo ?? '(none)',
      totalAmount: body?.totalAmount ?? 0,
      expenseCount: body?.expenses?.length ?? 0,
      payload: body,
    };
    ExternalSettlementsController.received.unshift(entry);
    ExternalSettlementsController.received.length = Math.min(ExternalSettlementsController.received.length, ExternalSettlementsController.MAX_KEPT);
    this.logger.log(`Received settlement ${entry.settlementNo} (${entry.expenseCount} expense(s), total ${entry.totalAmount})`);
    return { received: true, settlementNo: entry.settlementNo, expenseCount: entry.expenseCount };
  }

  @Get()
  list() {
    return ExternalSettlementsController.received;
  }
}

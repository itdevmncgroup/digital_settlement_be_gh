import { Body, Controller, Get, Logger, Post } from '@nestjs/common';

type ReceivedSettlement = { receivedAt: string; referance: string; orgId: string; prLineCount: number; payload: unknown };

// Dummy stand-in for the real external PR system, so the end of the approval
// chain has something to push to until the actual endpoint exists: point
// EXTERNAL_SETTLEMENT_API_URL elsewhere and this becomes unused. Unauthenticated
// on purpose (it models a third-party receiver, not an app API) and keeps only
// the last few payloads in memory for eyeballing what was sent.
@Controller('external/settlements')
export class ExternalSettlementsController {
  private readonly logger = new Logger(ExternalSettlementsController.name);
  private static readonly received: ReceivedSettlement[] = [];
  private static readonly MAX_KEPT = 20;

  @Post()
  receive(@Body() body: { org_id?: string; referance?: string; attachment?: string; pr_line?: unknown[] }) {
    const entry: ReceivedSettlement = {
      receivedAt: new Date().toISOString(),
      referance: body?.referance ?? '(none)',
      orgId: body?.org_id ?? '(none)',
      prLineCount: body?.pr_line?.length ?? 0,
      // The base64 PDF would sit in memory x MAX_KEPT - keep only its size.
      payload: { ...body, attachment: body?.attachment ? `(base64, ${body.attachment.length} chars)` : undefined },
    };
    ExternalSettlementsController.received.unshift(entry);
    ExternalSettlementsController.received.length = Math.min(ExternalSettlementsController.received.length, ExternalSettlementsController.MAX_KEPT);
    this.logger.log(`Received PR ${entry.referance} (org ${entry.orgId}, ${entry.prLineCount} line(s))`);
    return { received: true, referance: entry.referance };
  }

  @Get()
  list() {
    return ExternalSettlementsController.received;
  }
}

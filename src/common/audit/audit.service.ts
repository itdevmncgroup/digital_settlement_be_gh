import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditLogInput {
  userId?: string | null;
  action: string; // CREATE | UPDATE | DELETE | UPLOAD | OCR | MATCHING | MANUAL_CORRECTION | SUBMIT | APPROVE | REJECT | RESUBMIT | IMPORT | EXPORT
  objectType: string;
  objectId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  device?: string | null;
}

/**
 * Writes to audit_logs (BRD section 24). Every mutating action on financial
 * or master data must go through here - OCR correction, approval, matching,
 * import/export included once those modules land.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: AuditLogInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId ?? null,
        oldValue: input.oldValue === undefined ? undefined : (input.oldValue as any),
        newValue: input.newValue === undefined ? undefined : (input.newValue as any),
        ipAddress: input.ipAddress ?? null,
        device: input.device ?? null,
      },
    });
  }
}

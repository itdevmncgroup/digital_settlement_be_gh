import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { PrismaService } from '../prisma/prisma.service';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

// Wraps firebase-admin. Lazily initialized from FIREBASE_SERVICE_ACCOUNT_JSON
// (the full service-account JSON, as a string - e.g. from a secrets manager)
// or FIREBASE_SERVICE_ACCOUNT_PATH (a path to the JSON file, for local dev).
// Neither configured is a normal, supported state (no Firebase project set up
// yet) - sendToUser just logs once and no-ops, same as EmailService's
// fire-and-forget failure handling. Nothing in the approval flow depends on
// push actually being delivered.
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private app: App | null | undefined; // undefined = not yet attempted, null = attempted and unavailable

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private getApp(): App | null {
    if (this.app !== undefined) return this.app;

    const json = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON');
    const path = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');
    try {
      const credential = json ? cert(JSON.parse(json)) : path ? cert(path) : null;
      if (!credential) {
        this.logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON/PATH not set - push notifications are disabled.');
        this.app = null;
        return null;
      }
      this.app = initializeApp({ credential });
      return this.app;
    } catch (err) {
      this.logger.error(`Failed to initialize Firebase Admin: ${(err as Error).message}`);
      this.app = null;
      return null;
    }
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    const app = this.getApp();
    if (!app) return;

    try {
      const tokens = await this.prisma.deviceToken.findMany({ where: { userId }, select: { id: true, token: true } });
      if (tokens.length === 0) return;

      const result = await getMessaging(app).sendEachForMulticast({
        tokens: tokens.map((t) => t.token),
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      });

      const stale = result.responses
        .map((r, i) => ({ ok: r.success, code: r.error?.code, id: tokens[i].id }))
        .filter((r) => !r.ok && r.code === 'messaging/registration-token-not-registered')
        .map((r) => r.id);
      if (stale.length > 0) {
        await this.prisma.deviceToken.deleteMany({ where: { id: { in: stale } } });
      }
    } catch (err) {
      this.logger.warn(`Push send failed for user ${userId}: ${(err as Error).message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, DeviceTokenPlatform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from './push.service';

export interface NotifyParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  deepLink?: string;
  objectType: string;
  objectId: string;
}

// The in-app + push side of approval-activity notifications (the email side
// is EmailService, called separately by approvals.service.ts's notifyStep).
// Fire-and-forget by design, same contract as notifyStep: a failure here must
// never fail the approval transaction it's called from.
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  async notify(params: NotifyParams): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: params.userId,
          type: params.type,
          title: params.title,
          body: params.body,
          deepLink: params.deepLink,
          objectType: params.objectType,
          objectId: params.objectId,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record notification for user ${params.userId}: ${(err as Error).message}`);
    }

    await this.push.sendToUser(params.userId, {
      title: params.title,
      body: params.body,
      data: { objectType: params.objectType, objectId: params.objectId, deepLink: params.deepLink ?? '' },
    });
  }

  findForUser(userId: string, unreadOnly = false) {
    return this.prisma.notification.findMany({
      where: { userId, read: unreadOnly ? false : undefined },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  countUnread(userId: string) {
    return this.prisma.notification.count({ where: { userId, read: false } });
  }

  async markRead(id: string, userId: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { id, userId }, data: { read: true } });
  }

  async registerDeviceToken(userId: string, token: string, platform: DeviceTokenPlatform): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  }

  async unregisterDeviceToken(token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
  }
}

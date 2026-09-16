import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { RegisterDeviceTokenDto } from './dto/notifications.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Own-data only (no RolesGuard/@Roles) - every authenticated user reads and
// manages their own notifications and devices, same pattern as /auth/me.
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  findAll(@CurrentUser() actor: AuthUser, @Query('unreadOnly') unreadOnly?: string) {
    return this.service.findForUser(actor.userId, unreadOnly === 'true');
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() actor: AuthUser) {
    return { count: await this.service.countUnread(actor.userId) };
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.markRead(id, actor.userId);
  }

  @Post('device-tokens')
  registerDeviceToken(@Body() dto: RegisterDeviceTokenDto, @CurrentUser() actor: AuthUser) {
    return this.service.registerDeviceToken(actor.userId, dto.token, dto.platform);
  }

  @Delete('device-tokens/:token')
  unregisterDeviceToken(@Param('token') token: string) {
    return this.service.unregisterDeviceToken(token);
  }
}

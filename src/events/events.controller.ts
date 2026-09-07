import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { RoleName } from 'src/common/constants/role-name';
import { EventsService } from './events.service';
import { CreateEventDto, UpdateEventDto } from './dto/event.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords } from '../common/rbac/scope.util';

// Pre-Event (BRD section 7, 8) - optional; Sales may skip straight to Expense.
@Controller('events')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EventsController {
  constructor(private readonly service: EventsService) {}

  @Get()
  findAll(
    @CurrentUser() actor: AuthUser,
    @Query('status') status?: EventStatus,
    @Query('salesId') salesId?: string,
    @Query('search') search?: string,
  ) {
    const filterSalesId = canViewAllRecords(actor) ? salesId : actor.userId;
    return this.service.findAll({ salesId: filterSalesId, status, search });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  create(@Body() dto: CreateEventDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId, actor.roles);
  }

  @Patch(':id')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  update(@Param('id') id: string, @Body() dto: UpdateEventDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId, actor.roles);
  }

  @Post(':id/submit')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  submit(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.submit(id, actor.userId, actor.roles);
  }

  // Approve/reject now live on the shared Approval Level engine:
  // POST /approvals/event/:eventId/approve|reject (see ApprovalsController).
}

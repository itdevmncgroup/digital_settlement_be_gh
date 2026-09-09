import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { RoleName } from 'src/common/constants/role-name';
import { ApprovalsService } from './approvals.service';
import { CreateApprovalLevelDto, UpdateApprovalLevelDto } from './dto/approval-level.dto';
import { RejectDto } from './dto/reject.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

function actionResultPage(title: string, message: string, ok: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0f1117;color:#e4e6eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#171922;border:1px solid #2a2d3a;border-radius:8px;padding:32px 40px;max-width:420px;text-align:center}
h1{font-size:18px;color:${ok ? '#4ecb71' : '#f0605f'}}p{color:#8b8f9c;font-size:14px}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

@Controller('approval-levels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN)
export class ApprovalLevelsController {
  constructor(private readonly service: ApprovalsService) {}

  @Get()
  findAll() {
    return this.service.findLevels();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findLevel(id);
  }

  @Post()
  create(@Body() dto: CreateApprovalLevelDto, @CurrentUser() actor: AuthUser) {
    return this.service.createLevel(dto, actor.userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateApprovalLevelDto, @CurrentUser() actor: AuthUser) {
    return this.service.updateLevel(id, dto, actor.userId);
  }
}

// Approval Workflow (BRD section 22, 26 -> Transaction > Approval). Authorization
// is no longer role-based: any authenticated user may call these, but the service
// only allows an action when the caller is the step's resolvedApproverId.
@Controller('approvals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApprovalsController {
  constructor(private readonly service: ApprovalsService) {}

  @Get('pending')
  pending(
    @CurrentUser() actor: AuthUser,
    @Query('departmentId') departmentId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.service.findPendingFor(actor.userId, actor.permissions, { departmentId, fromDate, toDate });
  }

  @Get('expense/:expenseId')
  findByExpense(@Param('expenseId') expenseId: string) {
    return this.service.findByExpense(expenseId);
  }

  @Get('event/:eventId')
  findByEvent(@Param('eventId') eventId: string) {
    return this.service.findByEvent(eventId);
  }

  @Post('expense/:expenseId/approve')
  approveExpense(@Param('expenseId') expenseId: string, @CurrentUser() actor: AuthUser) {
    return this.service.approve(actor.userId, { expenseId }, actor.roles, actor.permissions);
  }

  @Post('expense/:expenseId/reject')
  rejectExpense(@Param('expenseId') expenseId: string, @Body() dto: RejectDto, @CurrentUser() actor: AuthUser) {
    return this.service.reject(actor.userId, { expenseId }, dto.reason, actor.roles, actor.permissions);
  }

  @Post('event/:eventId/approve')
  approveEvent(@Param('eventId') eventId: string, @CurrentUser() actor: AuthUser) {
    return this.service.approve(actor.userId, { eventId }, actor.roles);
  }

  @Post('event/:eventId/reject')
  rejectEvent(@Param('eventId') eventId: string, @Body() dto: RejectDto, @CurrentUser() actor: AuthUser) {
    return this.service.reject(actor.userId, { eventId }, dto.reason, actor.roles);
  }
}

// Approval-via-email: unauthenticated by design - the single-use, expiring
// token itself is the credential (mailed only to the resolved approver).
@Controller('public/approvals')
export class PublicApprovalsController {
  constructor(private readonly service: ApprovalsService) {}

  @Get(':token')
  getInfo(@Param('token') token: string) {
    return this.service.getTokenInfo(token);
  }

  // One-click Approve: opened directly from the email client, so it must be a
  // plain GET and must render a result page itself (no JSON, no frontend round-trip).
  @Get(':token/approve')
  async approve(@Param('token') token: string, @Res() res: Response) {
    try {
      await this.service.approveByToken(token);
      res.status(200).send(actionResultPage('Approved', 'Thank you - your approval has been recorded.', true));
    } catch (err) {
      res.status(400).send(actionResultPage('Could not approve', (err as Error).message, false));
    }
  }

  @Post(':token/reject')
  reject(@Param('token') token: string, @Body() dto: RejectDto) {
    return this.service.rejectByToken(token, dto.reason);
  }
}

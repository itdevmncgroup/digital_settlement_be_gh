import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { SettlementsService } from './settlements.service';
import {
  AddExpensesToSettlementDto,
  CreateSettlementDto,
  CreateSettlementFromSelectionDto,
  GenerateSettlementDto,
} from './dto/settlement.dto';
import { ApprovalsService } from '../approvals/approvals.service';
import { RejectDto } from '../approvals/dto/reject.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Create Settlement (BRD "Create Settlement" on the Expense page) - bundles a
// Department's bank-matched Expenses into one Settlement with a STL-YYMMDD#### id.
@Controller('settlements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE, RoleName.MANAGEMENT)
export class SettlementsController {
  constructor(
    private readonly service: SettlementsService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @RequirePermission('settlement.read.owndept', 'settlement.read.all')
  findAll(@CurrentUser() actor: AuthUser, @Query('departmentId') departmentId?: string) {
    return this.service.findAll(actor, departmentId);
  }

  @Get(':id')
  @RequirePermission('settlement.read.owndept', 'settlement.read.all')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermission('settlement.create.owndept')
  create(@Body() dto: CreateSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(actor.userId, actor.roles, dto.salesId);
  }

  // Settlement page's "Create Settlement" popup - preview-only (one Department
  // + one date range, no writes); the page's Submit step commits via
  // from-selection ("Buat baru") or :id/expenses ("Tambahkan", when a DRAFT
  // settlement already covers this Department).
  @Post('generate')
  @RequirePermission('settlement.create.owndept')
  generate(@Body() dto: GenerateSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.generate(dto.departmentId, dto.fromDate, dto.toDate, actor.userId, actor.roles);
  }

  // "Buat baru" - commits the checked subset from the generate-preview table
  // as a brand-new Settlement.
  @Post('from-selection')
  @RequirePermission('settlement.create.owndept')
  createFromSelection(@Body() dto: CreateSettlementFromSelectionDto, @CurrentUser() actor: AuthUser) {
    return this.service.createFromSelection(dto.departmentId, dto.expenseIds, actor.userId, actor.roles);
  }

  @Get(':id/eligible-expenses')
  @RequirePermission('settlement.create.owndept')
  eligibleExpenses(@Param('id') id: string) {
    return this.service.eligibleExpenses(id);
  }

  @Post(':id/expenses')
  @RequirePermission('settlement.create.owndept')
  addExpenses(@Param('id') id: string, @Body() dto: AddExpensesToSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.addExpenses(id, dto.expenseIds, actor.userId, actor.roles);
  }

  @Post(':id/complete')
  @Roles(RoleName.ADMIN, RoleName.FINANCE)
  complete(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.complete(id, actor.userId);
  }

  // The Settlement approval tier (SLS_MAR_DIR -> VP -> CO_CFO): its approver
  // signs off each member Expense, then submits to close the tier. Authorization
  // is the resolved approver of the current step (or ADMIN), checked in the
  // service - not role-based, same as the Expense approval endpoints.
  @Post(':id/expenses/:expenseId/approve')
  @Roles()
  approveExpense(@Param('id') id: string, @Param('expenseId') expenseId: string, @CurrentUser() actor: AuthUser) {
    return this.approvals.reviewSettlementExpense({ settlementId: id, expenseId, approve: true }, actor);
  }

  @Post(':id/expenses/:expenseId/reject')
  @Roles()
  rejectExpense(
    @Param('id') id: string,
    @Param('expenseId') expenseId: string,
    @Body() dto: RejectDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.approvals.reviewSettlementExpense({ settlementId: id, expenseId, approve: false, reason: dto.reason }, actor);
  }

  @Post(':id/submit')
  @Roles()
  submit(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.approvals.submitSettlementTier(id, actor);
  }
}

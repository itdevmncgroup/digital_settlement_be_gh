import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { DashboardService, PeriodFilter, SettlementPeriodFilter } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Personal landing-page dashboard - open to any authenticated user (no
// @Roles), unlike DashboardController below which is Management/Admin/Finance
// only. A separate controller class because NestJS's @Roles is inherited from
// the controller class as a whole; this keeps /dashboard/me un-gated without
// loosening the existing management endpoints.
@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class MyDashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('me')
  mine(@CurrentUser() actor: AuthUser) {
    return this.service.getMyDashboard(actor);
  }
}

// Management Dashboard (BRD section 5.5, 37) - Management/Admin/Finance always
// get in (unchanged), and dashboard.read.all/dashboard.read.owndept (Role/
// Permission master) now also admit any other role holding one of them (OR'd
// against @Roles by RolesGuard). Which one determines the Department scope
// each report is computed under - see DashboardService.resolveDepartmentScope().
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.MANAGEMENT, RoleName.ADMIN, RoleName.FINANCE)
@RequirePermission('dashboard.read.all', 'dashboard.read.owndept')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  summary(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.summary(actor, filter);
  }

  @Get('expense-by-unit')
  byUnit(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByUnit(actor, filter);
  }

  @Get('expense-by-sales')
  bySales(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseBySales(actor, filter);
  }

  @Get('expense-by-advertiser')
  byAdvertiser(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByAdvertiser(actor, filter);
  }

  @Get('expense-by-agency')
  byAgency(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByAgency(actor, filter);
  }

  @Get('expense-by-category')
  byCategory(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByCategory(actor, filter);
  }

  @Get('expense-by-brand')
  byBrand(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByBrand(actor, filter);
  }

  @Get('expense-by-department')
  byDepartment(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByDepartment(actor, filter);
  }

  @Get('expense-by-month')
  byMonth(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByMonth(actor, filter);
  }

  @Get('recent-transactions')
  recentTransactions(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter, @Query('limit') limit?: string) {
    return this.service.recentTransactions(actor, filter, limit ? Number(limit) : undefined);
  }

  @Get('settlement-summary')
  settlementSummary(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter) {
    return this.service.settlementSummary(actor, filter);
  }

  @Get('settlement-status')
  settlementStatus(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter) {
    return this.service.settlementStatusBreakdown(actor, filter);
  }

  @Get('settlement-trend')
  settlementTrend(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter) {
    return this.service.settlementTrend(actor, filter);
  }

  @Get('settlement-by-pod')
  settlementByPod(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter) {
    return this.service.settlementByPod(actor, filter);
  }

  @Get('settlement-top-submitters')
  settlementTopSubmitters(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter, @Query('limit') limit?: string) {
    return this.service.settlementTopSubmitters(actor, filter, limit ? Number(limit) : undefined);
  }

  @Get('settlement-approval-progress')
  settlementApprovalProgress(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter) {
    return this.service.settlementApprovalProgress(actor, filter);
  }

  @Get('settlement-processing-time-by-pod')
  settlementProcessingTimeByPod(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter) {
    return this.service.settlementProcessingTimeByPod(actor, filter);
  }

  @Get('settlement-transactions')
  recentSettlements(@CurrentUser() actor: AuthUser, @Query() filter: SettlementPeriodFilter, @Query('limit') limit?: string) {
    return this.service.recentSettlements(actor, filter, limit ? Number(limit) : undefined);
  }

  @Get('expense-settlement-summary')
  expenseSettlementSummary(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseSettlementSummary(actor, filter);
  }

  @Get('expense-vs-settlement-by-pod')
  expenseVsSettlementByPod(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseVsSettlementByPod(actor, filter);
  }

  @Get('expense-settlement-trend')
  expenseSettlementTrend(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseSettlementTrend(actor, filter);
  }

  @Get('expense-settlement-reconciliation')
  expenseSettlementReconciliation(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter, @Query('limit') limit?: string) {
    return this.service.expenseSettlementReconciliation(actor, filter, limit ? Number(limit) : undefined);
  }
}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { DashboardService, PeriodFilter } from './dashboard.service';
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
// get in (unchanged), and dashboard.read.all/dashboard.read.ownpod (Role/
// Permission master) now also admit any other role holding one of them (OR'd
// against @Roles by RolesGuard). Which one determines the POD scope each
// report is computed under - see DashboardService.resolvePodScope().
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.MANAGEMENT, RoleName.ADMIN, RoleName.FINANCE)
@RequirePermission('dashboard.read.all', 'dashboard.read.ownpod')
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

  @Get('expense-by-brand')
  byBrand(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByBrand(actor, filter);
  }

  @Get('expense-by-pod')
  byPod(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByPod(actor, filter);
  }

  @Get('expense-by-month')
  byMonth(@CurrentUser() actor: AuthUser, @Query() filter: PeriodFilter) {
    return this.service.expenseByMonth(actor, filter);
  }
}

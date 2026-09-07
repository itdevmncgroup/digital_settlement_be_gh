import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { DashboardService, PeriodFilter } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

// Management Dashboard (BRD section 5.5, 37)
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.MANAGEMENT, RoleName.ADMIN, RoleName.FINANCE)
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  summary(@Query() filter: PeriodFilter) {
    return this.service.summary(filter);
  }

  @Get('expense-by-unit')
  byUnit(@Query() filter: PeriodFilter) {
    return this.service.expenseByUnit(filter);
  }

  @Get('expense-by-sales')
  bySales(@Query() filter: PeriodFilter) {
    return this.service.expenseBySales(filter);
  }

  @Get('expense-by-advertiser')
  byAdvertiser(@Query() filter: PeriodFilter) {
    return this.service.expenseByAdvertiser(filter);
  }

  @Get('expense-by-brand')
  byBrand(@Query() filter: PeriodFilter) {
    return this.service.expenseByBrand(filter);
  }

  @Get('expense-by-pod')
  byPod(@Query() filter: PeriodFilter) {
    return this.service.expenseByPod(filter);
  }

  @Get('expense-by-month')
  byMonth(@Query() filter: PeriodFilter) {
    return this.service.expenseByMonth(filter);
  }
}

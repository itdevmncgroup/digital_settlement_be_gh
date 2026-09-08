import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { SettlementsService } from './settlements.service';
import {
  AddExpensesToSettlementDto,
  CreateSettlementDto,
  CreateSettlementFromSelectionDto,
  GenerateSettlementDto,
} from './dto/settlement.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Create Settlement (BRD "Create Settlement" on the Expense page) - bundles a
// POD's bank-matched Expenses into one Settlement with a STL-YYMMDD#### id.
@Controller('settlements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE, RoleName.MANAGEMENT)
export class SettlementsController {
  constructor(private readonly service: SettlementsService) {}

  @Get()
  @RequirePermission('settlement.read.ownpod', 'settlement.read.all')
  findAll(@CurrentUser() actor: AuthUser, @Query('podId') podId?: string) {
    return this.service.findAll(actor, podId);
  }

  @Get(':id')
  @RequirePermission('settlement.read.ownpod', 'settlement.read.all')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermission('settlement.create.ownpod')
  create(@Body() dto: CreateSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(actor.userId, actor.roles, dto.salesId);
  }

  // Settlement page's "Create Settlement" popup - preview-only (one POD + one
  // date range, no writes); the page's Submit step commits via from-selection
  // ("Buat baru") or :id/expenses ("Tambahkan", when a DRAFT settlement already
  // covers this POD).
  @Post('generate')
  @RequirePermission('settlement.create.ownpod')
  generate(@Body() dto: GenerateSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.generate(dto.podId, dto.fromDate, dto.toDate, actor.userId, actor.roles);
  }

  // "Buat baru" - commits the checked subset from the generate-preview table
  // as a brand-new Settlement.
  @Post('from-selection')
  @RequirePermission('settlement.create.ownpod')
  createFromSelection(@Body() dto: CreateSettlementFromSelectionDto, @CurrentUser() actor: AuthUser) {
    return this.service.createFromSelection(dto.podId, dto.expenseIds, actor.userId, actor.roles);
  }

  @Get(':id/eligible-expenses')
  @RequirePermission('settlement.create.ownpod')
  eligibleExpenses(@Param('id') id: string) {
    return this.service.eligibleExpenses(id);
  }

  @Post(':id/expenses')
  @RequirePermission('settlement.create.ownpod')
  addExpenses(@Param('id') id: string, @Body() dto: AddExpensesToSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.addExpenses(id, dto.expenseIds, actor.userId, actor.roles);
  }

  @Post(':id/complete')
  @Roles(RoleName.ADMIN, RoleName.FINANCE)
  complete(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.complete(id, actor.userId);
  }
}

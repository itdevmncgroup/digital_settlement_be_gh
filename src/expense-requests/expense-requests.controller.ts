import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { ExpenseRequestsService } from './expense-requests.service';
import { CreateExpenseRequestDto, SetExpenseRequestBudgetDto, UpdateExpenseRequestDto, VerifyExpenseRequestDto } from './dto/expense-request.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Expense Request (Karangan Bunga): Sales Admin enters -> Head Dept -> Co-CSO
// (approve/reject on POST /approvals/expense-request/:id/approve|reject) ->
// Sales Customer Service budget -> Corsec verification. The budget/verify
// stages are gated by Position (SLS_CS / CORSEC) in the service, not by role.
@Controller('expense-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExpenseRequestsController {
  constructor(private readonly service: ExpenseRequestsService) {}

  @Get()
  findAll(@CurrentUser() actor: AuthUser, @Query('search') search?: string) {
    return this.service.findAll(actor, search);
  }

  // Candidates for the New Request form's "on behalf of" picker (see ExpenseRequestsService.listRequestors).
  @Get('requestors')
  listRequestors(@CurrentUser() actor: AuthUser) {
    return this.service.listRequestors(actor);
  }

  // webmobile.request.expense.create.own / .owndept let the Web Mobile New Request page through the
  // route gate; entering for another user additionally needs .owndept (checked in the service).
  @Post()
  @Roles(RoleName.SALES_ADMIN, RoleName.ADMIN)
  @RequirePermission('request.expense.create.owndept', 'webmobile.request.expense.create.own', 'webmobile.request.expense.create.owndept')
  create(@Body() dto: CreateExpenseRequestDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  // request.expense.edit.owndept: edit only Expense Requests the caller entered
  // (service enforces requester / inputter ownership in findEditableDraft).
  @Patch(':id')
  @Roles(RoleName.SALES_ADMIN, RoleName.ADMIN)
  @RequirePermission(
    'request.expense.create.owndept',
    'request.expense.edit.owndept',
    'webmobile.request.expense.create.own',
    'webmobile.request.expense.create.owndept',
  )
  update(@Param('id') id: string, @Body() dto: UpdateExpenseRequestDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor);
  }

  @Post(':id/submit')
  @Roles(RoleName.SALES_ADMIN, RoleName.ADMIN)
  @RequirePermission('request.expense.create.owndept', 'webmobile.request.expense.create.own', 'webmobile.request.expense.create.owndept')
  submit(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.submit(id, actor);
  }

  @Post(':id/budget')
  setBudget(@Param('id') id: string, @Body() dto: SetExpenseRequestBudgetDto, @CurrentUser() actor: AuthUser) {
    return this.service.setBudget(id, dto, actor);
  }

  @Post(':id/verify')
  verify(@Param('id') id: string, @Body() dto: VerifyExpenseRequestDto, @CurrentUser() actor: AuthUser) {
    return this.service.verify(id, dto, actor);
  }
}

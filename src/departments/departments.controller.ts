import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { DepartmentsService } from './departments.service';
import { AddDepartmentApproverDto, AddDepartmentAssignmentDto, CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Department - org department AND/OR Sales <-> Agency <-> Brand coverage
// group (BRD section 6.2, formerly the separate "Pod" concept).
@Controller('departments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get('me')
  findMine(@CurrentUser() actor: AuthUser) {
    return this.departmentsService.findMine(actor.userId);
  }

  @Get()
  findAll(@Query('salesId') salesId?: string, @Query('search') search?: string, @Query('active') active?: string) {
    return this.departmentsService.findAll({ salesId, search, activeOnly: active === 'true' });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.departmentsService.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreateDepartmentDto, @CurrentUser() actor: AuthUser) {
    return this.departmentsService.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateDepartmentDto, @CurrentUser() actor: AuthUser) {
    return this.departmentsService.update(id, dto, actor.userId);
  }

  @Post(':id/assignments')
  @Roles(RoleName.ADMIN)
  addAssignment(@Param('id') id: string, @Body() dto: AddDepartmentAssignmentDto, @CurrentUser() actor: AuthUser) {
    return this.departmentsService.addAssignment(id, dto, actor.userId);
  }

  @Delete(':id/assignments/:assignmentId')
  @Roles(RoleName.ADMIN)
  removeAssignment(@Param('id') id: string, @Param('assignmentId') assignmentId: string, @CurrentUser() actor: AuthUser) {
    return this.departmentsService.removeAssignment(id, assignmentId, actor.userId);
  }

  @Post(':id/approvers')
  @Roles(RoleName.ADMIN)
  addApprover(@Param('id') id: string, @Body() dto: AddDepartmentApproverDto, @CurrentUser() actor: AuthUser) {
    return this.departmentsService.addApprover(id, dto, actor.userId);
  }

  @Delete(':id/approvers/:approverId')
  @Roles(RoleName.ADMIN)
  removeApprover(@Param('id') id: string, @Param('approverId') approverId: string, @CurrentUser() actor: AuthUser) {
    return this.departmentsService.removeApprover(id, approverId, actor.userId);
  }
}

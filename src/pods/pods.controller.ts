import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { PodsService } from './pods.service';
import { AddPodApproverDto, AddPodAssignmentDto, AddPodMemberDto, CreatePodDto, UpdatePodDto } from './dto/pod.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// POD - Sales <-> Agency <-> Brand coverage (BRD section 6.2)
@Controller('pods')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PodsController {
  constructor(private readonly service: PodsService) {}

  @Get('me')
  findMine(@CurrentUser() actor: AuthUser) {
    return this.service.findAll({ salesId: actor.userId });
  }

  @Get()
  @Roles(RoleName.ADMIN, RoleName.FINANCE, RoleName.SUPERVISOR, RoleName.MANAGEMENT)
  findAll(@Query('salesId') salesId?: string, @Query('search') search?: string) {
    return this.service.findAll({ salesId, search });
  }

  @Get(':id')
  @Roles(RoleName.ADMIN, RoleName.FINANCE, RoleName.SUPERVISOR, RoleName.MANAGEMENT)
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreatePodDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdatePodDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId);
  }

  @Post(':id/assignments')
  @Roles(RoleName.ADMIN)
  addAssignment(@Param('id') id: string, @Body() dto: AddPodAssignmentDto, @CurrentUser() actor: AuthUser) {
    return this.service.addAssignment(id, dto, actor.userId);
  }

  @Delete(':id/assignments/:assignmentId')
  @Roles(RoleName.ADMIN)
  removeAssignment(@Param('id') id: string, @Param('assignmentId') assignmentId: string, @CurrentUser() actor: AuthUser) {
    return this.service.removeAssignment(id, assignmentId, actor.userId);
  }

  @Post(':id/approvers')
  @Roles(RoleName.ADMIN)
  addApprover(@Param('id') id: string, @Body() dto: AddPodApproverDto, @CurrentUser() actor: AuthUser) {
    return this.service.addApprover(id, dto, actor.userId);
  }

  @Delete(':id/approvers/:approverId')
  @Roles(RoleName.ADMIN)
  removeApprover(@Param('id') id: string, @Param('approverId') approverId: string, @CurrentUser() actor: AuthUser) {
    return this.service.removeApprover(id, approverId, actor.userId);
  }

  @Post(':id/members')
  @Roles(RoleName.ADMIN)
  addMember(@Param('id') id: string, @Body() dto: AddPodMemberDto, @CurrentUser() actor: AuthUser) {
    return this.service.addMember(id, dto, actor.userId);
  }

  @Delete(':id/members/:memberId')
  @Roles(RoleName.ADMIN)
  removeMember(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() actor: AuthUser) {
    return this.service.removeMember(id, memberId, actor.userId);
  }
}

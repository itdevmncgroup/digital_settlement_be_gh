import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { RoleName } from '../common/constants/role-name';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { AuditReportService, AuditReportFilter } from './audit-report.service';
import { UpdateAuditFindingStatusDto } from './dto/update-finding-status.dto';

@Controller('audit-report')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.MANAGEMENT, RoleName.ADMIN, RoleName.FINANCE)
@RequirePermission('audit-report.read.all', 'audit-report.read.owndept')
export class AuditReportController {
  constructor(private readonly service: AuditReportService) {}

  @Get('summary')
  summary(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.summary(actor, filter);
  }

  @Get('findings-by-type')
  findingsByType(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.findingsByType(actor, filter);
  }

  @Get('risk-breakdown')
  riskBreakdown(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.riskBreakdown(actor, filter);
  }

  @Get('trend')
  trend(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.trend(actor, filter);
  }

  @Get('compliance-by-pod')
  complianceByPod(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.complianceByPod(actor, filter);
  }

  @Get('high-risk-exposure-by-pod')
  highRiskExposureByPod(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.highRiskExposureByPod(actor, filter);
  }

  @Get('document-completeness')
  documentCompleteness(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.documentCompleteness(actor, filter);
  }

  @Get('settlement-aging')
  settlementAging(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.settlementAging(actor, filter);
  }

  @Get('director-attention')
  directorAttention(@CurrentUser() actor: AuthUser, @Query() filter: AuditReportFilter) {
    return this.service.directorAttention(actor, filter);
  }

  @Get('findings')
  findings(
    @CurrentUser() actor: AuthUser,
    @Query() filter: AuditReportFilter,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.findings(actor, filter, page ? Number(page) : undefined, pageSize ? Number(pageSize) : undefined);
  }

  @Patch('findings/:id')
  updateFinding(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateAuditFindingStatusDto) {
    return this.service.updateFindingStatus(actor, id, dto);
  }
}

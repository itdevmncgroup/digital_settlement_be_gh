import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

// Audit Trail read (BRD section 24, 26 -> System > Audit Log)
@Controller('audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN, RoleName.FINANCE)
export class AuditLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  findAll(
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('userId') userId?: string,
    @Query('take') take = '50',
    @Query('skip') skip = '0',
  ) {
    return this.prisma.auditLog.findMany({
      where: { objectType, objectId, userId },
      include: { user: { select: { id: true, name: true, employeeId: true } } },
      orderBy: { timestamp: 'desc' },
      take: Math.min(Number(take) || 50, 200),
      skip: Number(skip) || 0,
    });
  }
}

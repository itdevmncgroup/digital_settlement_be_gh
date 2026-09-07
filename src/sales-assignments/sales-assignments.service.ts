import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateSalesAssignmentDto } from './dto/sales-assignment.dto';

const include = { sales: { select: { id: true, name: true, employeeId: true } }, unit: true } as const;

@Injectable()
export class SalesAssignmentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(salesId?: string) {
    return this.prisma.salesAssignment.findMany({
      where: salesId ? { salesId } : undefined,
      include,
      orderBy: { effectiveDate: 'desc' },
    });
  }

  // BR-002: Unit ditentukan berdasarkan profile/assignment Sales - creating a new
  // open-ended assignment updates the Sales' current unit on the User profile.
  async create(dto: CreateSalesAssignmentDto, actorId: string) {
    const sales = await this.prisma.user.findUnique({ where: { id: dto.salesId } });
    if (!sales) throw new NotFoundException('Sales not found');

    const [assignment] = await this.prisma.$transaction([
      this.prisma.salesAssignment.create({
        data: {
          salesId: dto.salesId,
          unitId: dto.unitId,
          effectiveDate: new Date(dto.effectiveDate),
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        },
        include,
      }),
      ...(!dto.endDate ? [this.prisma.user.update({ where: { id: dto.salesId }, data: { unitId: dto.unitId } })] : []),
    ]);

    await this.audit.log({
      userId: actorId,
      action: 'CREATE',
      objectType: 'SalesAssignment',
      objectId: assignment.id,
      newValue: assignment,
    });
    return assignment;
  }
}

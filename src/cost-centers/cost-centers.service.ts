import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateCostCenterDto, UpdateCostCenterDto } from './dto/cost-center.dto';

@Injectable()
export class CostCentersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(activeOnly?: boolean) {
    return this.prisma.costCenter.findMany({ where: activeOnly ? { isActive: true } : undefined, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const item = await this.prisma.costCenter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Cost center not found');
    return item;
  }

  async create(dto: CreateCostCenterDto, actorId: string) {
    const item = await this.prisma.costCenter.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'CostCenter', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateCostCenterDto, actorId: string) {
    const before = await this.findOne(id);
    const item = await this.prisma.costCenter.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'CostCenter', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

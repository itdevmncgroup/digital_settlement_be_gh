import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto';

@Injectable()
export class UnitsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(activeOnly?: boolean) {
    return this.prisma.unit.findMany({ where: activeOnly ? { isActive: true } : undefined, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  async create(dto: CreateUnitDto, actorId: string) {
    const unit = await this.prisma.unit.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Unit', objectId: unit.id, newValue: unit });
    return unit;
  }

  async update(id: string, dto: UpdateUnitDto, actorId: string) {
    const before = await this.findOne(id);
    const unit = await this.prisma.unit.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Unit', objectId: id, oldValue: before, newValue: unit });
    return unit;
  }
}

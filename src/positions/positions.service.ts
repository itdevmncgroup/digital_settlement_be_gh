import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreatePositionDto, UpdatePositionDto } from './dto/position.dto';

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(activeOnly?: boolean) {
    return this.prisma.position.findMany({ where: activeOnly ? { isActive: true } : undefined, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const position = await this.prisma.position.findUnique({ where: { id } });
    if (!position) throw new NotFoundException('Position not found');
    return position;
  }

  async create(dto: CreatePositionDto, actorId: string) {
    const position = await this.prisma.position.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Position', objectId: position.id, newValue: position });
    return position;
  }

  async update(id: string, dto: UpdatePositionDto, actorId: string) {
    const before = await this.findOne(id);
    const position = await this.prisma.position.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Position', objectId: id, oldValue: before, newValue: position });
    return position;
  }
}

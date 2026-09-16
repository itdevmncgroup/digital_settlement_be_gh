import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateActivityTypeDto, UpdateActivityTypeDto } from './dto/activity-type.dto';

@Injectable()
export class ActivityTypesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(activeOnly?: boolean) {
    return this.prisma.activityType.findMany({ where: activeOnly ? { isActive: true } : undefined, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const item = await this.prisma.activityType.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Activity type not found');
    return item;
  }

  async create(dto: CreateActivityTypeDto, actorId: string) {
    const item = await this.prisma.activityType.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'ActivityType', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateActivityTypeDto, actorId: string) {
    const before = await this.findOne(id);
    const item = await this.prisma.activityType.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'ActivityType', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { codeNameWhere } from '../common/search.util';
import { CreateAgencyDto, UpdateAgencyDto } from './dto/agency.dto';

// Agency is a distinct master data entity above Advertiser (Agency -> Advertiser -> Brand,
// each Brand owned by exactly one Advertiser, each Advertiser by exactly one Agency).
@Injectable()
export class AgenciesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(search?: string, activeOnly?: boolean) {
    return this.prisma.agency.findMany({
      where: { ...codeNameWhere(search), isActive: activeOnly ? true : undefined },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.agency.findUnique({
      where: { id },
      include: { advertisers: true },
    });
    if (!item) throw new NotFoundException('Agency not found');
    return item;
  }

  async create(dto: CreateAgencyDto, actorId: string) {
    const item = await this.prisma.agency.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Agency', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateAgencyDto, actorId: string) {
    const before = await this.prisma.agency.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Agency not found');
    const item = await this.prisma.agency.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Agency', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

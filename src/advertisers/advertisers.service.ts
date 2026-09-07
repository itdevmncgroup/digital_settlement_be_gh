import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { codeNameWhere } from '../common/search.util';
import { CreateAdvertiserDto, UpdateAdvertiserDto } from './dto/advertiser.dto';

// Advertiser sits between Agency and Brand (Agency -> Advertiser -> Brand). An
// Advertiser belongs to exactly one Agency; its Brands are managed from the
// Brands module (Brand.advertiserId), not here - ownership is 1:N, not a link table.
@Injectable()
export class AdvertisersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(filter: { search?: string; agencyId?: string } = {}) {
    return this.prisma.advertiser.findMany({
      where: { ...codeNameWhere(filter.search), agencyId: filter.agencyId },
      include: { agency: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.advertiser.findUnique({
      where: { id },
      include: { agency: true, brands: true },
    });
    if (!item) throw new NotFoundException('Advertiser not found');
    return item;
  }

  async create(dto: CreateAdvertiserDto, actorId: string) {
    const agency = await this.prisma.agency.findUnique({ where: { id: dto.agencyId } });
    if (!agency) throw new NotFoundException('Agency not found');

    const item = await this.prisma.advertiser.create({ data: dto, include: { agency: true } });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Advertiser', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateAdvertiserDto, actorId: string) {
    const before = await this.prisma.advertiser.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Advertiser not found');

    if (dto.agencyId) {
      const agency = await this.prisma.agency.findUnique({ where: { id: dto.agencyId } });
      if (!agency) throw new NotFoundException('Agency not found');
    }

    const item = await this.prisma.advertiser.update({ where: { id }, data: dto, include: { agency: true } });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Advertiser', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

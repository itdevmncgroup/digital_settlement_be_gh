import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { codeNameWhere } from '../common/search.util';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';

const MAX_BROWSE_RESULTS = 200;

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // advertiserIds narrows to Brands owned by any of those Advertisers (used by the
  // Department picker's Agency -> Advertiser -> Brand cascade). Results are capped since
  // Brand can run into the thousands - search/advertiserIds narrows it down.
  findAll(filter: { search?: string; advertiserIds?: string[] } = {}) {
    return this.prisma.brand.findMany({
      where: {
        ...codeNameWhere(filter.search),
        advertiserId: filter.advertiserIds?.length ? { in: filter.advertiserIds } : undefined,
      },
      include: { advertiser: { include: { agency: true } } },
      orderBy: { name: 'asc' },
      take: MAX_BROWSE_RESULTS,
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.brand.findUnique({
      where: { id },
      include: { advertiser: { include: { agency: true } } },
    });
    if (!item) throw new NotFoundException('Brand not found');
    return item;
  }

  async create(dto: CreateBrandDto, actorId: string) {
    const advertiser = await this.prisma.advertiser.findUnique({ where: { id: dto.advertiserId } });
    if (!advertiser) throw new NotFoundException('Advertiser not found');

    const item = await this.prisma.brand.create({ data: dto, include: { advertiser: { include: { agency: true } } } });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Brand', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateBrandDto, actorId: string) {
    const before = await this.prisma.brand.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Brand not found');

    if (dto.advertiserId) {
      const advertiser = await this.prisma.advertiser.findUnique({ where: { id: dto.advertiserId } });
      if (!advertiser) throw new NotFoundException('Advertiser not found');
    }

    const item = await this.prisma.brand.update({ where: { id }, data: dto, include: { advertiser: { include: { agency: true } } } });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Brand', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

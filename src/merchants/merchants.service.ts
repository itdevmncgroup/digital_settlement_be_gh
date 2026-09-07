import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { normalizeName } from '../common/matching/normalize';
import { CreateMerchantDto, UpdateMerchantDto } from './dto/merchant.dto';

@Injectable()
export class MerchantsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(search?: string) {
    return this.prisma.merchant.findMany({
      where: search ? { normalizedName: { contains: normalizeName(search) } } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.merchant.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Merchant not found');
    return item;
  }

  async create(dto: CreateMerchantDto, actorId: string) {
    const item = await this.prisma.merchant.create({
      data: { name: dto.name, normalizedName: normalizeName(dto.name), alias: dto.alias ?? [], isActive: dto.isActive },
    });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Merchant', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateMerchantDto, actorId: string) {
    const before = await this.findOne(id);
    const item = await this.prisma.merchant.update({
      where: { id },
      data: {
        name: dto.name,
        normalizedName: dto.name ? normalizeName(dto.name) : undefined,
        alias: dto.alias,
        isActive: dto.isActive,
      },
    });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Merchant', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

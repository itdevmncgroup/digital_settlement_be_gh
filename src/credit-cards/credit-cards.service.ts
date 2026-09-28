import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateCreditCardDto, UpdateCreditCardDto } from './dto/credit-card.dto';

const include = {
  department: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, positionId: true, position: { select: { id: true, name: true } } } },
} as const;

@Injectable()
export class CreditCardsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(departmentId?: string, positionId?: string, activeOnly?: boolean) {
    return this.prisma.creditCard.findMany({
      where: { departmentId, isActive: activeOnly ? true : undefined, user: positionId ? { positionId } : undefined },
      include,
      orderBy: { bank: 'asc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.creditCard.findUnique({ where: { id }, include });
    if (!item) throw new NotFoundException('Credit card not found');
    return item;
  }

  async create(dto: CreateCreditCardDto, actorId: string) {
    const item = await this.prisma.creditCard.create({ data: dto, include });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'CreditCard', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateCreditCardDto, actorId: string) {
    const before = await this.findOne(id);
    const item = await this.prisma.creditCard.update({ where: { id }, data: dto, include });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'CreditCard', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

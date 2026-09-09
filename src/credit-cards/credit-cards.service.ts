import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateCreditCardDto, UpdateCreditCardDto } from './dto/credit-card.dto';

const include = { department: { select: { id: true, name: true } } } as const;

@Injectable()
export class CreditCardsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(departmentId?: string) {
    return this.prisma.creditCard.findMany({ where: { departmentId }, include, orderBy: { bank: 'asc' } });
  }

  async findOne(id: string) {
    const item = await this.prisma.creditCard.findUnique({ where: { id }, include });
    if (!item) throw new NotFoundException('Credit card not found');
    return item;
  }

  async create(dto: CreateCreditCardDto, actorId: string) {
    if (dto.departmentId) await this.assertDepartmentFree(dto.departmentId);
    const item = await this.prisma.creditCard.create({ data: dto, include });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'CreditCard', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateCreditCardDto, actorId: string) {
    const before = await this.findOne(id);
    if (dto.departmentId && dto.departmentId !== before.departmentId) await this.assertDepartmentFree(dto.departmentId);
    const item = await this.prisma.creditCard.update({ where: { id }, data: dto, include });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'CreditCard', objectId: id, oldValue: before, newValue: item });
    return item;
  }

  // 1 Department = 1 credit card - reject assigning a Department that already
  // has a different card.
  private async assertDepartmentFree(departmentId: string) {
    const existing = await this.prisma.creditCard.findUnique({ where: { departmentId } });
    if (existing) throw new BadRequestException('This Department already has a credit card assigned - unassign it first.');
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreatePaymentMethodDto, UpdatePaymentMethodDto } from './dto/payment-method.dto';

@Injectable()
export class PaymentMethodsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(activeOnly?: boolean) {
    return this.prisma.paymentMethod.findMany({ where: activeOnly ? { isActive: true } : undefined, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const item = await this.prisma.paymentMethod.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Payment method not found');
    return item;
  }

  async create(dto: CreatePaymentMethodDto, actorId: string) {
    const item = await this.prisma.paymentMethod.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'PaymentMethod', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdatePaymentMethodDto, actorId: string) {
    const before = await this.findOne(id);
    const item = await this.prisma.paymentMethod.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'PaymentMethod', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

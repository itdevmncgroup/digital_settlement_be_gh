import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateExpenseCategoryDto, UpdateExpenseCategoryDto } from './dto/expense-category.dto';

@Injectable()
export class ExpenseCategoriesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll() {
    return this.prisma.expenseCategory.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const item = await this.prisma.expenseCategory.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Expense category not found');
    return item;
  }

  async create(dto: CreateExpenseCategoryDto, actorId: string) {
    const item = await this.prisma.expenseCategory.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'ExpenseCategory', objectId: item.id, newValue: item });
    return item;
  }

  async update(id: string, dto: UpdateExpenseCategoryDto, actorId: string) {
    const before = await this.findOne(id);
    const item = await this.prisma.expenseCategory.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'ExpenseCategory', objectId: id, oldValue: before, newValue: item });
    return item;
  }
}

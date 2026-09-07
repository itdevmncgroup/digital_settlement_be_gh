import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll() {
    return this.prisma.department.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const department = await this.prisma.department.findUnique({ where: { id } });
    if (!department) throw new NotFoundException('Department not found');
    return department;
  }

  async create(dto: CreateDepartmentDto, actorId: string) {
    const department = await this.prisma.department.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Department', objectId: department.id, newValue: department });
    return department;
  }

  async update(id: string, dto: UpdateDepartmentDto, actorId: string) {
    const before = await this.findOne(id);
    const department = await this.prisma.department.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Department', objectId: id, oldValue: before, newValue: department });
    return department;
  }
}

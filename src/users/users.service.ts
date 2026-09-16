import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const userInclude = {
  roles: { include: { role: true } },
  unit: true,
  position: true,
  departments: { where: { status: 'ACTIVE' }, include: { department: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async findAll() {
    const users = await this.prisma.user.findMany({ include: userInclude, orderBy: { createdAt: 'desc' } });
    return users.map(this.toPublic);
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: userInclude });
    if (!user) throw new NotFoundException('User not found');
    return this.toPublic(user);
  }

  async create(dto: CreateUserDto, actorId: string) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { employeeId: dto.employeeId }] },
    });
    if (existing) throw new ConflictException('Email or Employee ID already in use');

    const roles = await this.prisma.role.findMany({ where: { name: { in: dto.roles } } });
    if (roles.length !== dto.roles.length) {
      throw new NotFoundException('One or more roles not found - run role seed first');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        employeeId: dto.employeeId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        positionId: dto.positionId,
        unitId: dto.unitId,
        passwordHash,
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
        departments: { create: (dto.departmentIds ?? []).map((departmentId) => ({ departmentId })) },
      },
      include: userInclude,
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'User', objectId: user.id, newValue: this.toPublic(user) });
    return this.toPublic(user);
  }

  async update(id: string, dto: UpdateUserDto, actorId: string) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('User not found');

    const { departmentIds, ...rest } = dto;
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...rest,
        departments: departmentIds
          ? { deleteMany: {}, create: departmentIds.map((departmentId) => ({ departmentId })) }
          : undefined,
      },
      include: userInclude,
    });

    await this.audit.log({
      userId: actorId,
      action: 'UPDATE',
      objectType: 'User',
      objectId: id,
      oldValue: before,
      newValue: this.toPublic(user),
    });
    return this.toPublic(user);
  }

  async assignRoles(id: string, roleNames: string[], actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: userInclude });
    if (!user) throw new NotFoundException('User not found');

    const roles = await this.prisma.role.findMany({ where: { name: { in: roleNames } } });
    if (roles.length !== roleNames.length) {
      throw new NotFoundException('One or more roles not found');
    }

    const before = user.roles.map((r) => r.role.name);

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: id } }),
      this.prisma.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) }),
    ]);

    await this.audit.log({
      userId: actorId,
      action: 'UPDATE',
      objectType: 'UserRole',
      objectId: id,
      oldValue: before,
      newValue: roleNames,
    });

    return this.findOne(id);
  }

  private toPublic(user: any) {
    const { passwordHash, departments, ...rest } = user;
    return {
      ...rest,
      roles: user.roles?.map((ur: any) => ur.role.name) ?? [],
      departments: departments?.map((d: any) => d.department) ?? [],
    };
  }
}

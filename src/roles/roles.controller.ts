import { Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { CreatePermissionDto, UpdatePermissionDto } from './dto/permission.dto';

const roleInclude = { permissions: { include: { permission: true } } } as const;

// System Administrator: manage role/permission (BRD section 5.4, 26 -> System > Role/Permission)
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN)
export class RolesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('roles')
  findRoles() {
    return this.prisma.role.findMany({ include: roleInclude, orderBy: { name: 'asc' } });
  }

  @Post('roles')
  async createRole(@Body() dto: CreateRoleDto, @CurrentUser() actor: AuthUser) {
    const existing = await this.prisma.role.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException(`Role "${dto.name}" already exists`);

    const role = await this.prisma.role.create({ data: { name: dto.name, description: dto.description }, include: roleInclude });
    await this.audit.log({ userId: actor.userId, action: 'CREATE', objectType: 'Role', objectId: role.id, newValue: role });
    return role;
  }

  @Patch('roles/:id')
  async updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() actor: AuthUser) {
    const before = await this.prisma.role.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Role not found');

    if (dto.name && dto.name !== before.name) {
      const existing = await this.prisma.role.findUnique({ where: { name: dto.name } });
      if (existing) throw new ConflictException(`Role "${dto.name}" already exists`);
    }

    const role = await this.prisma.role.update({
      where: { id },
      data: { name: dto.name, description: dto.description, isActive: dto.isActive },
      include: roleInclude,
    });
    await this.audit.log({ userId: actor.userId, action: 'UPDATE', objectType: 'Role', objectId: id, oldValue: before, newValue: role });
    return role;
  }

  @Get('permissions')
  findPermissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  @Post('permissions')
  async createPermission(@Body() dto: CreatePermissionDto, @CurrentUser() actor: AuthUser) {
    const existing = await this.prisma.permission.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Permission "${dto.code}" already exists`);

    const permission = await this.prisma.permission.create({ data: { code: dto.code, description: dto.description } });
    await this.audit.log({ userId: actor.userId, action: 'CREATE', objectType: 'Permission', objectId: permission.id, newValue: permission });
    return permission;
  }

  @Patch('permissions/:id')
  async updatePermission(@Param('id') id: string, @Body() dto: UpdatePermissionDto, @CurrentUser() actor: AuthUser) {
    const before = await this.prisma.permission.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Permission not found');

    if (dto.code && dto.code !== before.code) {
      const existing = await this.prisma.permission.findUnique({ where: { code: dto.code } });
      if (existing) throw new ConflictException(`Permission "${dto.code}" already exists`);
    }

    const permission = await this.prisma.permission.update({
      where: { id },
      data: { code: dto.code, description: dto.description, isActive: dto.isActive },
    });
    await this.audit.log({ userId: actor.userId, action: 'UPDATE', objectType: 'Permission', objectId: id, oldValue: before, newValue: permission });
    return permission;
  }

  @Post('roles/:id/permissions')
  async setPermissions(@Param('id') id: string, @Body('permissionCodes') permissionCodes: string[]) {
    const permissions = await this.prisma.permission.findMany({ where: { code: { in: permissionCodes } } });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      this.prisma.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId: id, permissionId: p.id })),
      }),
    ]);
    return this.prisma.role.findUnique({ where: { id }, include: roleInclude });
  }
}

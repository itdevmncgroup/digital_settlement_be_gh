import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, meta: { ipAddress?: string | null; device?: string | null }) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: { include: { role: true } } },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const roles = user.roles.map((ur) => ur.role.name);
    const permissions = await this.getPermissionsForRoles(roles);
    const tokens = this.issueTokens(user.id, user.email, roles, permissions);

    await this.audit.log({
      userId: user.id,
      action: 'LOGIN',
      objectType: 'User',
      objectId: user.id,
      ipAddress: meta.ipAddress,
      device: meta.device,
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        employeeId: user.employeeId,
        name: user.name,
        email: user.email,
        unitId: user.unitId,
        roles,
        permissions,
      },
    };
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; email: string; roles: string[] };
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { roles: { include: { role: true } } },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const roles = user.roles.map((ur) => ur.role.name);
    const permissions = await this.getPermissionsForRoles(roles);
    return this.issueTokens(user.id, user.email, roles, permissions);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } }, unit: true, position: true, department: true },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    const roles = user.roles.map((ur) => ur.role.name);
    return {
      id: user.id,
      employeeId: user.employeeId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      position: user.position,
      department: user.department,
      unit: user.unit,
      status: user.status,
      roles,
      permissions: await this.getPermissionsForRoles(roles),
    };
  }

  /** Flattens the Permission codes granted by any of these Role names (Role/Permission master - see RolesGuard). */
  private async getPermissionsForRoles(roleNames: string[]): Promise<string[]> {
    if (roleNames.length === 0) return [];
    const roles = await this.prisma.role.findMany({
      where: { name: { in: roleNames }, isActive: true },
      include: { permissions: { include: { permission: true } } },
    });
    const codes = roles.flatMap((role) =>
      role.permissions.filter((rp) => rp.permission.isActive).map((rp) => rp.permission.code),
    );
    return Array.from(new Set(codes));
  }

  private issueTokens(userId: string, email: string, roles: string[], permissions: string[]) {
    const payload = { sub: userId, email, roles, permissions };
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m',
    });
    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d',
    });
    return { accessToken, refreshToken };
  }
}

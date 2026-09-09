import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import {
  AddDepartmentApproverDto,
  AddDepartmentAssignmentDto,
  CreateDepartmentDto,
  DepartmentAssignmentInputDto,
  UpdateDepartmentDto,
} from './dto/department.dto';

const departmentInclude = {
  assignments: { include: { agency: true, brand: { include: { advertiser: true } } } },
  approvers: { include: { position: true, user: { select: { id: true, name: true, employeeId: true } } } },
} as const;

// Department = an org department AND/OR a named Sales coverage group (BRD
// section 6.2, formerly the separate "Pod" concept). Coverage (which Agency
// <-> Brand pairs it covers) is DepartmentAssignment - a Brand may appear at
// most once per Department, but one Agency can cover many Brands. Membership
// (which Sales belongs to a Department) is simply User.departmentId, not a
// join table here.
@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // filter.salesId: that Sales' own Department (0 or 1, via User.departmentId),
  // returned as an array for parity with other list endpoints.
  async findAll(filter: { salesId?: string; search?: string } = {}) {
    if (filter.salesId) {
      const user = await this.prisma.user.findUnique({
        where: { id: filter.salesId },
        select: { department: { include: departmentInclude } },
      });
      return user?.department ? [user.department] : [];
    }
    return this.prisma.department.findMany({
      where: {
        name: filter.search ? { contains: filter.search, mode: 'insensitive' } : undefined,
      },
      include: departmentInclude,
      orderBy: { name: 'asc' },
    });
  }

  // GET /departments/me - every Department the caller may act as belonging to:
  // their own membership (User.departmentId) plus any Department they hold an
  // active approval Position for (DepartmentPositionAssignment - e.g. HEAD_POD,
  // whose "own" Department is never User.departmentId). Broader than
  // findAll({salesId}) above, which only reads User.departmentId and is meant
  // for looking up an arbitrary OTHER Sales' single Department, not the
  // caller's own scope - this is what feeds the New Expense Department picker
  // for an expense.create.owndept caller (see ExpensesService.
  // assertCanCreateForDepartment/getManagedDepartmentIds, same two sources).
  async findMine(actorId: string) {
    const [user, assignments] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: actorId }, select: { department: { include: departmentInclude } } }),
      this.prisma.departmentPositionAssignment.findMany({
        where: { userId: actorId, status: 'ACTIVE' },
        select: { department: { include: departmentInclude } },
      }),
    ]);
    const byId = new Map<string, NonNullable<typeof user>['department']>();
    if (user?.department) byId.set(user.department.id, user.department);
    for (const a of assignments) byId.set(a.department.id, a.department);
    return Array.from(byId.values());
  }

  async findOne(id: string) {
    const department = await this.prisma.department.findUnique({ where: { id }, include: departmentInclude });
    if (!department) throw new NotFoundException('Department not found');
    return department;
  }

  async create(dto: CreateDepartmentDto, actorId: string) {
    const assignments = dto.assignments ?? [];
    this.assertUniqueBrands(assignments.map((a) => a.brandId));
    await Promise.all(assignments.map((a) => this.assertBrandBelongsToAgency(a)));

    const department = await this.prisma.department.create({
      data: {
        code: dto.code,
        name: dto.name,
        isActive: dto.isActive,
        assignments: {
          create: assignments.map((a) => ({
            agencyId: a.agencyId,
            brandId: a.brandId,
            effectiveDate: a.effectiveDate ? new Date(a.effectiveDate) : undefined,
          })),
        },
      },
      include: departmentInclude,
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Department', objectId: department.id, newValue: department });
    return department;
  }

  async update(id: string, dto: UpdateDepartmentDto, actorId: string) {
    const before = await this.findOne(id);
    const department = await this.prisma.department.update({ where: { id }, data: dto, include: departmentInclude });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Department', objectId: id, oldValue: before, newValue: department });
    return department;
  }

  async addAssignment(departmentId: string, dto: AddDepartmentAssignmentDto, actorId: string) {
    const department = await this.findOne(departmentId);
    if (department.assignments.some((a) => a.brandId === dto.brandId)) {
      throw new ConflictException('This Brand is already part of this Department');
    }
    await this.assertBrandBelongsToAgency(dto);

    const assignment = await this.prisma.departmentAssignment.create({
      data: {
        departmentId,
        agencyId: dto.agencyId,
        brandId: dto.brandId,
        effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : undefined,
      },
      include: { agency: true, brand: true },
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'DepartmentAssignment', objectId: assignment.id, newValue: assignment });
    return this.findOne(departmentId);
  }

  async removeAssignment(departmentId: string, assignmentId: string, actorId: string) {
    const assignment = await this.prisma.departmentAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment || assignment.departmentId !== departmentId) throw new NotFoundException('Department assignment not found');

    await this.prisma.departmentAssignment.delete({ where: { id: assignmentId } });
    await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'DepartmentAssignment', objectId: assignmentId, oldValue: assignment });
    return this.findOne(departmentId);
  }

  // Department-scoped approvers - who holds a given Position (e.g. "Head") for
  // this specific Department, feeding the Approval Level engine's per-step
  // resolution.
  async addApprover(departmentId: string, dto: AddDepartmentApproverDto, actorId: string) {
    await this.findOne(departmentId);
    const approver = await this.prisma.departmentPositionAssignment.upsert({
      where: { departmentId_positionId: { departmentId, positionId: dto.positionId } },
      update: { userId: dto.userId },
      create: { departmentId, positionId: dto.positionId, userId: dto.userId },
    });
    await this.audit.log({ userId: actorId, action: 'UPSERT', objectType: 'DepartmentPositionAssignment', objectId: approver.id, newValue: approver });
    return this.findOne(departmentId);
  }

  async removeApprover(departmentId: string, approverId: string, actorId: string) {
    const approver = await this.prisma.departmentPositionAssignment.findUnique({ where: { id: approverId } });
    if (!approver || approver.departmentId !== departmentId) throw new NotFoundException('Department approver not found');

    await this.prisma.departmentPositionAssignment.delete({ where: { id: approverId } });
    await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'DepartmentPositionAssignment', objectId: approverId, oldValue: approver });
    return this.findOne(departmentId);
  }

  private assertUniqueBrands(brandIds: string[]) {
    const seen = new Set<string>();
    for (const id of brandIds) {
      if (seen.has(id)) {
        throw new ConflictException('Each Brand can only appear once per Department');
      }
      seen.add(id);
    }
  }

  // Agency -> Advertiser -> Brand is a fixed ownership chain; a Department
  // pairing is only valid if the chosen Brand's actual Advertiser belongs to
  // the chosen Agency.
  private async assertBrandBelongsToAgency(pair: DepartmentAssignmentInputDto) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: pair.brandId },
      include: { advertiser: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    if (brand.advertiser.agencyId !== pair.agencyId) {
      throw new BadRequestException(
        `Brand "${brand.name}" belongs to Advertiser "${brand.advertiser.name}", which is not under the selected Agency`,
      );
    }
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AddPodApproverDto, AddPodAssignmentDto, AddPodMemberDto, CreatePodDto, PodAssignmentInputDto, UpdatePodDto } from './dto/pod.dto';

const podInclude = {
  members: { include: { sales: { select: { id: true, name: true, employeeId: true } } } },
  assignments: { include: { agency: true, brand: { include: { advertiser: true } } } },
  approvers: { include: { position: true, user: { select: { id: true, name: true, employeeId: true } } } },
} as const;

// POD (BRD section 6.2): a named coverage group covering one or more Sales
// (many-to-many via PodMember), each covering multiple Agency <-> Brand pairs.
// A Brand may appear at most once per POD (business rule: no duplicate Brand
// within a POD), but one Agency can cover many Brands.
@Injectable()
export class PodsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(filter: { salesId?: string; search?: string } = {}) {
    return this.prisma.pod.findMany({
      where: {
        name: filter.search ? { contains: filter.search, mode: 'insensitive' } : undefined,
        members: filter.salesId ? { some: { salesId: filter.salesId } } : undefined,
      },
      include: podInclude,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const pod = await this.prisma.pod.findUnique({ where: { id }, include: podInclude });
    if (!pod) throw new NotFoundException('POD not found');
    return pod;
  }

  async create(dto: CreatePodDto, actorId: string) {
    const assignments = dto.assignments ?? [];
    this.assertUniqueBrands(assignments.map((a) => a.brandId));
    await Promise.all(assignments.map((a) => this.assertBrandBelongsToAgency(a)));

    const salesIds = dto.salesIds ?? [];
    if (salesIds.length > 0) {
      const sales = await this.prisma.user.findMany({ where: { id: { in: salesIds } } });
      if (sales.length !== salesIds.length) throw new NotFoundException('One or more Sales not found');
    }

    const pod = await this.prisma.pod.create({
      data: {
        name: dto.name,
        members: salesIds.length > 0 ? { create: salesIds.map((salesId) => ({ salesId })) } : undefined,
        assignments: {
          create: assignments.map((a) => ({
            agencyId: a.agencyId,
            brandId: a.brandId,
            effectiveDate: a.effectiveDate ? new Date(a.effectiveDate) : undefined,
          })),
        },
      },
      include: podInclude,
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Pod', objectId: pod.id, newValue: pod });
    return pod;
  }

  async update(id: string, dto: UpdatePodDto, actorId: string) {
    const before = await this.findOne(id);
    const pod = await this.prisma.pod.update({ where: { id }, data: dto, include: podInclude });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Pod', objectId: id, oldValue: before, newValue: pod });
    return pod;
  }

  async addMember(podId: string, dto: AddPodMemberDto, actorId: string) {
    const pod = await this.findOne(podId);
    if (pod.members.some((m) => m.salesId === dto.salesId)) {
      throw new ConflictException('This Sales is already a member of this POD');
    }
    const sales = await this.prisma.user.findUnique({ where: { id: dto.salesId } });
    if (!sales) throw new NotFoundException('Sales not found');

    const member = await this.prisma.podMember.create({ data: { podId, salesId: dto.salesId } });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'PodMember', objectId: member.id, newValue: member });
    return this.findOne(podId);
  }

  async removeMember(podId: string, memberId: string, actorId: string) {
    const member = await this.prisma.podMember.findUnique({ where: { id: memberId } });
    if (!member || member.podId !== podId) throw new NotFoundException('POD member not found');

    await this.prisma.podMember.delete({ where: { id: memberId } });
    await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'PodMember', objectId: memberId, oldValue: member });
    return this.findOne(podId);
  }

  async addAssignment(podId: string, dto: AddPodAssignmentDto, actorId: string) {
    const pod = await this.findOne(podId);
    if (pod.assignments.some((a) => a.brandId === dto.brandId)) {
      throw new ConflictException('This Brand is already part of this POD');
    }
    await this.assertBrandBelongsToAgency(dto);

    const assignment = await this.prisma.podAssignment.create({
      data: {
        podId,
        agencyId: dto.agencyId,
        brandId: dto.brandId,
        effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : undefined,
      },
      include: { agency: true, brand: true },
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'PodAssignment', objectId: assignment.id, newValue: assignment });
    return this.findOne(podId);
  }

  async removeAssignment(podId: string, assignmentId: string, actorId: string) {
    const assignment = await this.prisma.podAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment || assignment.podId !== podId) throw new NotFoundException('POD assignment not found');

    await this.prisma.podAssignment.delete({ where: { id: assignmentId } });
    await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'PodAssignment', objectId: assignmentId, oldValue: assignment });
    return this.findOne(podId);
  }

  // POD-scoped approvers - who holds a given Position (e.g. "Head POD") for this
  // specific POD, feeding the Approval Level engine's per-step resolution.
  async addApprover(podId: string, dto: AddPodApproverDto, actorId: string) {
    await this.findOne(podId);
    const approver = await this.prisma.podPositionAssignment.upsert({
      where: { podId_positionId: { podId, positionId: dto.positionId } },
      update: { userId: dto.userId },
      create: { podId, positionId: dto.positionId, userId: dto.userId },
    });
    await this.audit.log({ userId: actorId, action: 'UPSERT', objectType: 'PodPositionAssignment', objectId: approver.id, newValue: approver });
    return this.findOne(podId);
  }

  async removeApprover(podId: string, approverId: string, actorId: string) {
    const approver = await this.prisma.podPositionAssignment.findUnique({ where: { id: approverId } });
    if (!approver || approver.podId !== podId) throw new NotFoundException('POD approver not found');

    await this.prisma.podPositionAssignment.delete({ where: { id: approverId } });
    await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'PodPositionAssignment', objectId: approverId, oldValue: approver });
    return this.findOne(podId);
  }

  private assertUniqueBrands(brandIds: string[]) {
    const seen = new Set<string>();
    for (const id of brandIds) {
      if (seen.has(id)) {
        throw new ConflictException('Each Brand can only appear once per POD');
      }
      seen.add(id);
    }
  }

  // Agency -> Advertiser -> Brand is a fixed ownership chain; a POD pairing is only
  // valid if the chosen Brand's actual Advertiser belongs to the chosen Agency.
  private async assertBrandBelongsToAgency(pair: PodAssignmentInputDto) {
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

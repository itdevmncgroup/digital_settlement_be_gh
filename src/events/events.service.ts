import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentStage, EventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { CreateEventDto, UpdateEventDto } from './dto/event.dto';

const include = {
  sales: { select: { id: true, name: true, employeeId: true } },
  unit: true,
  department: true,
  advertiser: { include: { agency: true } },
  brand: true,
  activityType: true,
  participants: true,
  approvalRequest: {
    include: {
      steps: { include: { position: true, resolvedApprover: { select: { id: true, name: true } } }, orderBy: { stepOrder: 'asc' } },
      actions: true,
    },
  },
} as const;

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  async findAll(filter: { salesId?: string; status?: EventStatus; search?: string }) {
    return this.prisma.event.findMany({
      where: {
        salesId: filter.salesId,
        status: filter.status,
        ...(filter.search
          ? {
              OR: [
                { eventNo: { contains: filter.search, mode: 'insensitive' } },
                { purpose: { contains: filter.search, mode: 'insensitive' } },
                { sales: { name: { contains: filter.search, mode: 'insensitive' } } },
                { advertiser: { name: { contains: filter.search, mode: 'insensitive' } } },
                { brand: { name: { contains: filter.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const event = await this.prisma.event.findUnique({ where: { id }, include });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  // BR-002: Unit ditentukan berdasarkan profile/assignment Sales.
  // Admin/Finance may pass dto.salesId to create on behalf of another Sales
  // (manual/historical entry, BRD section 5.3) - ignored for a plain Sales
  // caller, who can only ever create their own.
  async create(dto: CreateEventDto, actorId: string, actorRoles: string[]) {
    const targetSalesId = this.isBackOffice(actorRoles) && dto.salesId ? dto.salesId : actorId;

    const sales = await this.prisma.user.findUnique({ where: { id: targetSalesId } });
    if (!sales?.unitId) {
      throw new BadRequestException('Sales has no active Unit assignment');
    }

    // Department determines the Department-scoped Approval Level chain (BRD
    // section 22-23 example). Defaults to the target Sales' own Department if
    // they belong to exactly one; overridable via dto.departmentId, and
    // required explicitly when the Sales belongs to zero or several.
    const departmentId = dto.departmentId ?? (await this.resolveDefaultDepartmentId(targetSalesId));

    const eventNo = await this.generateEventNo();

    const event = await this.prisma.event.create({
      data: {
        eventNo,
        salesId: targetSalesId,
        unitId: sales.unitId,
        departmentId,
        advertiserId: dto.advertiserId,
        brandId: dto.brandId,
        activityTypeId: dto.activityTypeId,
        date: new Date(dto.date),
        startTime: dto.startTime,
        endTime: dto.endTime,
        location: dto.location,
        purpose: dto.purpose,
        estimatedAmount: dto.estimatedAmount,
        notes: dto.notes,
        participants: dto.participants ? { create: dto.participants } : undefined,
      },
      include,
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Event', objectId: event.id, newValue: event });
    return event;
  }

  // Editable while DRAFT or SUBMITTED (i.e. any time before the approval chain
  // finishes) - once APPROVED/REJECTED/COMPLETED it's locked.
  private static readonly EDITABLE_STATUSES: EventStatus[] = [EventStatus.DRAFT, EventStatus.SUBMITTED];

  async update(id: string, dto: UpdateEventDto, actorId: string, actorRoles: string[]) {
    const before = await this.findOne(id);
    if (!EventsService.EDITABLE_STATUSES.includes(before.status)) {
      throw new BadRequestException(`Event in status ${before.status} cannot be edited`);
    }
    if (before.salesId !== actorId && !this.isBackOffice(actorRoles)) {
      throw new ForbiddenException('Not owner of this event');
    }
    const canReassignSales = this.isBackOffice(actorRoles);

    // Reassigning the owning Sales carries their Unit/Department along, same as create().
    let salesId: string | undefined;
    let unitId: string | undefined;
    let departmentId: string | null | undefined;
    if (canReassignSales && dto.salesId && dto.salesId !== before.salesId) {
      const sales = await this.prisma.user.findUnique({ where: { id: dto.salesId } });
      if (!sales?.unitId) throw new BadRequestException('Sales has no active Unit assignment');
      salesId = sales.id;
      unitId = sales.unitId;
      departmentId = dto.departmentId ?? (await this.resolveDefaultDepartmentId(sales.id));
    }

    const event = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.event.update({
        where: { id },
        data: {
          salesId,
          unitId,
          departmentId: dto.departmentId ?? departmentId,
          advertiserId: dto.advertiserId,
          brandId: dto.brandId,
          activityTypeId: dto.activityTypeId,
          date: dto.date ? new Date(dto.date) : undefined,
          startTime: dto.startTime,
          endTime: dto.endTime,
          location: dto.location,
          purpose: dto.purpose,
          estimatedAmount: dto.estimatedAmount,
          notes: dto.notes,
        },
        include,
      });

      // The approval chain was resolved against the old Department/amount - if
      // the event is already SUBMITTED, re-resolve it against the edited
      // values so it doesn't keep pointing at stale approvers.
      if (before.status === EventStatus.SUBMITTED) {
        await this.approvals.createOrResetRequest(tx, {
          documentStage: DocumentStage.PRE_EVENT,
          eventId: id,
          amount: updated.estimatedAmount,
          departmentId: updated.departmentId,
        });
        return tx.event.findUniqueOrThrow({ where: { id }, include });
      }
      return updated;
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Event', objectId: id, oldValue: before, newValue: event });
    return event;
  }

  async submit(id: string, actorId: string, actorRoles: string[]) {
    const before = await this.findOne(id);
    if (before.salesId !== actorId && !this.isBackOffice(actorRoles)) {
      throw new ForbiddenException('Not owner of this event');
    }
    if (before.status !== EventStatus.DRAFT) throw new BadRequestException('Only DRAFT events can be submitted');

    const event = await this.prisma.$transaction(async (tx) => {
      await this.approvals.createOrResetRequest(tx, {
        documentStage: DocumentStage.PRE_EVENT,
        eventId: id,
        amount: before.estimatedAmount,
        departmentId: before.departmentId,
      });
      return tx.event.update({ where: { id }, data: { status: EventStatus.SUBMITTED }, include });
    });

    await this.audit.log({ userId: actorId, action: 'SUBMIT', objectType: 'Event', objectId: id, oldValue: before.status, newValue: event.status });
    return event;
  }

  // Approve/reject now live on the shared Approval Level engine (ApprovalsService.approve/reject).

  private isBackOffice(actorRoles: string[]): boolean {
    return actorRoles.some((r) => r === 'ADMIN' || r === 'FINANCE');
  }

  // Unambiguous only when the Sales belongs to exactly one Department -
  // otherwise the caller must pass an explicit dto.departmentId.
  private async resolveDefaultDepartmentId(salesId: string): Promise<string | undefined> {
    const memberships = await this.prisma.userDepartment.findMany({
      where: { userId: salesId, status: 'ACTIVE' },
      select: { departmentId: true },
    });
    if (memberships.length === 1) return memberships[0].departmentId;
    throw new BadRequestException('Department must be specified - Sales belongs to multiple or no Departments');
  }

  private async generateEventNo(): Promise<string> {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await this.prisma.event.count({
      where: { eventNo: { startsWith: `EVT-${yyyymm}-` } },
    });
    return `EVT-${yyyymm}-${String(count + 1).padStart(4, '0')}`;
  }
}

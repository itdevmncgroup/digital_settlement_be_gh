import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalActionType, ApprovalStatus, ApprovalStepStatus, DocumentStage, ExpenseRequestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { RoleName } from '../common/constants/role-name';
import { clientLabel } from './client-label';
import { canViewAllRecords, getActorDepartmentIds } from '../common/rbac/scope.util';
import { CreateExpenseRequestDto, SetExpenseRequestBudgetDto, UpdateExpenseRequestDto, VerifyExpenseRequestDto } from './dto/expense-request.dto';

// Position codes (see prisma/seed.ts) of the two post-approval stages.
const POSITION_SALES_CS = 'SLS-CS';
const POSITION_CORSEC = 'CORSEC';

// Activity Types an Expense Request may be raised for (by ActivityType.name) - locked to one for now.
const ALLOWED_ACTIVITY_TYPE_NAMES = ['Karangan Bunga'];

// Positions an Expense Request can be entered on behalf of (same set as ExpensesService's requestors).
const REQUESTOR_POSITION_CODES = ['SLS', 'STAFF', 'CO-CSO'];
// Entering a Request for someone else needs this permission (or ADMIN) - plain create is
// webmobile.request.expense.create.own / request.expense.create.owndept.
const ON_BEHALF_PERMISSION = 'webmobile.request.expense.create.owndept';

const userSelect = { select: { id: true, name: true, employeeId: true } } as const;

const include = {
  requestedBy: userSelect,
  // Set when keyed in on the requestor's behalf (see ExpenseRequest.createdById).
  createdBy: userSelect,
  department: { select: { id: true, name: true } },
  activityType: { select: { id: true, name: true } },
  agencies: { include: { agency: { select: { id: true, name: true } } } },
  advertisers: { include: { advertiser: { select: { id: true, name: true } } } },
  brands: { include: { brand: { select: { id: true, name: true, advertiserId: true } } } },
  budgetBy: userSelect,
  verifiedBy: userSelect,
  // The Expense Corsec raised from this Request (at most one) - lets the UI hide Requests already used.
  expense: { select: { id: true, expenseNo: true, status: true } },
  approvalRequest: {
    include: {
      steps: { include: { position: true, resolvedApprover: { select: { id: true, name: true } } }, orderBy: { stepOrder: 'asc' as const } },
    },
  },
} as const;

@Injectable()
export class ExpenseRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async positionCodeOf(userId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { position: { select: { code: true } } } });
    return user?.position?.code;
  }

  // Admin/Management see everything, as do the two post-approval teams (they
  // work the whole queue). Everyone else sees what they entered or approve -
  // plus, with request.expense.read.owndept, every Request of their own
  // Department(s) (UserDepartment membership or approval Position assignment).
  async findAll(actor: AuthUser, search?: string) {
    const positionCode = await this.positionCodeOf(actor.userId);
    const seesAll = canViewAllRecords(actor) || positionCode === POSITION_SALES_CS || positionCode === POSITION_CORSEC;

    const and: Prisma.ExpenseRequestWhereInput[] = [
      // A DRAFT is private to whoever entered it (the requestor, or the inputter keying it in for them).
      { OR: [{ status: { not: ExpenseRequestStatus.DRAFT } }, { requestedById: actor.userId }, { createdById: actor.userId }] },
    ];
    if (!seesAll) {
      const visible: Prisma.ExpenseRequestWhereInput[] = [
        { requestedById: actor.userId },
        { createdById: actor.userId },
        { approvalRequest: { steps: { some: { resolvedApproverId: actor.userId } } } },
      ];
      if (actor.permissions?.includes('request.expense.read.owndept')) {
        visible.push({ departmentId: { in: await getActorDepartmentIds(this.prisma, actor.userId) } });
      }
      and.push({ OR: visible });
    }
    if (search) {
      and.push({
        OR: [
          { requestNo: { contains: search, mode: 'insensitive' } },
          { clientName: { contains: search, mode: 'insensitive' } },
          { agencies: { some: { agency: { name: { contains: search, mode: 'insensitive' } } } } },
          { advertisers: { some: { advertiser: { name: { contains: search, mode: 'insensitive' } } } } },
          { brands: { some: { brand: { name: { contains: search, mode: 'insensitive' } } } } },
          { greetingText: { contains: search, mode: 'insensitive' } },
          { recipientAddress: { contains: search, mode: 'insensitive' } },
          { requestedBy: { name: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.ExpenseRequestWhereInput = { AND: and };
    return this.prisma.expenseRequest.findMany({ where, include, orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string) {
    const request = await this.prisma.expenseRequest.findUnique({ where: { id }, include });
    if (!request) throw new NotFoundException('Expense Request not found');
    return request;
  }

  // Shared by create + update: validates Activity Type / parties / Department access.
  private async prepare(dto: CreateExpenseRequestDto, actor: AuthUser) {
    const activityType = await this.prisma.activityType.findUnique({ where: { id: dto.activityTypeId } });
    if (!activityType?.isActive || !ALLOWED_ACTIVITY_TYPE_NAMES.includes(activityType.name)) {
      throw new BadRequestException(`Activity Type must be one of: ${ALLOWED_ACTIVITY_TYPE_NAMES.join(', ')}`);
    }
    await this.assertClientParties(dto);
    const departmentId = dto.departmentId ?? (await this.resolveDefaultDepartmentId(actor.userId));
    // Sales Admin / Admin may raise for any Department; request.expense.create.owndept
    // callers (no such role) only for a Department they belong to or hold a Position in.
    if (!actor.roles.some((r) => r === RoleName.SALES_ADMIN || r === RoleName.ADMIN)) {
      await this.assertOwnDepartment(actor.userId, departmentId);
    }
    return { activityType, departmentId };
  }

  private fieldData(dto: CreateExpenseRequestDto) {
    return {
      greetingText: dto.greetingText.trim(),
      sendDate: new Date(dto.sendDate),
      recipientAddress: dto.recipientAddress.trim(),
      logo: dto.logo?.trim() || null,
      requestBudget: dto.budget ?? null,
      agencies: dto.agencyIds?.length ? { create: dto.agencyIds.map((agencyId) => ({ agencyId })) } : undefined,
      advertisers: dto.advertiserIds?.length ? { create: dto.advertiserIds.map((advertiserId) => ({ advertiserId })) } : undefined,
      brands: dto.brandIds?.length ? { create: dto.brandIds.map((brandId) => ({ brandId })) } : undefined,
    };
  }

  // Entered by Sales Admin. Either saved as an editable DRAFT, or submitted
  // straight into the Head Dept -> Co-CSO chain.
  async create(dto: CreateExpenseRequestDto, actor: AuthUser) {
    const actorId = actor.userId;
    const { activityType, departmentId } = await this.prepare(dto, actor);
    const requestedById = await this.resolveRequestorId(dto, actor, departmentId);

    const created = await this.prisma.$transaction(async (tx) => {
      const request = await tx.expenseRequest.create({
        data: {
          requestNo: await this.generateRequestNo(tx),
          requestedById,
          // The inputter, only when it isn't the requestor (see ExpenseRequest.createdById).
          createdById: requestedById === actorId ? null : actorId,
          departmentId,
          activityTypeId: activityType.id,
          status: dto.saveAsDraft ? ExpenseRequestStatus.DRAFT : ExpenseRequestStatus.PENDING_APPROVAL,
          ...this.fieldData(dto),
        },
      });
      // Throws (rolling the request back) if no Approval Level / approver is configured.
      if (!dto.saveAsDraft) await this.startApproval(tx, request.id, departmentId, activityType.id);
      return request;
    });

    const request = await this.findOne(created.id);
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'ExpenseRequest', objectId: request.id, newValue: request });
    return request;
  }

  // Edit is allowed only while DRAFT, by whoever entered it (the requestor or the inputter keying it
  // in for them) or an Admin. Full replacement; the requestor never changes here.
  async update(id: string, dto: UpdateExpenseRequestDto, actor: AuthUser) {
    const before = await this.findEditableDraft(id, actor);
    const { activityType, departmentId } = await this.prepare(dto, actor);

    await this.prisma.$transaction(async (tx) => {
      await tx.expenseRequestAgency.deleteMany({ where: { expenseRequestId: id } });
      await tx.expenseRequestAdvertiser.deleteMany({ where: { expenseRequestId: id } });
      await tx.expenseRequestBrand.deleteMany({ where: { expenseRequestId: id } });
      await tx.expenseRequest.update({
        where: { id },
        data: { departmentId, activityTypeId: activityType.id, ...this.fieldData(dto) },
      });
    });

    const request = await this.findOne(id);
    await this.audit.log({ userId: actor.userId, action: 'UPDATE', objectType: 'ExpenseRequest', objectId: id, oldValue: before, newValue: request });
    return request;
  }

  // DRAFT -> PENDING_APPROVAL: starts the Head Dept -> Co-CSO chain.
  async submit(id: string, actor: AuthUser) {
    const draft = await this.findEditableDraft(id, actor);
    await this.prisma.$transaction(async (tx) => {
      await tx.expenseRequest.update({ where: { id }, data: { status: ExpenseRequestStatus.PENDING_APPROVAL } });
      // Throws (rolling the status back) if no Approval Level / approver is configured.
      await this.startApproval(tx, id, draft.departmentId as string, draft.activityTypeId);
    });

    const request = await this.findOne(id);
    await this.audit.log({ userId: actor.userId, action: 'UPDATE', objectType: 'ExpenseRequest', objectId: id, oldValue: ExpenseRequestStatus.DRAFT, newValue: request.status });
    return request;
  }

  private startApproval(tx: Prisma.TransactionClient, expenseRequestId: string, departmentId: string, activityTypeId: string) {
    return this.approvals.createOrResetRequest(tx, {
      documentStage: DocumentStage.EXPENSE_REQUEST,
      expenseRequestId,
      amount: 0,
      departmentId,
      activityTypeId,
    });
  }

  // dto.requestedById lets the caller key the Request in for another user: the requestor must be an
  // active SLS/STAFF/CO-CSO member of the Request's Department, and (unless Admin) that Department
  // one of the caller's own. Without dto.requestedById (or naming the caller) it is the caller.
  private async resolveRequestorId(dto: { requestedById?: string }, actor: AuthUser, departmentId: string): Promise<string> {
    if (!dto.requestedById || dto.requestedById === actor.userId) return actor.userId;
    const isAdmin = actor.roles.includes(RoleName.ADMIN);
    if (!isAdmin && !actor.permissions?.includes(ON_BEHALF_PERMISSION)) {
      throw new ForbiddenException('You cannot enter an Expense Request on behalf of another user');
    }
    const requestor = await this.prisma.user.findUnique({
      where: { id: dto.requestedById },
      select: {
        status: true,
        position: { select: { code: true } },
        departments: { where: { status: 'ACTIVE' }, select: { departmentId: true } },
      },
    });
    if (!requestor || requestor.status !== 'ACTIVE') throw new BadRequestException('Requestor not found or inactive');
    if (!requestor.position || !REQUESTOR_POSITION_CODES.includes(requestor.position.code)) {
      throw new BadRequestException('Requestor must hold a Sales, Staff or Co-CSO position');
    }
    if (!requestor.departments.some((d) => d.departmentId === departmentId)) {
      throw new ForbiddenException('Requestor is not a member of the selected Department');
    }
    if (!isAdmin && !(await getActorDepartmentIds(this.prisma, actor.userId)).includes(departmentId)) {
      throw new ForbiddenException('Cannot enter an Expense Request for a Department outside your own');
    }
    return dto.requestedById;
  }

  // Users the caller may pick as requestor in the New Request form - same rules as
  // resolveRequestorId: Admin -> every active SLS/STAFF/CO-CSO user, ON_BEHALF_PERMISSION holder ->
  // only those sharing a Department with the caller, anyone else -> none.
  async listRequestors(actor: AuthUser) {
    const isAdmin = actor.roles.includes(RoleName.ADMIN);
    if (!isAdmin && !actor.permissions?.includes(ON_BEHALF_PERMISSION)) return [];
    let departmentFilter: Prisma.UserWhereInput = {};
    if (!isAdmin) {
      const departmentIds = await getActorDepartmentIds(this.prisma, actor.userId);
      if (departmentIds.length === 0) return [];
      departmentFilter = { departments: { some: { departmentId: { in: departmentIds }, status: 'ACTIVE' } } };
    }
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', position: { code: { in: REQUESTOR_POSITION_CODES } }, ...departmentFilter },
      select: {
        id: true,
        name: true,
        employeeId: true,
        departments: { where: { status: 'ACTIVE' }, select: { departmentId: true } },
      },
      orderBy: { name: 'asc' },
    });
    return users.map(({ departments, ...u }) => ({ ...u, departmentIds: departments.map((d) => d.departmentId) }));
  }

  private async findEditableDraft(id: string, actor: AuthUser) {
    const request = await this.findOne(id);
    if (request.requestedById !== actor.userId && request.createdById !== actor.userId && !actor.roles.includes(RoleName.ADMIN)) {
      throw new ForbiddenException('Only the requester can change this Expense Request');
    }
    if (request.status !== ExpenseRequestStatus.DRAFT) {
      throw new BadRequestException(`Expense Request in status ${request.status} can no longer be edited`);
    }
    return request;
  }

  // Stage 2: Sales Customer Service fills the budget (editable until Corsec acts).
  async setBudget(id: string, dto: SetExpenseRequestBudgetDto, actor: AuthUser) {
    await this.assertStageActor(actor, POSITION_SALES_CS, 'Only Sales Customer Service can fill in the budget');
    const before = await this.findOne(id);
    if (before.status !== ExpenseRequestStatus.BUDGET_INPUT) {
      throw new BadRequestException(`Expense Request in status ${before.status} is not waiting for a budget`);
    }

    const request = await this.prisma.$transaction(async (tx) => {
      // The Sales CS step of the approval chain (if the Level has one) only counts as approved
      // once the budget is in. Rows approved under the old flow already have it APPROVED: skip.
      const chain = await tx.approvalRequest.findUnique({
        where: { expenseRequestId: id },
        include: { steps: { include: { position: true }, orderBy: { stepOrder: 'asc' } } },
      });
      const budgetStep = chain?.steps.find((s) => s.stepOrder === chain.currentStep && s.status === ApprovalStepStatus.PENDING && s.position.code === POSITION_SALES_CS);
      if (chain && budgetStep) {
        await tx.approvalRequestStep.update({ where: { id: budgetStep.id }, data: { status: ApprovalStepStatus.APPROVED } });
        await tx.approvalAction.create({
          data: { approvalRequestId: chain.id, actorId: actor.userId, positionId: budgetStep.positionId, action: ApprovalActionType.APPROVE },
        });
        const nextStep = chain.currentStep + 1;
        await tx.approvalRequest.update({
          where: { id: chain.id },
          data: { currentStep: nextStep, status: nextStep >= chain.steps.length ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING },
        });
      }

      return tx.expenseRequest.update({
        where: { id },
        data: {
          budgetAmount: dto.budgetAmount,
          budgetNotes: dto.budgetNotes?.trim() || null,
          budgetById: actor.userId,
          budgetAt: new Date(),
          status: ExpenseRequestStatus.CORSEC_VERIFICATION,
        },
        include,
      });
    });
    await this.audit.log({ userId: actor.userId, action: 'UPDATE', objectType: 'ExpenseRequest', objectId: id, oldValue: before.status, newValue: { status: request.status, budgetAmount: dto.budgetAmount } });

    const corsec = await this.prisma.user.findMany({ where: { status: 'ACTIVE', position: { code: POSITION_CORSEC } }, select: { id: true } });
    for (const u of corsec) {
      await this.notifications.notify({
        userId: u.id,
        type: 'EXPENSE_REQUEST_PENDING',
        title: 'Expense Request awaiting verification',
        body: `${request.requestNo} (${clientLabel(request)}) has a budget and needs Corsec verification.`,
        deepLink: '/expense-requests',
        objectType: 'ExpenseRequest',
        objectId: id,
      });
    }
    return request;
  }

  // Stage 3: Corsec picks Proceed / Cancel. PROCEED unlocks "Add Invoices" (creates the Expense);
  // CANCELLED is terminal and keeps its reason in rejectReason.
  async verify(id: string, dto: VerifyExpenseRequestDto, actor: AuthUser) {
    await this.assertStageActor(actor, POSITION_CORSEC, 'Only Corsec can verify an Expense Request');
    const reason = dto.reason?.trim();
    if (dto.decision === 'CANCELLED' && !reason) throw new BadRequestException('A reason is required to cancel');

    const before = await this.findOne(id);
    if (before.status !== ExpenseRequestStatus.CORSEC_VERIFICATION) {
      throw new BadRequestException(`Expense Request in status ${before.status} is not waiting for Corsec verification`);
    }

    const request = await this.prisma.expenseRequest.update({
      where: { id },
      data: {
        status: dto.decision === 'PROCEED' ? ExpenseRequestStatus.PROCEED : ExpenseRequestStatus.CANCELLED,
        rejectReason: dto.decision === 'CANCELLED' ? reason : null,
        verifiedById: actor.userId,
        verifiedAt: new Date(),
      },
      include,
    });
    await this.audit.log({
      userId: actor.userId,
      action: dto.decision === 'PROCEED' ? 'APPROVE' : 'REJECT',
      objectType: 'ExpenseRequest',
      objectId: id,
      oldValue: before.status,
      newValue: { status: request.status, reason },
    });

    if (dto.decision === 'CANCELLED') {
      await this.notifications.notify({
        userId: request.requestedById,
        type: 'EXPENSE_REQUEST_REJECTED',
        title: 'Expense Request cancelled',
        body: reason as string,
        deepLink: '/expense-requests',
        objectType: 'ExpenseRequest',
        objectId: id,
      });
    }
    return request;
  }

  // Post-approval stages are position-gated (Admin may act on any stage, same
  // override the approval chain itself gives them).
  private async assertStageActor(actor: AuthUser, positionCode: string, message: string) {
    if (actor.roles.includes('ADMINISTRATOR')) return;
    if ((await this.positionCodeOf(actor.userId)) !== positionCode) throw new ForbiddenException(message);
  }

  // At least one Agency or Advertiser; Brand optional. Every id must exist and be active;
  // each Brand must belong to a picked Advertiser.
  private async assertClientParties(dto: CreateExpenseRequestDto) {
    const agencyIds = dto.agencyIds ?? [];
    const advertiserIds = dto.advertiserIds ?? [];
    const brandIds = dto.brandIds ?? [];
    if (agencyIds.length === 0 && advertiserIds.length === 0) {
      throw new BadRequestException('Select at least one Agency or Advertiser');
    }
    const [agencies, advertisers, brands] = await Promise.all([
      agencyIds.length ? this.prisma.agency.findMany({ where: { id: { in: agencyIds }, isActive: true }, select: { id: true } }) : [],
      advertiserIds.length ? this.prisma.advertiser.findMany({ where: { id: { in: advertiserIds }, isActive: true }, select: { id: true } }) : [],
      brandIds.length ? this.prisma.brand.findMany({ where: { id: { in: brandIds }, isActive: true }, select: { id: true, advertiserId: true } }) : ([] as { id: string; advertiserId: string }[]),
    ]);
    if (agencies.length !== agencyIds.length) throw new BadRequestException('Unknown or inactive Agency selected');
    if (advertisers.length !== advertiserIds.length) throw new BadRequestException('Unknown or inactive Advertiser selected');
    if (brands.length !== brandIds.length) throw new BadRequestException('Unknown or inactive Brand selected');
    if (brands.some((b) => !advertiserIds.includes(b.advertiserId))) {
      throw new BadRequestException('Each Brand must belong to one of the selected Advertisers');
    }
  }

  // Unambiguous only when the requester belongs to exactly one Department -
  // otherwise the caller must pass an explicit dto.departmentId.
  private async assertOwnDepartment(userId: string, departmentId: string) {
    const [membership, assignment] = await Promise.all([
      this.prisma.userDepartment.findFirst({ where: { userId, departmentId, status: 'ACTIVE' }, select: { departmentId: true } }),
      this.prisma.departmentPositionAssignment.findFirst({ where: { userId, departmentId, status: 'ACTIVE' }, select: { id: true } }),
    ]);
    if (!membership && !assignment) throw new ForbiddenException('You can only create an Expense Request for your own Department');
  }

  private async resolveDefaultDepartmentId(userId: string): Promise<string> {
    const memberships = await this.prisma.userDepartment.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { departmentId: true },
    });
    if (memberships.length === 1) return memberships[0].departmentId;
    throw new BadRequestException('Department must be specified - you belong to multiple or no Departments');
  }

  private async generateRequestNo(tx: Prisma.TransactionClient): Promise<string> {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await tx.expenseRequest.count({
      where: { requestNo: { startsWith: `ER-${yyyymm}-` } },
    });
    return `ER-${yyyymm}-${String(count + 1).padStart(4, '0')}`;
  }
}

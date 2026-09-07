import { randomBytes } from 'crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApprovalLevel,
  ApprovalLevelStep,
  ApprovalActionType,
  ApprovalScopeType,
  ApprovalStatus,
  ApprovalStepStatus,
  DocumentStage,
  EventStatus,
  ExpenseStatus,
  Position,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EmailService } from '../email/email.service';
import { CreateApprovalLevelDto, UpdateApprovalLevelDto } from './dto/approval-level.dto';

type ApprovalLevelWithSteps = ApprovalLevel & {
  steps: (ApprovalLevelStep & { position: Position })[];
  pod: { name: string } | null;
  department: { name: string } | null;
};

const levelInclude = {
  steps: { include: { position: true }, orderBy: { stepOrder: 'asc' as const } },
  pod: true,
  department: true,
};

const requestInclude = {
  approvalLevel: true,
  steps: { include: { position: true, resolvedApprover: { select: { id: true, name: true } } }, orderBy: { stepOrder: 'asc' as const } },
  actions: { include: { actor: { select: { id: true, name: true } }, position: true }, orderBy: { actedAt: 'asc' as const } },
};

/**
 * Approval Workflow (BRD section 22-23, BR-013/BR-014), rebuilt on Approval Level
 * master data: each Level is scoped to a Document Stage (PRE_EVENT/SETTLEMENT) and
 * an amount range, plus optionally a POD or Department, and defines an ordered
 * chain of Positions (e.g. Head POD -> Supervisor). At submit time every step is
 * resolved to a concrete User up front - if any step can't be resolved (no one
 * holds that Position for the relevant POD/Department), the submit is blocked
 * with a precise error rather than silently defaulting, since there is no longer
 * a generic fallback role to fall back to.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  // ---- Approval Levels (Admin, BRD section 26 -> System > Approval Level) ----

  findLevels() {
    return this.prisma.approvalLevel.findMany({
      include: levelInclude,
      orderBy: [{ documentStage: 'asc' }, { scopeType: 'asc' }, { minAmount: 'asc' }],
    });
  }

  async findLevel(id: string) {
    const level = await this.prisma.approvalLevel.findUnique({ where: { id }, include: levelInclude });
    if (!level) throw new NotFoundException('Approval Level not found');
    return level;
  }

  async createLevel(dto: CreateApprovalLevelDto, actorId: string) {
    const level = await this.prisma.approvalLevel.create({
      data: {
        name: dto.name,
        documentStage: dto.documentStage,
        scopeType: dto.scopeType ?? ApprovalScopeType.ANY,
        podId: dto.podId,
        departmentId: dto.departmentId,
        minAmount: dto.minAmount,
        maxAmount: dto.maxAmount,
        steps: { create: dto.steps.map((s, i) => ({ stepOrder: i, positionId: s.positionId })) },
      },
      include: levelInclude,
    });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'ApprovalLevel', objectId: level.id, newValue: level });
    return level;
  }

  async updateLevel(id: string, dto: UpdateApprovalLevelDto, actorId: string) {
    const before = await this.findLevel(id);
    const level = await this.prisma.$transaction(async (tx) => {
      if (dto.steps) {
        await tx.approvalLevelStep.deleteMany({ where: { approvalLevelId: id } });
      }
      return tx.approvalLevel.update({
        where: { id },
        data: {
          name: dto.name,
          scopeType: dto.scopeType,
          podId: dto.podId,
          departmentId: dto.departmentId,
          minAmount: dto.minAmount,
          maxAmount: dto.maxAmount,
          isActive: dto.isActive,
          steps: dto.steps ? { create: dto.steps.map((s, i) => ({ stepOrder: i, positionId: s.positionId })) } : undefined,
        },
        include: levelInclude,
      });
    });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'ApprovalLevel', objectId: id, oldValue: before, newValue: level });
    return level;
  }

  // ---- Resolution ----

  private async resolveApprovalLevel(
    tx: Prisma.TransactionClient,
    params: { documentStage: DocumentStage; podId?: string; departmentId?: string; amount: number },
  ): Promise<ApprovalLevelWithSteps | null> {
    const levels = await tx.approvalLevel.findMany({
      where: { isActive: true, documentStage: params.documentStage },
      include: levelInclude,
    });

    const matches = levels.filter((level) => {
      const min = Number(level.minAmount);
      const max = level.maxAmount === null ? null : Number(level.maxAmount);
      const amountMatches = params.amount >= min && (max === null || params.amount <= max);
      if (!amountMatches) return false;
      if (level.scopeType === ApprovalScopeType.POD) return !!params.podId && level.podId === params.podId;
      if (level.scopeType === ApprovalScopeType.DEPARTMENT) return !!params.departmentId && level.departmentId === params.departmentId;
      return true; // ANY
    });

    if (matches.length === 0) return null;

    // Scope precedence: POD exact-match > DEPARTMENT exact-match > ANY; ties broken
    // by most-recently-updated (admin responsibility to avoid overlapping ranges).
    const rank = (l: (typeof matches)[number]) => (l.scopeType === ApprovalScopeType.POD ? 0 : l.scopeType === ApprovalScopeType.DEPARTMENT ? 1 : 2);
    matches.sort((a, b) => rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime());
    return matches[0];
  }

  private async resolveApprover(tx: Prisma.TransactionClient, level: ApprovalLevelWithSteps, positionId: string) {
    if (level.scopeType === ApprovalScopeType.POD) {
      const assignment = await tx.podPositionAssignment.findUnique({
        where: { podId_positionId: { podId: level.podId as string, positionId } },
        include: { user: true },
      });
      return assignment && assignment.status === 'ACTIVE' && assignment.user.status === 'ACTIVE' ? assignment.user : null;
    }
    if (level.scopeType === ApprovalScopeType.DEPARTMENT) {
      return tx.user.findFirst({ where: { positionId, departmentId: level.departmentId as string, status: 'ACTIVE' }, orderBy: { employeeId: 'asc' } });
    }
    // ANY scope: not tied to a specific POD/Department, so any active holder of the Position qualifies.
    return tx.user.findFirst({ where: { positionId, status: 'ACTIVE' }, orderBy: { employeeId: 'asc' } });
  }

  // ---- Approval Request lifecycle (bound 1:1 to an Expense OR an Event) ----

  async createOrResetRequest(
    tx: Prisma.TransactionClient,
    params: { documentStage: DocumentStage; expenseId?: string; eventId?: string; amount: Prisma.Decimal | number; podId?: string | null; departmentId?: string | null },
  ) {
    const amountNum = Number(params.amount);
    const level = await this.resolveApprovalLevel(tx, {
      documentStage: params.documentStage,
      podId: params.podId ?? undefined,
      departmentId: params.departmentId ?? undefined,
      amount: amountNum,
    });
    if (!level) {
      throw new BadRequestException(
        `No Approval Level configured for ${params.documentStage} at amount ${amountNum}. Ask an Admin to configure one under Approval Levels.`,
      );
    }

    const missing: string[] = [];
    const resolvedSteps: { stepOrder: number; positionId: string; resolvedApproverId: string; status: ApprovalStepStatus }[] = [];
    for (const step of level.steps) {
      const approver = await this.resolveApprover(tx, level, step.positionId);
      if (!approver) {
        const scopeLabel =
          level.scopeType === ApprovalScopeType.POD
            ? `POD "${level.pod?.name}"`
            : level.scopeType === ApprovalScopeType.DEPARTMENT
              ? `Department "${level.department?.name}"`
              : 'the organization';
        missing.push(`no user assigned as "${step.position.name}" for ${scopeLabel}`);
      } else {
        resolvedSteps.push({ stepOrder: step.stepOrder, positionId: step.positionId, resolvedApproverId: approver.id, status: ApprovalStepStatus.PENDING });
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot submit: ${missing.join('; ')} - ask an Admin to configure this under POD/Department -> Approvers before submitting.`,
      );
    }

    const existing = await tx.approvalRequest.findFirst({
      where: params.expenseId ? { expenseId: params.expenseId } : { eventId: params.eventId },
    });

    // Steps are replaced fresh on resubmit; prior ApprovalAction rows are kept so
    // a rejection reason from an earlier submit/reject cycle stays visible in the trail.
    if (existing) {
      await tx.approvalRequestStep.deleteMany({ where: { approvalRequestId: existing.id } });
    }
    const request = existing
      ? await tx.approvalRequest.update({
          where: { id: existing.id },
          data: { approvalLevelId: level.id, documentStage: params.documentStage, currentStep: 0, status: ApprovalStatus.PENDING, steps: { create: resolvedSteps } },
          include: requestInclude,
        })
      : await tx.approvalRequest.create({
          data: {
            documentStage: params.documentStage,
            expenseId: params.expenseId,
            eventId: params.eventId,
            approvalLevelId: level.id,
            currentStep: 0,
            status: ApprovalStatus.PENDING,
            steps: { create: resolvedSteps },
          },
          include: requestInclude,
        });

    const step0 = request.steps.find((s) => s.stepOrder === 0);
    if (step0) {
      await this.notifyStep(tx, { documentStage: params.documentStage, expenseId: params.expenseId, eventId: params.eventId, step: step0 });
    }
    return request;
  }

  // ---- Approval-via-email (one-click token links) ----

  private async resolveDocInfo(tx: Prisma.TransactionClient, target: { expenseId?: string; eventId?: string }) {
    if (target.expenseId) {
      const e = await tx.expense.findUniqueOrThrow({ where: { id: target.expenseId }, include: { sales: true } });
      return { docNo: e.expenseNo, salesName: e.sales.name, purpose: e.purpose, amount: e.amount };
    }
    const e = await tx.event.findUniqueOrThrow({ where: { id: target.eventId as string }, include: { sales: true } });
    return { docNo: e.eventNo, salesName: e.sales.name, purpose: e.purpose, amount: e.estimatedAmount };
  }

  private async issueStepToken(tx: Prisma.TransactionClient, stepId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const ttlDays = Number(this.config.get<string>('APPROVAL_EMAIL_TOKEN_TTL_DAYS')) || 7;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await tx.approvalRequestStep.update({ where: { id: stepId }, data: { emailToken: token, emailTokenExpiresAt: expiresAt } });
    return token;
  }

  // Mails the current step's approver a one-click Approve link plus a Reject
  // link (which opens a small reason-entry page - a reject reason is required
  // and can't be captured from a bare GET link). Fire-and-forget: a failed
  // send is logged but never blocks or fails the approval workflow itself.
  private async notifyStep(
    tx: Prisma.TransactionClient,
    params: { documentStage: DocumentStage; expenseId?: string; eventId?: string; step: { id: string; positionId: string; resolvedApproverId: string } },
  ) {
    try {
      const [doc, approver, position, token] = await Promise.all([
        this.resolveDocInfo(tx, params),
        tx.user.findUniqueOrThrow({ where: { id: params.step.resolvedApproverId } }),
        tx.position.findUniqueOrThrow({ where: { id: params.step.positionId } }),
        this.issueStepToken(tx, params.step.id),
      ]);
      const apiBase = this.config.get<string>('API_PUBLIC_URL') || 'http://localhost:3000/api/v1';
      const appBase = this.config.get<string>('APP_PUBLIC_URL') || 'http://localhost:3001';
      await this.email.sendApprovalRequest({
        to: approver.email,
        approverName: approver.name,
        positionName: position.name,
        documentStage: params.documentStage,
        docNo: doc.docNo,
        salesName: doc.salesName,
        purpose: doc.purpose,
        amount: new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(doc.amount)),
        approveUrl: `${apiBase}/public/approvals/${token}/approve`,
        rejectUrl: `${appBase}/email-action/${token}`,
      });
    } catch (err) {
      this.logger.warn(`Failed to send approval email: ${(err as Error).message}`);
    }
  }

  async getTokenInfo(token: string) {
    const step = await this.prisma.approvalRequestStep.findUnique({
      where: { emailToken: token },
      include: {
        position: true,
        resolvedApprover: { select: { name: true } },
        approvalRequest: {
          include: {
            expense: { include: { sales: { select: { name: true } } } },
            event: { include: { sales: { select: { name: true } } } },
          },
        },
      },
    });
    if (!step) throw new NotFoundException('Invalid or expired approval link');
    if (step.status !== ApprovalStepStatus.PENDING) throw new BadRequestException('This approval link has already been used');
    if (step.emailTokenExpiresAt && step.emailTokenExpiresAt < new Date()) throw new BadRequestException('This approval link has expired');

    const doc = step.approvalRequest.expense ?? step.approvalRequest.event;
    return {
      positionName: step.position.name,
      approverName: step.resolvedApprover.name,
      documentStage: step.approvalRequest.documentStage,
      docNo: step.approvalRequest.expense ? step.approvalRequest.expense.expenseNo : (step.approvalRequest.event as { eventNo: string }).eventNo,
      salesName: doc?.sales.name ?? '-',
      purpose: doc?.purpose ?? '-',
    };
  }

  // Atomically consumes the token (single-use, defends against double-click/
  // prefetch races) then delegates to the normal approve()/reject() path, so
  // every business rule (current-step gating, request-status check) still applies.
  private async consumeToken(token: string) {
    const step = await this.prisma.approvalRequestStep.findUnique({ where: { emailToken: token }, include: { approvalRequest: true } });
    if (!step) throw new NotFoundException('Invalid or expired approval link');
    if (step.status !== ApprovalStepStatus.PENDING) throw new BadRequestException('This approval link has already been used');
    if (step.emailTokenExpiresAt && step.emailTokenExpiresAt < new Date()) throw new BadRequestException('This approval link has expired');

    const consumed = await this.prisma.approvalRequestStep.updateMany({
      where: { id: step.id, emailToken: token },
      data: { emailToken: null, emailTokenExpiresAt: null },
    });
    if (consumed.count === 0) throw new BadRequestException('This approval link has already been used');

    return step.approvalRequest.expenseId
      ? { expenseId: step.approvalRequest.expenseId, actorId: step.resolvedApproverId }
      : { eventId: step.approvalRequest.eventId as string, actorId: step.resolvedApproverId };
  }

  async approveByToken(token: string) {
    const { actorId, ...target } = await this.consumeToken(token);
    return this.approve(actorId, target);
  }

  async rejectByToken(token: string, reason: string) {
    const { actorId, ...target } = await this.consumeToken(token);
    return this.reject(actorId, target, reason);
  }

  // Besides steps assigned to the actor, expense.approve.all / expense.approve.ownpod
  // (Role/Permission master) surface every other pending Expense step the actor is
  // allowed to override via assertApprovalOverride() - otherwise a permission holder
  // would have no way to even find something to approve.
  async findPendingFor(
    actorId: string,
    actorPermissions: string[] = [],
    filter?: { podId?: string; fromDate?: string; toDate?: string },
  ) {
    const orConditions: Prisma.ApprovalRequestStepWhereInput[] = [{ resolvedApproverId: actorId }];

    if (actorPermissions.includes('expense.approve.all')) {
      orConditions.push({ approvalRequest: { expenseId: { not: null } } });
    } else if (actorPermissions.includes('expense.approve.ownpod')) {
      const ownPodIds = await this.getActorPodIds(this.prisma, actorId);
      if (ownPodIds.length > 0) {
        orConditions.push({ approvalRequest: { expense: { podId: { in: ownPodIds } } } });
      }
    }

    // POD/date filters only ever apply to Expense-type approval rows (Event/Pre-Event
    // is a retired flow) - only added to the where clause when actually supplied, so
    // Event rows keep showing up when neither filter is in use.
    const hasExpenseFilter = !!(filter?.podId || filter?.fromDate || filter?.toDate);
    const expenseFilter: Prisma.ExpenseWhereInput = {
      podId: filter?.podId || undefined,
      expenseDate:
        filter?.fromDate || filter?.toDate
          ? {
              gte: filter?.fromDate ? new Date(filter.fromDate) : undefined,
              lte: filter?.toDate ? new Date(new Date(filter.toDate).setHours(23, 59, 59, 999)) : undefined,
            }
          : undefined,
    };

    const steps = await this.prisma.approvalRequestStep.findMany({
      where: {
        status: ApprovalStepStatus.PENDING,
        OR: orConditions,
        approvalRequest: hasExpenseFilter ? { expense: { is: expenseFilter } } : undefined,
      },
      include: {
        position: true,
        approvalRequest: {
          include: {
            expense: { include: { sales: { select: { id: true, name: true } }, unit: true, pod: true, advertiser: true, brand: true } },
            event: { include: { sales: { select: { id: true, name: true } }, unit: true, advertiser: true, brand: true } },
            steps: {
              include: { position: true, resolvedApprover: { select: { id: true, name: true } } },
              orderBy: { stepOrder: 'asc' },
            },
          },
        },
      },
    });
    const seen = new Set<string>();
    return steps
      .filter((s) => s.approvalRequest.status === ApprovalStatus.PENDING && s.stepOrder === s.approvalRequest.currentStep)
      .filter((s) => (seen.has(s.approvalRequestId) ? false : seen.add(s.approvalRequestId)))
      .map((s) => s.approvalRequest);
  }

  async findByExpense(expenseId: string) {
    const request = await this.prisma.approvalRequest.findUnique({ where: { expenseId }, include: requestInclude });
    if (!request) throw new NotFoundException('Approval request not found');
    return request;
  }

  async findByEvent(eventId: string) {
    const request = await this.prisma.approvalRequest.findUnique({ where: { eventId }, include: requestInclude });
    if (!request) throw new NotFoundException('Approval request not found');
    return request;
  }

  // Lets expense.approve.all / expense.approve.ownpod (Role/Permission master)
  // stand in for "is the assigned approver", same override tier as the ADMIN
  // role check above. Only applies to Expense targets - Event approval keeps
  // its old assigned-approver-or-ADMIN behavior since no expense.approve.*
  // permission was scoped to it.
  private async assertApprovalOverride(
    tx: Prisma.TransactionClient,
    actorId: string,
    target: { expenseId?: string; eventId?: string },
    actorPermissions: string[],
  ): Promise<void> {
    if (actorPermissions.includes('expense.approve.all') && target.expenseId) {
      return;
    }
    if (actorPermissions.includes('expense.approve.ownpod') && target.expenseId) {
      const expense = await tx.expense.findUnique({ where: { id: target.expenseId }, select: { podId: true } });
      if (expense?.podId) {
        const ownPodIds = await this.getActorPodIds(tx, actorId);
        if (ownPodIds.includes(expense.podId)) {
          return;
        }
      }
    }
    throw new ForbiddenException('You are not the assigned approver for this step');
  }

  // A user's "own POD(s)": PodMember covers Sales/Sales Admin declared on a POD,
  // PodPositionAssignment covers a Supervisor holding an approval position on a POD.
  private async getActorPodIds(tx: Prisma.TransactionClient, actorId: string): Promise<string[]> {
    const [memberships, assignments] = await Promise.all([
      tx.podMember.findMany({ where: { salesId: actorId }, select: { podId: true } }),
      tx.podPositionAssignment.findMany({ where: { userId: actorId, status: 'ACTIVE' }, select: { podId: true } }),
    ]);
    return Array.from(new Set([...memberships.map((m) => m.podId), ...assignments.map((a) => a.podId)]));
  }

  // Expense.status mirrors whichever approval tier is currently reviewing it - one
  // value per Position.code in today's master data (see prisma/schema.prisma
  // ExpenseStatus enum). Falls back to the generic PENDING_APPROVAL for a Position
  // that doesn't have a matching status yet (e.g. one an Admin just created).
  private pendingStatusForPosition(positionCode: string): ExpenseStatus {
    const key = `APPROVAL_${positionCode}`;
    return key in ExpenseStatus ? (ExpenseStatus as unknown as Record<string, ExpenseStatus>)[key] : ExpenseStatus.PENDING_APPROVAL;
  }

  // Entry point into the Expense approval chain - being bank-matched is the only
  // gate now (BankMatchingService.afterMatchChange), there's no separate manual
  // Submit step anymore. Also used by ExpensesService.update() to re-enter the
  // chain when a REJECTED, already-matched Expense is edited.
  async enterExpenseApproval(
    tx: Prisma.TransactionClient,
    params: { expenseId: string; amount: Prisma.Decimal | number; podId?: string | null; departmentId?: string | null },
  ): Promise<ExpenseStatus> {
    const request = await this.createOrResetRequest(tx, {
      documentStage: DocumentStage.EXPENSES,
      expenseId: params.expenseId,
      amount: params.amount,
      podId: params.podId,
      departmentId: params.departmentId,
    });
    const step0 = request.steps.find((s) => s.stepOrder === 0);
    const status = step0 ? this.pendingStatusForPosition(step0.position.code) : ExpenseStatus.PENDING_APPROVAL;
    await tx.expense.update({ where: { id: params.expenseId }, data: { status } });
    return status;
  }

  // Reverses enterExpenseApproval() when a match is undone (BankMatchingService.
  // unmatch) before the Expense finished its chain. Clears the stale request's
  // steps only - the request row and its ApprovalAction history stay, same as
  // createOrResetRequest's resubmit branch - so re-matching later just resolves
  // fresh steps onto the same request instead of losing the rejection/action trail.
  async cancelExpenseApproval(tx: Prisma.TransactionClient, expenseId: string): Promise<void> {
    const request = await tx.approvalRequest.findFirst({ where: { expenseId } });
    if (!request) return;
    await tx.approvalRequestStep.deleteMany({ where: { approvalRequestId: request.id } });
    await tx.expense.update({ where: { id: expenseId }, data: { status: ExpenseStatus.DRAFT } });
  }

  async approve(
    actorId: string,
    target: { expenseId?: string; eventId?: string },
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.approvalRequest.findFirst({
        where: target.expenseId ? { expenseId: target.expenseId } : { eventId: target.eventId },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
      if (!request) throw new NotFoundException('Approval request not found');
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');

      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      // Admin override: acts as any approver on any step, for oversight/unblocking.
      if (step.resolvedApproverId !== actorId && !actorRoles.includes('ADMIN')) {
        await this.assertApprovalOverride(tx, actorId, target, actorPermissions);
      }

      await tx.approvalRequestStep.update({ where: { id: step.id }, data: { status: ApprovalStepStatus.APPROVED } });
      await tx.approvalAction.create({
        data: { approvalRequestId: request.id, actorId, positionId: step.positionId, action: ApprovalActionType.APPROVE },
      });

      const nextStep = request.currentStep + 1;
      const isFinalStep = nextStep >= request.steps.length;

      const updated = await tx.approvalRequest.update({
        where: { id: request.id },
        data: { currentStep: nextStep, status: isFinalStep ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING },
        include: requestInclude,
      });

      const nextStepRow = updated.steps.find((s) => s.stepOrder === nextStep);
      if (!isFinalStep && nextStepRow) {
        await this.notifyStep(tx, { documentStage: updated.documentStage, expenseId: target.expenseId, eventId: target.eventId, step: nextStepRow });
      }

      let expense = null;
      let event = null;
      if (target.expenseId) {
        // Final step settles directly - no manual Finance settle step in this app.
        // A non-final step's Expense.status names the tier now reviewing it.
        const nextStatus = isFinalStep
          ? ExpenseStatus.SETTLED
          : this.pendingStatusForPosition(nextStepRow?.position.code ?? '');
        expense = await tx.expense.update({
          where: { id: target.expenseId },
          data: { status: nextStatus },
        });
      } else if (target.eventId && isFinalStep) {
        event = await tx.event.update({ where: { id: target.eventId }, data: { status: EventStatus.APPROVED } });
      }

      await this.audit.log({
        userId: actorId,
        action: 'APPROVE',
        objectType: target.expenseId ? 'Expense' : 'Event',
        objectId: (target.expenseId ?? target.eventId) as string,
        newValue: { step: request.currentStep, position: step.positionId, finalStep: isFinalStep },
      });

      return { approvalRequest: updated, expense, event };
    });
  }

  async reject(
    actorId: string,
    target: { expenseId?: string; eventId?: string },
    reason: string,
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.approvalRequest.findFirst({
        where: target.expenseId ? { expenseId: target.expenseId } : { eventId: target.eventId },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
      if (!request) throw new NotFoundException('Approval request not found');
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');

      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      // Admin override: acts as any approver on any step, for oversight/unblocking.
      if (step.resolvedApproverId !== actorId && !actorRoles.includes('ADMIN')) {
        await this.assertApprovalOverride(tx, actorId, target, actorPermissions);
      }

      await tx.approvalRequestStep.update({ where: { id: step.id }, data: { status: ApprovalStepStatus.REJECTED } });
      await tx.approvalAction.create({
        data: { approvalRequestId: request.id, actorId, positionId: step.positionId, action: ApprovalActionType.REJECT, reason },
      });

      const updated = await tx.approvalRequest.update({
        where: { id: request.id },
        data: { status: ApprovalStatus.REJECTED },
        include: requestInclude,
      });

      let expense = null;
      let event = null;
      if (target.expenseId) {
        expense = await tx.expense.update({ where: { id: target.expenseId }, data: { status: ExpenseStatus.REJECTED } });
      } else if (target.eventId) {
        event = await tx.event.update({ where: { id: target.eventId }, data: { status: EventStatus.REJECTED, rejectReason: reason } });
      }

      await this.audit.log({
        userId: actorId,
        action: 'REJECT',
        objectType: target.expenseId ? 'Expense' : 'Event',
        objectId: (target.expenseId ?? target.eventId) as string,
        newValue: { position: step.positionId, reason },
      });

      return { approvalRequest: updated, expense, event };
    });
  }
}

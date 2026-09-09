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
  SettlementStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EmailService } from '../email/email.service';
import { ExternalSyncService } from '../external-sync/external-sync.service';
import { CreateApprovalLevelDto, UpdateApprovalLevelDto } from './dto/approval-level.dto';

type ApprovalLevelWithSteps = ApprovalLevel & {
  steps: (ApprovalLevelStep & { position: Position })[];
  department: { name: string } | null;
};

const levelInclude = {
  steps: { include: { position: true }, orderBy: { stepOrder: 'asc' as const } },
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
 * an amount range, plus optionally a Department, and defines an ordered
 * chain of Positions (e.g. Head -> Supervisor). At submit time every step is
 * resolved to a concrete User up front - if any step can't be resolved (no one
 * holds that Position for the relevant Department), the submit is blocked
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
    private readonly externalSync: ExternalSyncService,
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
    params: { documentStage: DocumentStage; departmentId?: string; amount: number },
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
      if (level.scopeType === ApprovalScopeType.DEPARTMENT) return !!params.departmentId && level.departmentId === params.departmentId;
      return true; // ANY
    });

    if (matches.length === 0) return null;

    // Scope precedence: DEPARTMENT exact-match > ANY; ties broken by
    // most-recently-updated (admin responsibility to avoid overlapping ranges).
    const rank = (l: (typeof matches)[number]) => (l.scopeType === ApprovalScopeType.DEPARTMENT ? 0 : 1);
    matches.sort((a, b) => rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime());
    return matches[0];
  }

  private async resolveApprover(tx: Prisma.TransactionClient, level: ApprovalLevelWithSteps, positionId: string) {
    if (level.scopeType === ApprovalScopeType.DEPARTMENT) {
      const assignment = await tx.departmentPositionAssignment.findUnique({
        where: { departmentId_positionId: { departmentId: level.departmentId as string, positionId } },
        include: { user: true },
      });
      return assignment && assignment.status === 'ACTIVE' && assignment.user.status === 'ACTIVE' ? assignment.user : null;
    }
    // ANY scope: not tied to a specific Department, so any active holder of the Position qualifies.
    return tx.user.findFirst({ where: { positionId, status: 'ACTIVE' }, orderBy: { employeeId: 'asc' } });
  }

  // ---- Approval Request lifecycle (bound 1:1 to an Expense OR an Event) ----

  async createOrResetRequest(
    tx: Prisma.TransactionClient,
    params: {
      documentStage: DocumentStage;
      expenseId?: string;
      eventId?: string;
      settlementId?: string;
      amount: Prisma.Decimal | number;
      departmentId?: string | null;
    },
  ) {
    const amountNum = Number(params.amount);
    const level = await this.resolveApprovalLevel(tx, {
      documentStage: params.documentStage,
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
        const scopeLabel = level.scopeType === ApprovalScopeType.DEPARTMENT ? `Department "${level.department?.name}"` : 'the organization';
        missing.push(`no user assigned as "${step.position.name}" for ${scopeLabel}`);
      } else {
        resolvedSteps.push({ stepOrder: step.stepOrder, positionId: step.positionId, resolvedApproverId: approver.id, status: ApprovalStepStatus.PENDING });
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot submit: ${missing.join('; ')} - ask an Admin to configure this under Department -> Approvers before submitting.`,
      );
    }

    const existing = await tx.approvalRequest.findFirst({
      where: params.expenseId
        ? { expenseId: params.expenseId }
        : params.eventId
        ? { eventId: params.eventId }
        : { settlementId: params.settlementId },
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
            settlementId: params.settlementId,
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
    // Settlement-stage requests hang off a Settlement, not an Expense/Event, and
    // resolveDocInfo only knows how to describe those two - skip the email (and
    // its one-click token) rather than fail the transaction over a best-effort
    // notification. The Approvals UI is the path for that document type.
    if (!params.expenseId && !params.eventId) return;
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

  // Besides steps assigned to the actor, expense.approve.all / expense.approve.owndept
  // (Role/Permission master) surface every other pending Expense step the actor is
  // allowed to override via assertApprovalOverride() - otherwise a permission holder
  // would have no way to even find something to approve. approval.read.all /
  // approval.read.owndept is the read-only counterpart (e.g. HEAD_POD/Management
  // wanting to monitor the pipeline) - it surfaces every step in scope regardless
  // of turn, but grants no override: approve()/reject() still only checks
  // resolvedApproverId, so a read-scoped viewer never gets action buttons
  // (see ExpenseDetailScreen's canApprove on the mobile side).
  async findPendingFor(
    actorId: string,
    actorPermissions: string[] = [],
    filter?: { departmentId?: string; fromDate?: string; toDate?: string },
  ) {
    // BOD is (almost always) the last step in a chain - being able to see an
    // Expense that's still stuck on an earlier approver's turn, before it's
    // BOD's own turn, lets a BOD user monitor the pipeline without being able
    // to act on it yet (the caller-must-be-currentStep's-resolvedApprover
    // check in approve()/reject() still gates the actual action).
    const actorPosition = await this.prisma.user.findUnique({ where: { id: actorId }, select: { position: { select: { code: true } } } });
    const isBod = actorPosition?.position?.code === 'BOD';
    const canReadAll = actorPermissions.includes('approval.read.all');
    const canReadOwnDept = actorPermissions.includes('approval.read.owndept');

    const orConditions: Prisma.ApprovalRequestStepWhereInput[] = [{ resolvedApproverId: actorId }];

    if (actorPermissions.includes('expense.approve.all')) {
      orConditions.push({ approvalRequest: { expenseId: { not: null } } });
    } else if (actorPermissions.includes('expense.approve.owndept')) {
      const ownDepartmentIds = await this.getActorDepartmentIds(this.prisma, actorId);
      if (ownDepartmentIds.length > 0) {
        orConditions.push({ approvalRequest: { expense: { departmentId: { in: ownDepartmentIds } } } });
      }
    }

    let readDepartmentIds: string[] = [];
    if (canReadAll) {
      orConditions.push({ approvalRequest: { expenseId: { not: null } } });
    } else if (canReadOwnDept) {
      readDepartmentIds = await this.getActorDepartmentIds(this.prisma, actorId);
      if (readDepartmentIds.length > 0) {
        orConditions.push({ approvalRequest: { expense: { departmentId: { in: readDepartmentIds } } } });
      }
    }

    // Department/date filters only ever apply to Expense-type approval rows
    // (Event/Pre-Event is a retired flow) - only added to the where clause
    // when actually supplied, so Event rows keep showing up when neither
    // filter is in use.
    const hasExpenseFilter = !!(filter?.departmentId || filter?.fromDate || filter?.toDate);
    const expenseFilter: Prisma.ExpenseWhereInput = {
      departmentId: filter?.departmentId || undefined,
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
            expense: { include: { sales: { select: { id: true, name: true } }, unit: true, department: true, advertiser: true, brand: true } },
            event: { include: { sales: { select: { id: true, name: true } }, unit: true, advertiser: true, brand: true } },
            // DocumentStage.SETTLEMENT rows hang off the batch, which is what
            // that tier reviews - the Approvals UI drills from here into the
            // batch's Expense list (GET /settlements/:id).
            settlement: {
              include: {
                department: true,
                createdBy: { select: { id: true, name: true } },
                expenses: { select: { id: true } },
              },
            },
            steps: {
              include: { position: true, resolvedApprover: { select: { id: true, name: true } } },
              orderBy: { stepOrder: 'asc' },
            },
          },
        },
      },
      // Ascending so the dedupe below keeps each request's earliest (closest to
      // current/actionable) matching step, not whatever order Postgres happens
      // to return - matters once a read-scope actor can match every step of a
      // multi-step chain at once, not just their own single step.
      orderBy: { stepOrder: 'asc' },
    });
    const seen = new Set<string>();
    return steps
      .filter((s) => s.approvalRequest.status === ApprovalStatus.PENDING)
      .filter((s) => {
        const isMyTurn = s.stepOrder === s.approvalRequest.currentStep;
        if (isMyTurn) return true;
        // BOD and a read-scope permission holder (approval.read.all/owndept)
        // both get lookahead - the whole chain, not just what's actionable
        // right now - but BOD's lookahead is limited to chains where they're
        // actually a future approver, matching their resolvedApproverId.
        if (isBod && s.resolvedApproverId === actorId) return true;
        if (canReadAll) return true;
        if (canReadOwnDept) {
          const deptId = s.approvalRequest.expense?.departmentId;
          return !!deptId && readDepartmentIds.includes(deptId);
        }
        return false;
      })
      .filter((s) => (seen.has(s.approvalRequestId) ? false : seen.add(s.approvalRequestId)))
      // isMyTurn must be actor-relative, not just "this is the chain's active
      // step" - a department/all read-or-approve-override permission holder
      // (approval.read.*/expense.approve.*) can match a step that's currently
      // active but resolved to someone else entirely (e.g. a HEAD_POD who
      // already acted on their own step 0 still matches step 1 by Department,
      // even though step 1 is CO-CSO-1's turn, not theirs). Without the
      // resolvedApproverId check here, that row wrongly reports isMyTurn:true -
      // ApprovalsListScreen then renders it as fully actionable (no "Waiting"
      // dim) even though ExpenseDetailScreen's canApprove (a direct
      // resolvedApproverId === user.id check) correctly shows no buttons for
      // it, leaving a confusing mismatch between the list and the detail page.
      .map((s) => ({ ...s.approvalRequest, isMyTurn: s.stepOrder === s.approvalRequest.currentStep && s.resolvedApproverId === actorId }));
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

  // Lets expense.approve.all / expense.approve.owndept (Role/Permission master)
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
    if (actorPermissions.includes('expense.approve.owndept') && target.expenseId) {
      const expense = await tx.expense.findUnique({ where: { id: target.expenseId }, select: { departmentId: true } });
      if (expense?.departmentId) {
        const ownDepartmentIds = await this.getActorDepartmentIds(tx, actorId);
        if (ownDepartmentIds.includes(expense.departmentId)) {
          return;
        }
      }
    }
    throw new ForbiddenException('You are not the assigned approver for this step');
  }

  // A user's "own Department(s)": their own User.departmentId covers a Sales/
  // Sales Admin belonging to a Department, DepartmentPositionAssignment covers
  // a Supervisor holding an approval position for a Department.
  private async getActorDepartmentIds(tx: Prisma.TransactionClient, actorId: string): Promise<string[]> {
    const [user, assignments] = await Promise.all([
      tx.user.findUnique({ where: { id: actorId }, select: { departmentId: true } }),
      tx.departmentPositionAssignment.findMany({ where: { userId: actorId, status: 'ACTIVE' }, select: { departmentId: true } }),
    ]);
    const ids = new Set(assignments.map((a) => a.departmentId));
    if (user?.departmentId) ids.add(user.departmentId);
    return Array.from(ids);
  }

  // Expense.status mirrors whichever approval tier is currently reviewing it - one
  // value per Position.code in today's master data (see prisma/schema.prisma
  // ExpenseStatus enum). Position codes are free text and several carry "-"
  // (CO-CSO-1), which a Prisma enum value can't, so normalise to "_" first.
  // Falls back to the generic PENDING_APPROVAL for a Position that doesn't have
  // a matching status yet (e.g. one an Admin just created).
  private pendingStatusForPosition(positionCode: string): ExpenseStatus {
    const key = `APPROVAL_${positionCode.replace(/-/g, '_')}`;
    return key in ExpenseStatus ? (ExpenseStatus as unknown as Record<string, ExpenseStatus>)[key] : ExpenseStatus.PENDING_APPROVAL;
  }

  // Entry point into the Expense approval chain (HEAD_POD -> CO-CSO-1 ->
  // CO-CSO-2), entered the moment the Expense is created - there is no DRAFT
  // state outside the workflow and no separate Submit. Also used by
  // ExpensesService.update() to re-enter the chain when a REJECTED Expense is
  // edited.
  async enterExpenseApproval(
    tx: Prisma.TransactionClient,
    params: { expenseId: string; amount: Prisma.Decimal | number; departmentId?: string | null },
  ): Promise<ExpenseStatus> {
    const request = await this.createOrResetRequest(tx, {
      documentStage: DocumentStage.EXPENSES,
      expenseId: params.expenseId,
      amount: params.amount,
      departmentId: params.departmentId,
    });
    const step0 = request.steps.find((s) => s.stepOrder === 0);
    const status = step0 ? this.pendingStatusForPosition(step0.position.code) : ExpenseStatus.PENDING_APPROVAL;
    await tx.expense.update({ where: { id: params.expenseId }, data: { status } });
    return status;
  }

  // ---- Settlement chain (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV) ----
  //
  // Unlike the Expense chain, a tier here does not advance per Expense: the
  // tier's approver reviews each member Expense individually (reviewExpense
  // below), then presses one Submit on the Settlement to close the tier and move
  // the whole batch on (submitCurrentTier). The Settlement and its Expenses
  // always carry the same tier in their status.

  // Entered when the Settlement is created (or when Expenses are added to one
  // that has not started yet) - scope is ANY, so each Position's sole active
  // holder resolves directly, no DepartmentPositionAssignment needed.
  async enterSettlementApproval(
    tx: Prisma.TransactionClient,
    params: { settlementId: string; amount: Prisma.Decimal | number },
  ): Promise<SettlementStatus> {
    const request = await this.createOrResetRequest(tx, {
      documentStage: DocumentStage.SETTLEMENT,
      settlementId: params.settlementId,
      amount: params.amount,
    });
    const step0 = request.steps.find((s) => s.stepOrder === 0);
    return this.applyTierStatus(tx, params.settlementId, step0?.position.code ?? '');
  }

  // Re-applies the tier a Settlement is currently on - used when Expenses are
  // added to a batch that is already part-way through its chain, so they pick up
  // the same status as the rest instead of keeping READY_TO_SETTLED.
  async applySettlementTierStatus(tx: Prisma.TransactionClient, settlementId: string, stepOrder: number): Promise<void> {
    const request = await this.findSettlementRequest(tx, settlementId);
    const step = request.steps.find((s) => s.stepOrder === stepOrder);
    if (!step) return;
    await this.applyTierStatus(tx, settlementId, step.position.code);
  }

  // Pushes one tier's status onto the Settlement and every Expense still in it,
  // so both always name the tier currently reviewing the batch.
  private async applyTierStatus(tx: Prisma.TransactionClient, settlementId: string, positionCode: string): Promise<SettlementStatus> {
    const key = `APPROVAL_${positionCode.replace(/-/g, '_')}`;
    const settlementStatus = key in SettlementStatus ? (SettlementStatus as unknown as Record<string, SettlementStatus>)[key] : SettlementStatus.DRAFT;
    const expenseStatus = this.pendingStatusForPosition(positionCode);
    await tx.settlement.update({ where: { id: settlementId }, data: { status: settlementStatus } });
    await tx.expense.updateMany({ where: { settlementId }, data: { status: expenseStatus } });
    return settlementStatus;
  }

  async findSettlementRequest(tx: Prisma.TransactionClient, settlementId: string) {
    const request = await tx.approvalRequest.findFirst({
      where: { settlementId },
      include: { steps: { include: { position: true }, orderBy: { stepOrder: 'asc' } } },
    });
    if (!request) throw new NotFoundException('This settlement has no approval request');
    return request;
  }

  // The current tier's approver signing off on one member Expense. Recorded on
  // the Expense (settlementApprovedStep) rather than advancing anything - the
  // batch only moves when that approver presses Submit.
  async reviewSettlementExpense(
    params: { settlementId: string; expenseId: string; approve: boolean; reason?: string },
    actor: { userId: string; roles: string[] },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.findSettlementRequest(tx, params.settlementId);
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');
      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      if (step.resolvedApproverId !== actor.userId && !actor.roles.includes('ADMIN')) {
        throw new ForbiddenException('You are not the assigned approver for this step');
      }

      const expense = await tx.expense.findUniqueOrThrow({
        where: { id: params.expenseId },
        select: { id: true, expenseNo: true, settlementId: true, amount: true },
      });
      if (expense.settlementId !== params.settlementId) {
        throw new BadRequestException(`${expense.expenseNo} is not part of this settlement`);
      }

      await tx.approvalAction.create({
        data: {
          approvalRequestId: request.id,
          actorId: actor.userId,
          positionId: step.positionId,
          action: params.approve ? ApprovalActionType.APPROVE : ApprovalActionType.REJECT,
          reason: params.approve ? `Expense ${expense.expenseNo}` : `Expense ${expense.expenseNo}: ${params.reason ?? ''}`,
        },
      });

      if (params.approve) {
        await tx.expense.update({ where: { id: expense.id }, data: { settlementApprovedStep: request.currentStep } });
      } else {
        // A rejected Expense leaves the batch instead of failing it - the
        // Settlement carries on with whatever is left, minus this amount.
        await tx.expense.update({
          where: { id: expense.id },
          data: { status: ExpenseStatus.REJECTED, settlementId: null, settlementApprovedStep: null },
        });
        const settlement = await tx.settlement.findUniqueOrThrow({ where: { id: params.settlementId }, select: { totalAmount: true } });
        await tx.settlement.update({
          where: { id: params.settlementId },
          data: { totalAmount: Number(settlement.totalAmount) - Number(expense.amount) },
        });
      }

      await this.audit.log({
        userId: actor.userId,
        action: params.approve ? 'APPROVE' : 'REJECT',
        objectType: 'Expense',
        objectId: expense.id,
        newValue: { settlementId: params.settlementId, tier: request.currentStep, position: step.positionId, reason: params.reason },
      });

      return tx.expense.findUniqueOrThrow({ where: { id: expense.id } });
    });
  }

  // The Submit button on a Settlement: closes the current tier and moves the
  // whole batch to the next one (or to COMPLETE, which pushes it to the external
  // system). Every remaining member Expense must have been reviewed at this tier
  // first, so Submit can never wave through something nobody looked at.
  async submitSettlementTier(settlementId: string, actor: { userId: string; roles: string[] }) {
    const result = await this.prisma.$transaction(async (tx) => {
      const request = await this.findSettlementRequest(tx, settlementId);
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');
      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      if (step.resolvedApproverId !== actor.userId && !actor.roles.includes('ADMIN')) {
        throw new ForbiddenException('You are not the assigned approver for this step');
      }

      const expenses = await tx.expense.findMany({
        where: { settlementId },
        select: { id: true, expenseNo: true, settlementApprovedStep: true },
      });
      if (expenses.length === 0) throw new BadRequestException('This settlement has no expenses left to submit');
      const unreviewed = expenses.filter((e) => (e.settlementApprovedStep ?? -1) < request.currentStep);
      if (unreviewed.length > 0) {
        throw new BadRequestException(`Approve or reject every expense first - still pending: ${unreviewed.map((e) => e.expenseNo).join(', ')}`);
      }

      await tx.approvalRequestStep.update({ where: { id: step.id }, data: { status: ApprovalStepStatus.APPROVED } });

      const nextStep = request.currentStep + 1;
      const isFinalStep = nextStep >= request.steps.length;
      await tx.approvalRequest.update({
        where: { id: request.id },
        data: { currentStep: nextStep, status: isFinalStep ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING },
      });

      if (isFinalStep) {
        await tx.settlement.update({ where: { id: settlementId }, data: { status: SettlementStatus.COMPLETE } });
        await tx.expense.updateMany({ where: { settlementId }, data: { status: ExpenseStatus.COMPLETE } });
      } else {
        const nextStepRow = request.steps.find((s) => s.stepOrder === nextStep);
        await this.applyTierStatus(tx, settlementId, nextStepRow?.position.code ?? '');
      }

      await this.audit.log({
        userId: actor.userId,
        action: 'SUBMIT',
        objectType: 'Settlement',
        objectId: settlementId,
        newValue: { tier: request.currentStep, position: step.positionId, finalStep: isFinalStep },
      });

      return { isFinalStep };
    });

    if (result.isFinalStep) {
      await this.externalSync.pushSettlement(settlementId);
    }
    return this.prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
  }


  async approve(
    actorId: string,
    target: { expenseId?: string; eventId?: string },
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
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
        // Terminal of this chain is READY_TO_MATCHING: approved, now waiting for
        // Sales Admin to bank-match it. The Settlement tier that follows is a
        // separate chain on the Settlement itself, not on the Expense.
        const nextStatus = isFinalStep
          ? ExpenseStatus.READY_TO_MATCHING
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
        newValue: { step: request.currentStep, position: step.positionId, finalStep: isFinalStep, documentStage: request.documentStage },
      });

      return { approvalRequest: updated, expense, event };
    });

    return result;
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
        newValue: { position: step.positionId, reason, documentStage: request.documentStage },
      });

      return { approvalRequest: updated, expense, event };
    });
  }
}

import { randomBytes } from 'crypto';
import { clientLabel } from '../expense-requests/client-label';
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
  ExpenseRequestStatus,
  ExpenseStatus,
  Position,
  Prisma,
  SettlementStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { canCompletePendingSalesAdmin, getActorDepartmentIds } from '../common/rbac/scope.util';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateApprovalLevelDto, UpdateApprovalLevelDto } from './dto/approval-level.dto';

type ApprovalLevelWithSteps = ApprovalLevel & {
  steps: (ApprovalLevelStep & { position: Position })[];
  departments: { departmentId: string; department: { name: string } }[];
  requestorPositions: { positionId: string; position: { name: string } }[];
  activityTypes: { activityTypeId: string; activityType: { name: string } }[];
};

// Position of the Expense Request budget stage (see ExpenseRequestsService.setBudget).
const POSITION_SALES_CS = 'SLS-CS';
const POSITION_SALES_ADMIN = 'SLSADM';
const POSITION_CORSEC = 'CORSEC';

const levelInclude = {
  steps: { include: { position: true }, orderBy: { stepOrder: 'asc' as const } },
  departments: { include: { department: true } },
  requestorPositions: { include: { position: true } },
  activityTypes: { include: { activityType: true } },
};

export type RollbackDocType = 'EXPENSE' | 'SETTLEMENT' | 'EXPENSE_REQUEST';

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
    private readonly notifications: NotificationsService,
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
        departments: { create: (dto.departmentIds ?? []).map((departmentId) => ({ departmentId })) },
        requestorPositions: { create: (dto.requestorPositionIds ?? []).map((positionId) => ({ positionId })) },
        activityTypes: { create: (dto.activityTypeIds ?? []).map((activityTypeId) => ({ activityTypeId })) },
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
      if (dto.departmentIds) {
        await tx.approvalLevelDepartment.deleteMany({ where: { approvalLevelId: id } });
      }
      if (dto.activityTypeIds) {
        await tx.approvalLevelActivityType.deleteMany({ where: { approvalLevelId: id } });
      }
      if (dto.requestorPositionIds) {
        await tx.approvalLevelRequestorPosition.deleteMany({ where: { approvalLevelId: id } });
      }
      return tx.approvalLevel.update({
        where: { id },
        data: {
          name: dto.name,
          scopeType: dto.scopeType,
          departments: dto.departmentIds ? { create: dto.departmentIds.map((departmentId) => ({ departmentId })) } : undefined,
          requestorPositions: dto.requestorPositionIds
            ? { create: dto.requestorPositionIds.map((positionId) => ({ positionId })) }
            : undefined,
          // [] clears the filter (any activity type); undefined leaves it untouched.
          activityTypes: dto.activityTypeIds ? { create: dto.activityTypeIds.map((activityTypeId) => ({ activityTypeId })) } : undefined,
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
    params: {
      documentStage: DocumentStage;
      departmentId?: string;
      amount: number;
      requestorPositionId?: string;
      activityTypeId?: string;
      // Ignore Levels' requestorPositions filter (the requestor isn't known/relevant, e.g. the
      // Expense-side "was this pre-approved by an Expense Request Level" check).
      ignoreRequestor?: boolean;
    },
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
      if (level.scopeType === ApprovalScopeType.DEPARTMENT) {
        if (!params.departmentId || !level.departments.some((d) => d.departmentId === params.departmentId)) return false;
      }
      // requestorPositions is an independent filter on top of scopeType - a Level
      // with none configured matches any requestor (backward compatible).
      if (level.activityTypes.length > 0 && !level.activityTypes.some((a) => a.activityTypeId === params.activityTypeId)) return false;
      if (level.requestorPositions.length > 0 && !params.ignoreRequestor) {
        if (!params.requestorPositionId || !level.requestorPositions.some((p) => p.positionId === params.requestorPositionId)) {
          return false;
        }
      }
      return true;
    });

    if (matches.length === 0) return null;

    // Precedence: activity-type-scoped > requestor-scoped + DEPARTMENT exact-match >
    // requestor-scoped only > DEPARTMENT only > ANY; ties broken by most-recently-updated
    // (admin responsibility to avoid overlapping ranges).
    const rank = (l: (typeof matches)[number]) => {
      const activity = l.activityTypes.length > 0 ? 0 : 1;
      const dept = l.scopeType === ApprovalScopeType.DEPARTMENT ? 0 : 1;
      const requestor = l.requestorPositions.length > 0 ? 0 : 1;
      return activity * 4 + dept * 2 + requestor;
    };
    matches.sort((a, b) => rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime());
    return matches[0];
  }

  // Expense.sales / Event.sales / Settlement.createdBy is "the requestor" whose
  // Position an ApprovalLevel.requestorPositions filter is matched against.
  private async resolveRequestorPositionId(
    tx: Prisma.TransactionClient,
    params: { expenseId?: string; eventId?: string; settlementId?: string; expenseRequestId?: string },
  ): Promise<string | undefined> {
    if (params.expenseRequestId) {
      const request = await tx.expenseRequest.findUnique({
        where: { id: params.expenseRequestId },
        select: { requestedBy: { select: { positionId: true } } },
      });
      return request?.requestedBy.positionId ?? undefined;
    }
    if (params.expenseId) {
      const expense = await tx.expense.findUnique({ where: { id: params.expenseId }, select: { sales: { select: { positionId: true } } } });
      return expense?.sales.positionId ?? undefined;
    }
    if (params.eventId) {
      const event = await tx.event.findUnique({ where: { id: params.eventId }, select: { sales: { select: { positionId: true } } } });
      return event?.sales.positionId ?? undefined;
    }
    if (params.settlementId) {
      const settlement = await tx.settlement.findUnique({
        where: { id: params.settlementId },
        select: { createdBy: { select: { positionId: true } } },
      });
      return settlement?.createdBy.positionId ?? undefined;
    }
    return undefined;
  }

  // documentDepartmentId is the actual Expense/Event/Settlement's own Department,
  // not "the Level's Department" - a DEPARTMENT-scope Level can span several (see
  // ApprovalLevel comment in schema.prisma), so each step still resolves against
  // one concrete Department's DepartmentPositionAssignment row.
  private async resolveApprover(tx: Prisma.TransactionClient, level: ApprovalLevelWithSteps, positionId: string, documentDepartmentId?: string) {
    if (level.scopeType === ApprovalScopeType.DEPARTMENT) {
      const assignment = await tx.departmentPositionAssignment.findUnique({
        where: { departmentId_positionId: { departmentId: documentDepartmentId as string, positionId } },
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
      expenseRequestId?: string;
      amount: Prisma.Decimal | number;
      departmentId?: string | null;
      activityTypeId?: string | null;
      // Caller is about to act on step 0 itself (see enterSalesAdminStage), so mailing its approver would be noise.
      skipNotify?: boolean;
    },
  ) {
    const amountNum = Number(params.amount);
    const requestorPositionId = await this.resolveRequestorPositionId(tx, {
      expenseId: params.expenseId,
      eventId: params.eventId,
      settlementId: params.settlementId,
      expenseRequestId: params.expenseRequestId,
    });
    const level = await this.resolveApprovalLevel(tx, {
      documentStage: params.documentStage,
      departmentId: params.departmentId ?? undefined,
      amount: amountNum,
      requestorPositionId,
      activityTypeId: params.activityTypeId ?? undefined,
      // An Expense Request is keyed in by Sales Admin (or any request.expense.create.owndept
      // holder) on behalf of the requesting Sales/Staff, so the entering user's Position says
      // nothing about which Level applies - Department + Activity Type do the scoping.
      ignoreRequestor: params.documentStage === DocumentStage.EXPENSE_REQUEST,
    });
    if (!level) {
      throw new BadRequestException(
        `No Approval Level configured for ${params.documentStage} at amount ${amountNum}. Ask an Admin to configure one under Approval Levels.`,
      );
    }

    const missing: string[] = [];
    const resolvedSteps: { stepOrder: number; positionId: string; resolvedApproverId: string; status: ApprovalStepStatus }[] = [];
    for (const step of level.steps) {
      const approver = await this.resolveApprover(tx, level, step.positionId, params.departmentId ?? undefined);
      if (!approver) {
        const scopeLabel =
          level.scopeType === ApprovalScopeType.DEPARTMENT
            ? `Department "${level.departments.find((d) => d.departmentId === params.departmentId)?.department.name ?? params.departmentId}"`
            : 'the organization';
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
        : params.expenseRequestId
        ? { expenseRequestId: params.expenseRequestId }
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
            expenseRequestId: params.expenseRequestId,
            approvalLevelId: level.id,
            currentStep: 0,
            status: ApprovalStatus.PENDING,
            steps: { create: resolvedSteps },
          },
          include: requestInclude,
        });

    const step0 = request.steps.find((s) => s.stepOrder === 0);
    if (step0 && !params.skipNotify) {
      await this.notifyStep(tx, {
        documentStage: params.documentStage,
        expenseId: params.expenseId,
        eventId: params.eventId,
        settlementId: params.settlementId,
        expenseRequestId: params.expenseRequestId,
        step: step0,
      });
    }
    return request;
  }

  // ---- Approval-via-email (one-click token links for Expense/Event; a plain
  // deep-link notice for Settlement - see notifyStep) ----

  private async resolveDocInfo(tx: Prisma.TransactionClient, target: { expenseId?: string; eventId?: string }) {
    if (target.expenseId) {
      const e = await tx.expense.findUniqueOrThrow({ where: { id: target.expenseId }, include: { sales: true } });
      return { docNo: e.expenseNo, salesName: e.sales.name, purpose: e.purpose, amount: e.amount };
    }
    const e = await tx.event.findUniqueOrThrow({ where: { id: target.eventId as string }, include: { sales: true } });
    return { docNo: e.eventNo, salesName: e.sales.name, purpose: e.purpose, amount: e.estimatedAmount };
  }

  private async resolveSettlementInfo(tx: Prisma.TransactionClient, settlementId: string) {
    const s = await tx.settlement.findUniqueOrThrow({
      where: { id: settlementId },
      include: {
        createdBy: true,
        department: true,
        expenses: { include: { sales: true }, orderBy: { expenseDate: 'asc' } },
      },
    });
    return {
      settlementNo: s.settlementNo,
      createdByName: s.createdBy.name,
      departmentName: s.department.name,
      totalAmount: s.totalAmount,
      expenses: s.expenses.map((e) => ({ expenseNo: e.expenseNo, salesName: e.sales.name, purpose: e.purpose, amount: e.amount })),
    };
  }

  private async issueStepToken(tx: Prisma.TransactionClient, stepId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const ttlDays = Number(this.config.get<string>('APPROVAL_EMAIL_TOKEN_TTL_DAYS')) || 7;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await tx.approvalRequestStep.update({ where: { id: stepId }, data: { emailToken: token, emailTokenExpiresAt: expiresAt } });
    return token;
  }

  // Mails the current step's approver, then records the same event in-app +
  // push (NotificationsService). Both are best-effort: a failure here is
  // logged but never blocks or fails the approval workflow itself.
  //
  // Expense/Event get a one-click Approve link plus a Reject link (which opens
  // a small reason-entry page - a reject reason is required and can't be
  // captured from a bare GET link). Settlement does NOT get a one-click link:
  // a Settlement tier requires the approver to review every member Expense
  // individually before submitting the whole batch (submitSettlementTier
  // below), so a blind email click can't stand in for that - the email just
  // deep-links into the settlement (mobile app via App Link if installed,
  // web app otherwise) for the approver to review normally.
  private async notifyStep(
    tx: Prisma.TransactionClient,
    params: {
      documentStage: DocumentStage;
      expenseId?: string;
      eventId?: string;
      settlementId?: string;
      expenseRequestId?: string;
      step: { id: string; positionId: string; resolvedApproverId: string };
    },
  ) {
    const appBase = this.config.get<string>('APP_PUBLIC_URL') || 'http://localhost:3001';

    if (params.settlementId) {
      const settlementId = params.settlementId;
      try {
        const [settlement, approver, position] = await Promise.all([
          this.resolveSettlementInfo(tx, settlementId),
          tx.user.findUniqueOrThrow({ where: { id: params.step.resolvedApproverId } }),
          tx.position.findUniqueOrThrow({ where: { id: params.step.positionId } }),
        ]);
        const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
        await this.email.sendSettlementApprovalNotice({
          to: approver.email,
          approverName: approver.name,
          positionName: position.name,
          settlementNo: settlement.settlementNo,
          departmentName: settlement.departmentName,
          createdByName: settlement.createdByName,
          totalAmount: currency.format(Number(settlement.totalAmount)),
          openUrl: `${appBase}/settlement?open=${settlementId}`,
          expenses: settlement.expenses.map((e) => ({
            expenseNo: e.expenseNo,
            salesName: e.salesName,
            purpose: e.purpose,
            amount: currency.format(Number(e.amount)),
          })),
        });
      } catch (err) {
        this.logger.warn(`Failed to send settlement approval email: ${(err as Error).message}`);
      }
      await this.notifications.notify({
        userId: params.step.resolvedApproverId,
        type: 'SETTLEMENT_PENDING',
        title: 'Settlement awaiting your approval',
        body: `A settlement batch needs your review.`,
        deepLink: `/settlement?open=${settlementId}`,
        objectType: 'Settlement',
        objectId: settlementId,
      });
      return;
    }

    // Expense Request has no amount at approval time and no one-click email
    // link (the reject reason page is Expense/Event-only) - in-app + push only.
    if (params.expenseRequestId) {
      const request = await tx.expenseRequest.findUniqueOrThrow({ where: { id: params.expenseRequestId }, include: { activityType: true, advertisers: { include: { advertiser: { select: { name: true } } } }, agencies: { include: { agency: { select: { name: true } } } } } });
      await this.notifications.notify({
        userId: params.step.resolvedApproverId,
        type: 'EXPENSE_REQUEST_PENDING',
        title: 'Expense Request awaiting your approval',
        body: `${request.requestNo} (${request.activityType.name} - ${clientLabel(request)}) needs your review.`,
        deepLink: '/expense-requests',
        objectType: 'ExpenseRequest',
        objectId: request.id,
      });
      return;
    }

    try {
      const [doc, approver, position, token] = await Promise.all([
        this.resolveDocInfo(tx, params),
        tx.user.findUniqueOrThrow({ where: { id: params.step.resolvedApproverId } }),
        tx.position.findUniqueOrThrow({ where: { id: params.step.positionId } }),
        this.issueStepToken(tx, params.step.id),
      ]);
      const apiBase = this.config.get<string>('API_PUBLIC_URL') || 'http://localhost:3000/api/v1';
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

    const objectType = params.expenseId ? 'Expense' : 'Event';
    const objectId = (params.expenseId ?? params.eventId) as string;
    await this.notifications.notify({
      userId: params.step.resolvedApproverId,
      type: params.expenseId ? 'EXPENSE_PENDING' : 'EVENT_PENDING',
      title: `${objectType} awaiting your approval`,
      body: `A ${objectType.toLowerCase()} needs your review.`,
      deepLink: params.expenseId ? `/expenses/${objectId}` : `/events/${objectId}`,
      objectType,
      objectId,
    });
  }

  // Re-sends the current step's approval email/in-app notification without
  // advancing the chain - a fresh emailToken is issued each time (old ones
  // aren't reusable across sends), same as any other notifyStep call. Lets the
  // Expense owner nudge a slow approver; also open to whoever could override
  // that step's approve/reject (expense.approve.all/owndept, ADMIN), same gate
  // as approve()/reject() above.
  async resendNotification(
    actorId: string,
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
    target: { expenseId?: string; eventId?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.approvalRequest.findFirst({
        where: target.expenseId ? { expenseId: target.expenseId } : { eventId: target.eventId },
        include: {
          steps: { include: { position: true }, orderBy: { stepOrder: 'asc' } },
          expense: { select: { salesId: true } },
        },
      });
      if (!request) throw new NotFoundException('Approval request not found');
      if (request.status !== ApprovalStatus.PENDING) {
        throw new BadRequestException('This document is not currently pending approval');
      }

      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');

      const isOwner = !!target.expenseId && request.expense?.salesId === actorId;
      if (!isOwner && !actorRoles.includes('ADMINISTRATOR')) {
        await this.assertApprovalOverride(tx, actorId, target, actorPermissions);
      }

      await this.notifyStep(tx, { documentStage: request.documentStage, expenseId: target.expenseId, eventId: target.eventId, step });
      return { sent: true };
    });
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
      const ownDepartmentIds = await getActorDepartmentIds(this.prisma, actorId);
      if (ownDepartmentIds.length > 0) {
        orConditions.push({ approvalRequest: { expense: { departmentId: { in: ownDepartmentIds } } } });
      }
    }

    let readDepartmentIds: string[] = [];
    if (canReadAll) {
      orConditions.push({ approvalRequest: { expenseId: { not: null } } });
    } else if (canReadOwnDept) {
      readDepartmentIds = await getActorDepartmentIds(this.prisma, actorId);
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
        // Expense Request approvals are acted on from its own page, and have no expense/event/settlement to render here.
        approvalRequest: {
          documentStage: { not: DocumentStage.EXPENSE_REQUEST },
          ...(hasExpenseFilter ? { expense: { is: expenseFilter } } : {}),
        },
      },
      include: {
        position: true,
        approvalRequest: {
          include: {
            expense: { include: { sales: { select: { id: true, name: true } }, unit: true, department: true, advertiser: true, brand: true, activityType: true } },
            event: { include: { sales: { select: { id: true, name: true } }, unit: true, advertiser: true, brand: true, activityType: true } },
            // DocumentStage.SETTLEMENT rows hang off the batch, which is what
            // that tier reviews - the Approvals UI drills from here into the
            // batch's Expense list (GET /settlements/:id).
            settlement: {
              include: {
                department: true,
                createdBy: { select: { id: true, name: true } },
                expenses: { select: { id: true, activityType: { select: { id: true, name: true } } } },
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
    target: { expenseId?: string; eventId?: string; expenseRequestId?: string },
    actorPermissions: string[],
  ): Promise<void> {
    if (actorPermissions.includes('expense.approve.all') && target.expenseId) {
      return;
    }
    if (actorPermissions.includes('expense.approve.owndept') && target.expenseId) {
      const expense = await tx.expense.findUnique({ where: { id: target.expenseId }, select: { departmentId: true } });
      if (expense?.departmentId) {
        const ownDepartmentIds = await getActorDepartmentIds(tx, actorId);
        if (ownDepartmentIds.includes(expense.departmentId)) {
          return;
        }
      }
    }
    throw new ForbiddenException('You are not the assigned approver for this step');
  }

  // Expense.status mirrors whichever approval tier is currently reviewing it - one
  // value per Position.code in today's master data (see prisma/schema.prisma
  // ExpenseStatus enum). Position codes are free text and several carry "-"
  // (CO-CSO), which a Prisma enum value can't, so normalise to "_" first.
  // Falls back to the generic PENDING_APPROVAL for a Position that doesn't have
  // a matching status yet (e.g. one an Admin just created).
  private pendingStatusForPosition(positionCode: string): ExpenseStatus {
    const key = `APPROVAL_${positionCode.replace(/-/g, '_')}`;
    return key in ExpenseStatus ? (ExpenseStatus as unknown as Record<string, ExpenseStatus>)[key] : ExpenseStatus.PENDING_APPROVAL;
  }

  // Entry point into the Expense approval chain (HEAD_POD -> CO-CSO). Entered on
  // Expense creation unless the caller saved it as a DRAFT (see
  // ExpensesService.create/submitDraft), and again by ExpensesService.update()
  // to re-enter the chain when a REJECTED Expense is edited.
  //
  // Exception: an Expense whose Activity Type + Department is covered by an
  // EXPENSE_REQUEST Level scoped to that Activity Type (e.g. Karangan Bunga) was
  // already approved up front via its Expense Request, so it skips this chain and
  // goes straight to READY_TO_MATCHING. The Settlement chain after matching is
  // untouched. An Activity-Type-less EXPENSE_REQUEST Level never triggers this -
  // it would otherwise waive approval for every Expense of the Department.
  async enterExpenseApproval(
    tx: Prisma.TransactionClient,
    params: { expenseId: string; amount: Prisma.Decimal | number; departmentId?: string | null; skipNotify?: boolean },
  ): Promise<ExpenseStatus> {
    const expense = await tx.expense.findUniqueOrThrow({ where: { id: params.expenseId }, select: { activityTypeId: true, expenseRequestId: true } });

    // An Expense raised from an Expense Request (Corsec -> Sales Admin) is the
    // opposite case: the Request approved the plan, not this Expense, so it always
    // runs the EXPENSES chain (e.g. the Activity-Type-scoped "Expense - Karangan Bunga" Level).
    const preApprovedBy = expense.expenseRequestId ? null : await this.resolveApprovalLevel(tx, {
      documentStage: DocumentStage.EXPENSE_REQUEST,
      departmentId: params.departmentId ?? undefined,
      amount: 0,
      activityTypeId: expense.activityTypeId,
      ignoreRequestor: true,
    });
    if (preApprovedBy?.activityTypes.some((a) => a.activityTypeId === expense.activityTypeId)) {
      await tx.expense.update({ where: { id: params.expenseId }, data: { status: ExpenseStatus.READY_TO_MATCHING } });
      return ExpenseStatus.READY_TO_MATCHING;
    }

    const request = await this.createOrResetRequest(tx, {
      documentStage: DocumentStage.EXPENSES,
      expenseId: params.expenseId,
      amount: params.amount,
      departmentId: params.departmentId,
      activityTypeId: expense.activityTypeId,
      skipNotify: params.skipNotify,
    });
    const step0 = request.steps.find((s) => s.stepOrder === 0);
    const status = step0 ? this.pendingStatusForPosition(step0.position.code) : ExpenseStatus.PENDING_APPROVAL;
    await tx.expense.update({ where: { id: params.expenseId }, data: { status } });
    return status;
  }

  // The Sales Admin tier (Position SLSADM, e.g. step 0 of "Expense - Karangan Bunga") belongs
  // to the Sales Admins of the Expense's Department as a group - the Department mapping only
  // resolves one of them as the nominal approver, but any of them may act on the step.
  private async isSalesAdminOfTier(
    tx: Prisma.TransactionClient,
    actorId: string,
    actorRoles: string[],
    target: { expenseId?: string },
    stepPositionId: string,
  ): Promise<boolean> {
    if (!target.expenseId || !actorRoles.includes('SALES_ADMIN')) return false;
    const position = await tx.position.findUnique({ where: { id: stepPositionId }, select: { code: true } });
    if (position?.code !== POSITION_SALES_ADMIN) return false;
    const expense = await tx.expense.findUnique({ where: { id: target.expenseId }, select: { departmentId: true } });
    if (!expense?.departmentId) return false;
    return (await getActorDepartmentIds(this.prisma, actorId)).includes(expense.departmentId);
  }

  // An Expense raised from an Expense Request waits in PENDING_SALES_ADMIN with no
  // approval chain yet, and its Level (e.g. "Expense - Karangan Bunga") starts at the
  // Sales Admin tier itself. So when a Sales Admin of its Department approves / revises /
  // rejects it there, the chain is entered here first and the action is then applied to
  // step 0 on their behalf - one click instead of "Submit" followed by a second "Approve".
  // Returns whether the chain was entered; a no-op for any other Expense.
  private async enterSalesAdminStage(
    tx: Prisma.TransactionClient,
    actorId: string,
    actorRoles: string[],
    expenseId: string,
  ): Promise<boolean> {
    const expense = await tx.expense.findUnique({
      where: { id: expenseId },
      select: { status: true, departmentId: true, amount: true, paymentMethodId: true, expenseRequestId: true },
    });
    if (!expense || expense.status !== ExpenseStatus.PENDING_SALES_ADMIN || !expense.expenseRequestId) return false;

    const isAdmin = actorRoles.includes('ADMINISTRATOR');
    if (!isAdmin && !(await canCompletePendingSalesAdmin(this.prisma, { userId: actorId, roles: actorRoles }, expense))) {
      throw new ForbiddenException('Only a Sales Admin of this Expense\'s Department can act on it at this stage');
    }
    if (!expense.paymentMethodId) throw new BadRequestException('paymentMethodId is required');

    await this.enterExpenseApproval(tx, {
      expenseId,
      amount: expense.amount,
      departmentId: expense.departmentId,
      skipNotify: true,
    });
    // The acting Sales Admin stands in for whichever user the Department mapping resolved
    // step 0 to (any Sales Admin of the Department may complete it).
    const request = await tx.approvalRequest.findUniqueOrThrow({
      where: { expenseId },
      include: { steps: { include: { position: true } } },
    });
    const step0 = request.steps.find((s) => s.stepOrder === 0);
    if (step0?.position.code === POSITION_SALES_ADMIN) {
      await tx.approvalRequestStep.update({ where: { id: step0.id }, data: { resolvedApproverId: actorId } });
    }
    return true;
  }

  // Resumes an Expense's approval chain at its current (unchanged) step after a
  // revise -> edit -> resubmit cycle - does NOT delete/recreate steps like
  // createOrResetRequest does (that remains solely the brand-new-submission
  // path). Earlier APPROVED steps are left exactly as revise() left them; only
  // the current tier's approver is re-notified, since the document changed
  // under them.
  async resumeExpenseApproval(tx: Prisma.TransactionClient, params: { expenseId: string }): Promise<ExpenseStatus> {
    const request = await tx.approvalRequest.findUnique({
      where: { expenseId: params.expenseId },
      include: { steps: { include: { position: true }, orderBy: { stepOrder: 'asc' } } },
    });
    if (!request) throw new NotFoundException('Approval request not found');
    const step = request.steps.find((s) => s.stepOrder === request.currentStep);
    if (!step) throw new BadRequestException('Approval request has no current step');

    const status = this.pendingStatusForPosition(step.position.code);
    await tx.expense.update({ where: { id: params.expenseId }, data: { status } });
    await this.notifyStep(tx, { documentStage: request.documentStage, expenseId: params.expenseId, step });
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
  // holder resolves directly, no DepartmentPositionAssignment needed. A Level may also
  // be DEPARTMENT-scoped, which needs the Settlement's own departmentId to match.
  async enterSettlementApproval(
    tx: Prisma.TransactionClient,
    params: { settlementId: string; amount: Prisma.Decimal | number; departmentId?: string | null },
  ): Promise<SettlementStatus> {
    const request = await this.createOrResetRequest(tx, {
      documentStage: DocumentStage.SETTLEMENT,
      settlementId: params.settlementId,
      amount: params.amount,
      departmentId: params.departmentId,
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

  // Resumes a Settlement's chain at its current (unchanged) step after a
  // revise -> edit -> resubmit cycle - reuses applyTierStatus (already
  // idempotent: pushes the tier's status onto the Settlement + every member
  // Expense) and re-notifies that tier's approver, since the document changed
  // under them.
  async resumeSettlementApproval(tx: Prisma.TransactionClient, settlementId: string): Promise<void> {
    const request = await this.findSettlementRequest(tx, settlementId);
    const step = request.steps.find((s) => s.stepOrder === request.currentStep);
    if (!step) return;
    await this.applyTierStatus(tx, settlementId, step.position.code);
    await this.notifyStep(tx, { documentStage: DocumentStage.SETTLEMENT, settlementId, step });
  }

  // Pushes one tier's status onto the Settlement and every Expense still in it,
  // so both always name the tier currently reviewing the batch.
  private async applyTierStatus(tx: Prisma.TransactionClient, settlementId: string, positionCode: string): Promise<SettlementStatus> {
    const key = `APPROVAL_${positionCode.replace(/-/g, '_')}`;
    // No fallback: a Position with no matching status would otherwise park the
    // whole batch on a meaningless one (DRAFT) with no sign anything went wrong.
    if (!(key in SettlementStatus)) {
      throw new BadRequestException(
        `The Settlement approval level starts at Position "${positionCode}", which has no matching ${key} status - re-chain it through System > Approval Level`,
      );
    }
    const settlementStatus = (SettlementStatus as unknown as Record<string, SettlementStatus>)[key];
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
      if (step.resolvedApproverId !== actor.userId && !actor.roles.includes('ADMINISTRATOR')) {
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
    await this.prisma.$transaction(async (tx) => {
      const request = await this.findSettlementRequest(tx, settlementId);
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');
      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      if (step.resolvedApproverId !== actor.userId && !actor.roles.includes('ADMINISTRATOR')) {
        throw new ForbiddenException('You are not the assigned approver for this step');
      }

      const expenses = await tx.expense.findMany({
        where: { settlementId },
        select: { id: true, expenseNo: true, settlementApprovedStep: true },
      });

      // Every member Expense was rejected out of the batch (rejectSettlementExpense
      // clears settlementId) - nothing is left to carry into the next tier, so close
      // the settlement here instead of erroring or advancing a chain with no members.
      if (expenses.length === 0) {
        await tx.approvalRequestStep.update({ where: { id: step.id }, data: { status: ApprovalStepStatus.REJECTED } });
        await tx.approvalRequest.update({ where: { id: request.id }, data: { status: ApprovalStatus.REJECTED } });
        await tx.settlement.update({ where: { id: settlementId }, data: { status: SettlementStatus.REJECTED } });
        await this.audit.log({
          userId: actor.userId,
          action: 'SUBMIT',
          objectType: 'Settlement',
          objectId: settlementId,
          newValue: { tier: request.currentStep, position: step.positionId, allExpensesRejected: true },
        });
        return { isFinalStep: false };
      }

      const unreviewed = expenses.filter((e) => (e.settlementApprovedStep ?? -1) < request.currentStep);
      if (unreviewed.length > 0) {
        throw new BadRequestException(`Approve or reject every expense first - still pending: ${unreviewed.map((e) => e.expenseNo).join(', ')}`);
      }

      await tx.approvalRequestStep.update({
        where: { id: step.id },
        data: { status: ApprovalStepStatus.APPROVED, submittedAt: new Date(), submittedById: actor.userId },
      });

      const nextStep = request.currentStep + 1;
      const isFinalStep = nextStep >= request.steps.length;
      await tx.approvalRequest.update({
        where: { id: request.id },
        data: { currentStep: nextStep, status: isFinalStep ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING },
      });

      if (isFinalStep) {
        const settlement = await tx.settlement.update({
          where: { id: settlementId },
          data: { status: SettlementStatus.COMPLETE },
        });
        await tx.expense.updateMany({ where: { settlementId }, data: { status: ExpenseStatus.COMPLETE } });
        await this.notifications.notify({
          userId: settlement.createdById,
          type: 'SETTLEMENT_COMPLETE',
          title: 'Settlement complete',
          body: `Settlement has cleared its final approval tier.`,
          deepLink: `/settlement?open=${settlementId}`,
          objectType: 'Settlement',
          objectId: settlementId,
        });
      } else {
        const nextStepRow = request.steps.find((s) => s.stepOrder === nextStep);
        await this.applyTierStatus(tx, settlementId, nextStepRow?.position.code ?? '');
        if (nextStepRow) {
          await this.notifyStep(tx, { documentStage: DocumentStage.SETTLEMENT, settlementId, step: nextStepRow });
        }
      }

      await this.audit.log({
        userId: actor.userId,
        action: 'SUBMIT',
        objectType: 'Settlement',
        objectId: settlementId,
        newValue: { tier: request.currentStep, position: step.positionId, finalStep: isFinalStep },
      });
    });

    // Final tier only marks the Settlement COMPLETE - it is NOT pushed to Odoo
    // here. Sales CS picks the Unit first and sends it manually from the
    // Settlement list (SettlementsService.sendDraftPr).
    return this.prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
  }

  // The settlement-tier approver's "Revise" action: sends the whole batch back
  // exactly one tier instead of Submit/Reject - mirrors submitSettlementTier's
  // whole-batch scope, just going backward (a per-member revise would leave the
  // batch in an incoherent partial state). Clears every member Expense's
  // settlementApprovedStep - otherwise submitSettlementTier's "all reviewed"
  // check would be satisfied vacuously by stale values left over from before
  // the revise, letting the resumed tier's approver Submit without actually
  // re-reviewing anything.
  async reviseSettlementTier(settlementId: string, reason: string, actor: { userId: string; roles: string[] }) {
    await this.prisma.$transaction(async (tx) => {
      const request = await this.findSettlementRequest(tx, settlementId);
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');
      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      if (step.resolvedApproverId !== actor.userId && !actor.roles.includes('ADMINISTRATOR')) {
        throw new ForbiddenException('You are not the assigned approver for this step');
      }

      const newCurrentStep = Math.max(request.currentStep - 1, 0);
      const targetStep = request.steps.find((s) => s.stepOrder === newCurrentStep);
      if (targetStep) {
        await tx.approvalRequestStep.update({
          where: { id: targetStep.id },
          data: { status: ApprovalStepStatus.PENDING, submittedAt: null, submittedById: null },
        });
      }
      await tx.approvalRequest.update({ where: { id: request.id }, data: { currentStep: newCurrentStep } });

      await tx.expense.updateMany({ where: { settlementId }, data: { settlementApprovedStep: null, status: ExpenseStatus.REVISION } });
      const settlement = await tx.settlement.update({ where: { id: settlementId }, data: { status: SettlementStatus.REVISION } });

      await tx.approvalAction.create({
        data: { approvalRequestId: request.id, actorId: actor.userId, positionId: step.positionId, action: ApprovalActionType.REVISE, reason },
      });
      await this.audit.log({
        userId: actor.userId,
        action: 'REVISE',
        objectType: 'Settlement',
        objectId: settlementId,
        newValue: { fromStep: request.currentStep, toStep: newCurrentStep, reason },
      });

      await this.notifications.notify({
        userId: settlement.createdById,
        type: 'SETTLEMENT_REVISED',
        title: 'Settlement sent back for revision',
        body: reason || 'Please edit and resubmit this settlement.',
        deepLink: `/settlement?open=${settlementId}`,
        objectType: 'Settlement',
        objectId: settlementId,
      });
    });
    return this.prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
  }

  // ---- Admin rollback (System > Rollback) ----
  //
  // Unlike revise (one tier, by the current approver, sends the document back to
  // its owner), a rollback is an Administrator correcting a chain that moved on
  // too far: it rewinds the approval N tiers, re-opens every step from the target
  // tier onward and hands the document straight back to that tier's approver -
  // no owner edit in between. Works on a PENDING chain (rewind from the current
  // tier) and on a finished one (request APPROVED, currentStep == steps.length).

  private async assessRollback(tx: Prisma.TransactionClient, type: RollbackDocType, id: string) {
    const stepInclude = {
      steps: { include: { position: true, resolvedApprover: { select: { id: true, name: true } } }, orderBy: { stepOrder: 'asc' as const } },
    };
    let docNo: string;
    let status: string;
    let amount: Prisma.Decimal;
    let department: string | null;
    let memberCount: number | null = null;
    let blocker: string | null = null;
    let request;

    if (type === 'EXPENSE') {
      const expense = await tx.expense.findUnique({
        where: { id },
        include: { department: { select: { name: true } }, approvalRequest: { include: stepInclude } },
      });
      if (!expense) throw new NotFoundException('Expense not found');
      request = expense.approvalRequest;
      docNo = expense.expenseNo;
      status = expense.status;
      amount = expense.amount;
      department = expense.department?.name ?? null;
      if (!request) {
        blocker = 'This expense has no approval request (e.g. pre-approved through its Expense Request)';
      } else if (expense.settlementId) {
        blocker = 'Expense is part of a Settlement - roll back the Settlement instead';
      } else if (expense.isMatched) {
        blocker = 'Expense is bank-matched - unmatch it first';
      } else if (request.status === ApprovalStatus.REJECTED) {
        blocker = 'Approval was rejected, nothing to roll back';
      } else {
        const pending = expense.status === ExpenseStatus.PENDING_APPROVAL || expense.status.startsWith('APPROVAL_');
        const done = request.status === ApprovalStatus.APPROVED && expense.status === ExpenseStatus.READY_TO_MATCHING;
        if (!(request.status === ApprovalStatus.PENDING && pending) && !done) {
          blocker = `Expense status ${expense.status} can't be rolled back`;
        }
      }
    } else if (type === 'EXPENSE_REQUEST') {
      const er = await tx.expenseRequest.findUnique({
        where: { id },
        include: { department: { select: { name: true } }, approvalRequest: { include: stepInclude } },
      });
      if (!er) throw new NotFoundException('Expense Request not found');
      request = er.approvalRequest;
      docNo = er.requestNo;
      status = er.status;
      amount = er.budgetAmount ?? er.requestBudget ?? new Prisma.Decimal(0);
      department = er.department?.name ?? null;
      if (!request) {
        blocker = 'This expense request has no approval request (still a draft)';
      } else if (
        er.status === ExpenseRequestStatus.REJECTED ||
        er.status === ExpenseRequestStatus.CANCELLED ||
        request.status === ApprovalStatus.REJECTED
      ) {
        blocker = 'Expense request was rejected or cancelled, nothing to roll back';
      } else {
        // Pending in the Head Dept -> Co-CSO chain, or past it (budget input /
        // Corsec verification / approved) - the chain itself is fully approved then.
        // BUDGET_INPUT + PENDING: the Sales CS step is still open, waiting for the budget.
        const pending =
          (er.status === ExpenseRequestStatus.PENDING_APPROVAL || er.status === ExpenseRequestStatus.BUDGET_INPUT) &&
          request.status === ApprovalStatus.PENDING;
        const done =
          request.status === ApprovalStatus.APPROVED &&
          (er.status === ExpenseRequestStatus.BUDGET_INPUT ||
            er.status === ExpenseRequestStatus.CORSEC_VERIFICATION ||
            er.status === ExpenseRequestStatus.PROCEED);
        if (!pending && !done) blocker = `Expense request status ${er.status} can't be rolled back`;
      }
    } else {
      const settlement = await tx.settlement.findUnique({
        where: { id },
        include: { department: { select: { name: true } }, _count: { select: { expenses: true } }, approvalRequest: { include: stepInclude } },
      });
      if (!settlement) throw new NotFoundException('Settlement not found');
      request = settlement.approvalRequest;
      docNo = settlement.settlementNo;
      status = settlement.status;
      amount = settlement.totalAmount;
      department = settlement.department.name;
      memberCount = settlement._count.expenses;
      if (!request) {
        blocker = 'This settlement has no approval request (not submitted yet)';
      } else if (settlement.odooSyncStatus === 'SENT' || settlement.odooSyncStatus === 'PENDING') {
        blocker = 'Settlement is already sent to Odoo and can no longer be rolled back';
      } else if (request.status === ApprovalStatus.REJECTED) {
        blocker = 'Approval was rejected, nothing to roll back';
      } else if (!(settlement.status.startsWith('APPROVAL_') || settlement.status === SettlementStatus.COMPLETE)) {
        blocker = `Settlement status ${settlement.status} can't be rolled back`;
      }
    }

    const maxSteps = request ? request.currentStep : 0;
    if (!blocker && request && maxSteps < 1) blocker = 'Already at the first approval step';

    return {
      type,
      id,
      docNo,
      status,
      amount,
      department,
      memberCount,
      requestStatus: request?.status ?? null,
      currentStep: request?.currentStep ?? 0,
      maxSteps: blocker ? 0 : maxSteps,
      blocker,
      request,
      steps: (request?.steps ?? []).map((s) => ({
        stepOrder: s.stepOrder,
        positionCode: s.position.code,
        positionName: s.position.name,
        approverName: s.resolvedApprover.name,
        status: s.status,
      })),
    };
  }

  async searchRollbackCandidates(type: RollbackDocType, q?: string) {
    const search = q?.trim();
    if (type === 'EXPENSE') {
      const rows = await this.prisma.expense.findMany({
        where: { approvalRequest: { isNot: null }, ...(search ? { expenseNo: { contains: search, mode: 'insensitive' } } : {}) },
        select: {
          id: true,
          expenseNo: true,
          status: true,
          amount: true,
          department: { select: { name: true } },
          approvalRequest: { select: { status: true, currentStep: true, _count: { select: { steps: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      return rows.map((r) => ({
        id: r.id,
        docNo: r.expenseNo,
        status: r.status,
        amount: r.amount,
        department: r.department?.name ?? null,
        requestStatus: r.approvalRequest?.status ?? null,
        currentStep: r.approvalRequest?.currentStep ?? 0,
        totalSteps: r.approvalRequest?._count.steps ?? 0,
      }));
    }
    if (type === 'EXPENSE_REQUEST') {
      const rows = await this.prisma.expenseRequest.findMany({
        where: { approvalRequest: { isNot: null }, ...(search ? { requestNo: { contains: search, mode: 'insensitive' } } : {}) },
        select: {
          id: true,
          requestNo: true,
          status: true,
          budgetAmount: true,
          requestBudget: true,
          department: { select: { name: true } },
          approvalRequest: { select: { status: true, currentStep: true, _count: { select: { steps: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      return rows.map((r) => ({
        id: r.id,
        docNo: r.requestNo,
        status: r.status,
        amount: r.budgetAmount ?? r.requestBudget ?? new Prisma.Decimal(0),
        department: r.department?.name ?? null,
        requestStatus: r.approvalRequest?.status ?? null,
        currentStep: r.approvalRequest?.currentStep ?? 0,
        totalSteps: r.approvalRequest?._count.steps ?? 0,
      }));
    }
    const rows = await this.prisma.settlement.findMany({
      where: { approvalRequest: { isNot: null }, ...(search ? { settlementNo: { contains: search, mode: 'insensitive' } } : {}) },
      select: {
        id: true,
        settlementNo: true,
        status: true,
        totalAmount: true,
        department: { select: { name: true } },
        approvalRequest: { select: { status: true, currentStep: true, _count: { select: { steps: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return rows.map((r) => ({
      id: r.id,
      docNo: r.settlementNo,
      status: r.status,
      amount: r.totalAmount,
      department: r.department.name,
      requestStatus: r.approvalRequest?.status ?? null,
      currentStep: r.approvalRequest?.currentStep ?? 0,
      totalSteps: r.approvalRequest?._count.steps ?? 0,
    }));
  }

  async getRollbackPreview(type: RollbackDocType, id: string) {
    const { request: _request, ...preview } = await this.assessRollback(this.prisma, type, id);
    return preview;
  }

  async rollbackApproval(type: RollbackDocType, id: string, steps: number, reason: string, actor: { userId: string }) {
    await this.prisma.$transaction(async (tx) => {
      const assessed = await this.assessRollback(tx, type, id);
      const request = assessed.request;
      if (assessed.blocker || !request) throw new BadRequestException(assessed.blocker ?? 'Nothing to roll back');
      if (steps < 1 || steps > assessed.maxSteps) {
        throw new BadRequestException(`Choose between 1 and ${assessed.maxSteps} step(s) to roll back`);
      }

      const fromStep = request.currentStep;
      const targetStep = fromStep - steps;
      const targetRow = request.steps.find((s) => s.stepOrder === targetStep);
      if (!targetRow) throw new BadRequestException('Approval request has no such step');
      const actingRow = request.steps.find((s) => s.stepOrder === Math.min(fromStep, request.steps.length - 1)) ?? targetRow;

      // Reopen the target tier and everything after it. Tokens of the reopened
      // steps are dropped so an old one-click email link can't be replayed.
      await tx.approvalRequestStep.updateMany({
        where: { approvalRequestId: request.id, stepOrder: { gte: targetStep } },
        data: { status: ApprovalStepStatus.PENDING, submittedAt: null, submittedById: null, emailToken: null, emailTokenExpiresAt: null },
      });
      await tx.approvalRequest.update({ where: { id: request.id }, data: { currentStep: targetStep, status: ApprovalStatus.PENDING } });
      await tx.approvalAction.create({
        data: {
          approvalRequestId: request.id,
          actorId: actor.userId,
          positionId: actingRow.positionId,
          action: ApprovalActionType.REVISE,
          reason: `Rollback ${steps} step(s) by administrator: ${reason}`,
        },
      });

      if (type === 'EXPENSE') {
        await tx.expense.update({ where: { id }, data: { status: this.pendingStatusForPosition(targetRow.position.code) } });
        await this.notifyStep(tx, { documentStage: request.documentStage, expenseId: id, step: targetRow });
      } else if (type === 'EXPENSE_REQUEST') {
        // Back into the approval chain: drop the Sales CS budget and Corsec
        // verification, they happen again once the chain finishes. Landing on the
        // Sales CS step itself means the budget stage reopens.
        const backToBudget = targetRow.position.code === POSITION_SALES_CS;
        await tx.expenseRequest.update({
          where: { id },
          data: {
            status: backToBudget ? ExpenseRequestStatus.BUDGET_INPUT : ExpenseRequestStatus.PENDING_APPROVAL,
            rejectReason: null,
            budgetAmount: null,
            budgetNotes: null,
            budgetById: null,
            budgetAt: null,
            verifiedById: null,
            verifiedAt: null,
          },
        });
        if (backToBudget) {
          const er = await tx.expenseRequest.findUniqueOrThrow({
            where: { id },
            include: { advertisers: { include: { advertiser: { select: { name: true } } } }, agencies: { include: { agency: { select: { name: true } } } } },
          });
          await this.notifyPositionHolders(tx, POSITION_SALES_CS, er, 'rolled back, please fill in the budget.');
        } else {
          await this.notifyStep(tx, { documentStage: request.documentStage, expenseRequestId: id, step: targetRow });
        }
      } else {
        // Expenses reviewed at tiers before the target stay reviewed; the rest
        // must be re-reviewed by the reopened tier's approver.
        await tx.expense.updateMany({
          where: { settlementId: id, settlementApprovedStep: { gte: targetStep } },
          data: { settlementApprovedStep: targetStep === 0 ? null : targetStep - 1 },
        });
        await this.applyTierStatus(tx, id, targetRow.position.code);
        await this.notifyStep(tx, { documentStage: DocumentStage.SETTLEMENT, settlementId: id, step: targetRow });
      }

      await this.audit.log({
        userId: actor.userId,
        action: 'ROLLBACK',
        objectType: type === 'EXPENSE' ? 'Expense' : type === 'EXPENSE_REQUEST' ? 'ExpenseRequest' : 'Settlement',
        objectId: id,
        newValue: { fromStep, toStep: targetStep, steps, reason, fromStatus: assessed.status },
      });
    });
    return this.getRollbackPreview(type, id);
  }

  private requestWhere(target: { expenseId?: string; eventId?: string; expenseRequestId?: string }): Prisma.ApprovalRequestWhereInput {
    return target.expenseId
      ? { expenseId: target.expenseId }
      : target.expenseRequestId
      ? { expenseRequestId: target.expenseRequestId }
      : { eventId: target.eventId };
  }

  // Everyone active who holds the Position (Sales Customer Service / Corsec are
  // ANY-scope roles, not tied to a Department) - used to hand an Expense Request
  // on to the post-approval stages.
  private async notifyPositionHolders(
    tx: Prisma.TransactionClient,
    positionCode: string,
    request: { id: string; requestNo: string; clientName: string | null; advertisers?: { advertiser: { name: string } }[]; agencies?: { agency: { name: string } }[] },
    body: string,
  ) {
    const holders = await tx.user.findMany({ where: { status: 'ACTIVE', position: { code: positionCode } }, select: { id: true } });
    for (const u of holders) {
      await this.notifications.notify({
        userId: u.id,
        type: 'EXPENSE_REQUEST_PENDING',
        title: 'Expense Request needs your action',
        body: `${request.requestNo} (${clientLabel(request)}): ${body}`,
        deepLink: '/expense-requests',
        objectType: 'ExpenseRequest',
        objectId: request.id,
      });
    }
  }

  async approve(
    actorId: string,
    target: { expenseId?: string; eventId?: string; expenseRequestId?: string },
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      if (target.expenseId) {
        await this.enterSalesAdminStage(tx, actorId, actorRoles, target.expenseId);
        // Sent back by the Sales Admin: it is Corsec's turn to update the invoice (which resumes
        // the chain), so it must not be approved in the meantime.
        const sentBack = await tx.expense.findUnique({ where: { id: target.expenseId }, select: { status: true, expenseRequestId: true } });
        if (sentBack?.status === ExpenseStatus.REVISION && sentBack.expenseRequestId) {
          throw new BadRequestException('This Expense was sent back for revision - Corsec must update the invoice before it can be approved');
        }
      }
      const request = await tx.approvalRequest.findFirst({
        where: this.requestWhere(target),
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
      if (!request) throw new NotFoundException('Approval request not found');
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');

      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      // Admin override: acts as any approver on any step, for oversight/unblocking.
      if (
        step.resolvedApproverId !== actorId &&
        !actorRoles.includes('ADMINISTRATOR') &&
        !(await this.isSalesAdminOfTier(tx, actorId, actorRoles, target, step.positionId))
      ) {
        await this.assertApprovalOverride(tx, actorId, target, actorPermissions);
      }

      // The Sales Customer Service step is the budget stage: it is completed by submitting the
      // budget (ExpenseRequestsService.setBudget), never by a plain approve.
      if (target.expenseRequestId) {
        const er = await tx.expenseRequest.findUnique({ where: { id: target.expenseRequestId }, select: { status: true } });
        if (er?.status === ExpenseRequestStatus.BUDGET_INPUT) {
          throw new BadRequestException('This Expense Request is waiting for a budget; submit the budget instead of approving');
        }
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
      // Expense Request: reaching the Sales CS step means "fill in the budget", not "approve".
      const budgetStageNext = !!target.expenseRequestId && !isFinalStep && nextStepRow?.position.code === POSITION_SALES_CS;
      if (!isFinalStep && nextStepRow && !budgetStageNext) {
        await this.notifyStep(tx, {
          documentStage: updated.documentStage,
          expenseId: target.expenseId,
          eventId: target.eventId,
          expenseRequestId: target.expenseRequestId,
          step: nextStepRow,
        });
      }

      let expense = null;
      let event = null;
      let expenseRequest = null;
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
      } else if (target.expenseRequestId && (isFinalStep || budgetStageNext)) {
        // Approval chain done (or only the Sales CS budget step left, which stays PENDING until the
        // budget is submitted) -> hand over to Sales Customer Service to fill the budget.
        expenseRequest = await tx.expenseRequest.update({
          where: { id: target.expenseRequestId },
          data: { status: ExpenseRequestStatus.BUDGET_INPUT },
          include: { advertisers: { include: { advertiser: { select: { name: true } } } }, agencies: { include: { agency: { select: { name: true } } } } },
        });
        await this.notifyPositionHolders(tx, POSITION_SALES_CS, expenseRequest, 'approved, please fill in the budget.');
      }

      await this.audit.log({
        userId: actorId,
        action: 'APPROVE',
        objectType: target.expenseId ? 'Expense' : target.expenseRequestId ? 'ExpenseRequest' : 'Event',
        objectId: (target.expenseId ?? target.expenseRequestId ?? target.eventId) as string,
        newValue: { step: request.currentStep, position: step.positionId, finalStep: isFinalStep, documentStage: request.documentStage },
      });

      return { approvalRequest: updated, expense, event, expenseRequest };
    });

    return result;
  }

  async reject(
    actorId: string,
    target: { expenseId?: string; eventId?: string; expenseRequestId?: string },
    reason: string,
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (target.expenseId) await this.enterSalesAdminStage(tx, actorId, actorRoles, target.expenseId);
      const request = await tx.approvalRequest.findFirst({
        where: this.requestWhere(target),
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
      if (!request) throw new NotFoundException('Approval request not found');
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');

      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      // Admin override: acts as any approver on any step, for oversight/unblocking.
      if (
        step.resolvedApproverId !== actorId &&
        !actorRoles.includes('ADMINISTRATOR') &&
        !(await this.isSalesAdminOfTier(tx, actorId, actorRoles, target, step.positionId))
      ) {
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
      let expenseRequest = null;
      if (target.expenseId) {
        expense = await tx.expense.update({ where: { id: target.expenseId }, data: { status: ExpenseStatus.REJECTED } });
      } else if (target.eventId) {
        event = await tx.event.update({ where: { id: target.eventId }, data: { status: EventStatus.REJECTED, rejectReason: reason } });
      } else if (target.expenseRequestId) {
        expenseRequest = await tx.expenseRequest.update({
          where: { id: target.expenseRequestId },
          data: { status: ExpenseRequestStatus.REJECTED, rejectReason: reason },
        });
      }

      await this.audit.log({
        userId: actorId,
        action: 'REJECT',
        objectType: target.expenseId ? 'Expense' : target.expenseRequestId ? 'ExpenseRequest' : 'Event',
        objectId: (target.expenseId ?? target.expenseRequestId ?? target.eventId) as string,
        newValue: { position: step.positionId, reason, documentStage: request.documentStage },
      });

      if (expenseRequest) {
        await this.notifications.notify({
          userId: expenseRequest.requestedById,
          type: 'EXPENSE_REQUEST_REJECTED',
          title: 'Expense Request rejected',
          body: reason || `Rejected at ${step.positionId} step.`,
          deepLink: '/expense-requests',
          objectType: 'ExpenseRequest',
          objectId: expenseRequest.id,
        });
      }

      const submitterId = expense?.salesId ?? event?.salesId;
      if (submitterId) {
        await this.notifications.notify({
          userId: submitterId,
          type: expense ? 'EXPENSE_REJECTED' : 'EVENT_REJECTED',
          title: `${expense ? 'Expense' : 'Event'} rejected`,
          body: reason || `Rejected at ${step.positionId} step.`,
          deepLink: expense ? `/expenses/${expense.id}` : `/events/${event?.id}`,
          objectType: expense ? 'Expense' : 'Event',
          objectId: (expense?.id ?? event?.id) as string,
        });
      }

      return { approvalRequest: updated, expense, event, expenseRequest };
    });
  }

  // Sends a pending Expense approval back exactly one tier (currentStep - 1)
  // instead of terminating it like reject() does - only the step at the new
  // currentStep is reopened to PENDING, every step before it is left exactly
  // as-is (still APPROVED). The Expense moves to REVISION so its owner can
  // edit and resubmit - ExpensesService.update() calls resumeExpenseApproval()
  // to continue the chain at that same tier instead of restarting it from
  // step 0. Scoped to Expense only (confirmed scope is Expense + Settlement
  // chains; Event has no REVISION status, don't add one speculatively).
  async revise(actorId: string, target: { expenseId: string }, reason: string, actorRoles: string[] = [], actorPermissions: string[] = []) {
    return this.prisma.$transaction(async (tx) => {
      await this.enterSalesAdminStage(tx, actorId, actorRoles, target.expenseId);
      const request = await tx.approvalRequest.findFirst({
        where: this.requestWhere(target),
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
      if (!request) throw new NotFoundException('Approval request not found');
      if (request.status !== ApprovalStatus.PENDING) throw new BadRequestException('Approval request is not pending');

      const step = request.steps.find((s) => s.stepOrder === request.currentStep);
      if (!step) throw new BadRequestException('Approval request has no current step');
      if (
        step.resolvedApproverId !== actorId &&
        !actorRoles.includes('ADMINISTRATOR') &&
        !(await this.isSalesAdminOfTier(tx, actorId, actorRoles, target, step.positionId))
      ) {
        await this.assertApprovalOverride(tx, actorId, target, actorPermissions);
      }

      const newCurrentStep = Math.max(request.currentStep - 1, 0);
      const targetStep = request.steps.find((s) => s.stepOrder === newCurrentStep);
      if (targetStep) {
        await tx.approvalRequestStep.update({ where: { id: targetStep.id }, data: { status: ApprovalStepStatus.PENDING } });
      }

      await tx.approvalAction.create({
        data: { approvalRequestId: request.id, actorId, positionId: step.positionId, action: ApprovalActionType.REVISE, reason },
      });

      const updated = await tx.approvalRequest.update({
        where: { id: request.id },
        data: { currentStep: newCurrentStep },
        include: requestInclude,
      });

      const expense = await tx.expense.update({ where: { id: target.expenseId }, data: { status: ExpenseStatus.REVISION } });

      await this.audit.log({
        userId: actorId,
        action: 'REVISE',
        objectType: 'Expense',
        objectId: target.expenseId,
        newValue: { fromStep: request.currentStep, toStep: newCurrentStep, position: step.positionId, reason },
      });

      await this.notifications.notify({
        userId: expense.salesId,
        type: 'EXPENSE_REVISED',
        title: 'Expense sent back for revision',
        body: reason || `Sent back at ${step.positionId} step - please edit and resubmit.`,
        deepLink: `/expenses/${expense.id}`,
        objectType: 'Expense',
        objectId: expense.id,
      });

      // An Expense raised from an Expense Request was filled in by Corsec (invoice files), so
      // Corsec is who has to fix it - tell them too ("Update Invoice" on the Expense Request list).
      if (expense.expenseRequestId) {
        const corsecHolders = await tx.user.findMany({ where: { status: 'ACTIVE', position: { code: POSITION_CORSEC } }, select: { id: true } });
        for (const u of corsecHolders) {
          await this.notifications.notify({
            userId: u.id,
            type: 'EXPENSE_REVISED',
            title: 'Expense sent back - update the invoice',
            body: `${expense.expenseNo}: ${reason || `Sent back at ${step.positionId} step`}. Use "Update Invoice" on the Expense Request.`,
            deepLink: '/expense-requests',
            objectType: 'Expense',
            objectId: expense.id,
          });
        }
      }

      return { approvalRequest: updated, expense };
    });
  }
}

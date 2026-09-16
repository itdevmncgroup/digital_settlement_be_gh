import { createHash } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BankTxnStatus, ExpenseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { normalizeName } from '../common/matching/normalize';
import { parseBankStatementPdf } from './bank-statement-parser.util';
import { RoleName } from '../common/constants/role-name';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { getActorDepartmentIds } from '../common/rbac/scope.util';

const AMOUNT_EXACT_SCORE = 60;
const AMOUNT_CLOSE_SCORE = 30;
const AMOUNT_CLOSE_TOLERANCE_PCT = 0.01;

const DATE_SAME_DAY_SCORE = 30;
const DATE_WITHIN_3D_SCORE = 20;
const DATE_WITHIN_7D_SCORE = 10;

const MERCHANT_MATCH_SCORE = 10;

const AUTO_MATCH_THRESHOLD = 80;
const REVIEW_THRESHOLD = 40;
const AUTO_MATCH_MARGIN = 10; // best candidate must lead the runner-up by this much

const batchInclude = { uploadedBy: { select: { id: true, name: true } } } as const;
const txnInclude = {
  matchedExpense: {
    select: {
      id: true,
      expenseNo: true,
      amount: true,
      expenseDate: true,
      sales: { select: { id: true, name: true } },
      advertiser: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
    },
  },
  matchedBy: { select: { id: true, name: true } },
} as const;

interface Candidate {
  id: string;
  amount: number;
  expenseDate: Date;
  salesName: string;
  advertiserName: string;
  brandName: string;
}

@Injectable()
export class BankMatchingService {
  private readonly logger = new Logger(BankMatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly approvals: ApprovalsService,
  ) {}

  findAllBatches() {
    return this.prisma.bankSettlementBatch.findMany({
      include: { ...batchInclude, _count: { select: { transactions: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findBatch(id: string) {
    const batch = await this.prisma.bankSettlementBatch.findUnique({
      where: { id },
      include: { ...batchInclude, transactions: { include: txnInclude, orderBy: { lineNo: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('Bank settlement batch not found');
    return batch;
  }

  // Backs the Expense detail page's "Matched" button - Finance/Admin search
  // across every batch for a transaction line to manually link to an Expense.
  searchTransactions(search?: string, unmatchedOnly = false) {
    return this.prisma.bankTransaction.findMany({
      where: {
        status: unmatchedOnly ? BankTxnStatus.UNMATCHED : undefined,
        rawDescription: search ? { contains: search, mode: 'insensitive' } : undefined,
      },
      include: { ...txnInclude, batch: { select: { id: true, fileName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  // Parses the uploaded settlement PDF into transaction lines, then tries to
  // auto-reconcile each line against an Expense by amount + date + merchant
  // name (BRD AutoMatching). Finance reviews anything not confidently matched.
  //
  // Content-hash dedup: re-uploading the exact same file just returns the
  // existing batch (already scanned - no reparsing) unless `force` is set, in
  // which case that same batch's transactions are wiped and rebuilt from
  // scratch (an explicit "scan ulang").
  async uploadAndMatch(file: Express.Multer.File, actorId: string, force = false) {
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.prisma.bankSettlementBatch.findUnique({ where: { contentHash } });

    // Even on a "no reparsing needed" hit, Expense data may have changed since
    // this file was last scanned (new matches, edits, deletions) - re-score
    // the existing lines against current candidates instead of returning a
    // possibly-stale matching_status.
    if (existing && !force) {
      return this.rematch(existing.id, actorId);
    }

    const stored = await this.storage.save(file.buffer, 'bank-settlements', file.originalname);

    let lines: Awaited<ReturnType<typeof parseBankStatementPdf>>;
    try {
      lines = await parseBankStatementPdf(file.buffer);
    } catch (err) {
      this.logger.error(
        `Failed to parse bank statement "${file.originalname}" (actor ${actorId}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new BadRequestException(
        'Could not read this statement PDF - it may be corrupted, password-protected, or in an unrecognized format.',
      );
    }

    const candidates = await this.loadCandidates();
    const counts = { autoMatched: 0, reviewRequired: 0, unmatched: 0 };

    let batch;
    try {
      batch = await this.prisma.$transaction(async (tx) => {
        const b = existing
          ? await tx.bankSettlementBatch.update({
              where: { id: existing.id },
              data: { fileName: file.originalname, storageKey: stored.storageKey, uploadedById: actorId },
            })
          : await tx.bankSettlementBatch.create({
              data: { fileName: file.originalname, storageKey: stored.storageKey, uploadedById: actorId, contentHash },
            });

        if (existing) {
          await tx.bankTransaction.deleteMany({ where: { batchId: b.id } });
        }

        for (const line of lines) {
          const { expenseId, score, status } = this.bestMatch(line, candidates);
          if (status === BankTxnStatus.AUTO_MATCHED) counts.autoMatched++;
          else if (status === BankTxnStatus.REVIEW_REQUIRED) counts.reviewRequired++;
          else counts.unmatched++;

          await tx.bankTransaction.create({
            data: {
              batchId: b.id,
              lineNo: line.lineNo,
              transactionDate: line.transactionDate,
              rawDescription: line.rawDescription,
              amount: line.amount,
              cardLast4: line.cardLast4,
              status,
              matchedExpenseId: status === BankTxnStatus.UNMATCHED ? undefined : expenseId,
              matchScore: status === BankTxnStatus.UNMATCHED ? undefined : score,
            },
          });

          if (status === BankTxnStatus.AUTO_MATCHED && expenseId) {
            await this.afterMatchChange(tx, expenseId);
          }
        }

        return b;
      });
    } catch (err) {
      this.logger.error(
        `Auto-match transaction failed for "${file.originalname}" (actor ${actorId}, ${lines.length} parsed lines): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }

    this.logger.log(
      `Matched batch ${batch.id} ("${file.originalname}"): ${lines.length} lines parsed - ` +
        `${counts.autoMatched} auto-matched, ${counts.reviewRequired} need review, ${counts.unmatched} unmatched.`,
    );

    try {
      await this.audit.log({
        userId: actorId,
        action: existing ? 'RESCAN' : 'UPLOAD',
        objectType: 'BankSettlementBatch',
        objectId: batch.id,
        newValue: { fileName: file.originalname, lineCount: lines.length, ...counts },
      });

      return { ...(await this.findBatch(batch.id)), alreadyScanned: false };
    } catch (err) {
      this.logger.error(
        `Post-match step failed for batch ${batch.id} ("${file.originalname}", actor ${actorId}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }
  }

  // "TIDAK" branch of the already-scanned prompt: re-run auto-matching against
  // current Expense data using this batch's already-parsed transaction lines,
  // without touching the PDF/OCR step at all. Only re-scores AUTO_MATCHED/
  // REVIEW_REQUIRED/UNMATCHED lines - a MANUAL_MATCHED line is a human decision
  // and is left alone, same as uploadAndMatch never touching it either.
  async rematch(batchId: string, actorId: string) {
    const batch = await this.findBatch(batchId);
    const candidates = await this.loadCandidates();
    const counts = { autoMatched: 0, reviewRequired: 0, unmatched: 0 };

    try {
      await this.prisma.$transaction(async (tx) => {
        for (const txn of batch.transactions) {
          if (txn.status === BankTxnStatus.MANUAL_MATCHED) continue;

          const previousExpenseId = txn.matchedExpense?.id ?? null;
          const { expenseId, score, status } = this.bestMatch(
            { amount: Number(txn.amount), transactionDate: txn.transactionDate, rawDescription: txn.rawDescription },
            candidates,
          );
          if (status === BankTxnStatus.AUTO_MATCHED) counts.autoMatched++;
          else if (status === BankTxnStatus.REVIEW_REQUIRED) counts.reviewRequired++;
          else counts.unmatched++;

          await tx.bankTransaction.update({
            where: { id: txn.id },
            data: {
              status,
              matchedExpenseId: status === BankTxnStatus.UNMATCHED ? null : expenseId,
              matchScore: status === BankTxnStatus.UNMATCHED ? null : score,
            },
          });

          if (status === BankTxnStatus.AUTO_MATCHED && expenseId) {
            await this.afterMatchChange(tx, expenseId);
          }
          if (previousExpenseId && previousExpenseId !== expenseId) {
            await this.afterMatchChange(tx, previousExpenseId);
          }
        }
      });
    } catch (err) {
      this.logger.error(
        `Rematch transaction failed for batch ${batchId} (actor ${actorId}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }

    this.logger.log(
      `Rematched batch ${batchId}: ${counts.autoMatched} auto-matched, ${counts.reviewRequired} need review, ${counts.unmatched} unmatched.`,
    );

    await this.audit.log({
      userId: actorId,
      action: 'REMATCH',
      objectType: 'BankSettlementBatch',
      objectId: batchId,
      newValue: { fileName: batch.fileName, ...counts },
    });

    return { ...(await this.findBatch(batchId)), alreadyScanned: true };
  }

  async manualMatch(transactionId: string, expenseId: string, actor: AuthUser) {
    const txn = await this.getTxnOrThrow(transactionId);
    const expense = await this.prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertMatchOverride(actor, expenseId);

    const updated = await this.prisma.bankTransaction.update({
      where: { id: transactionId },
      data: {
        status: BankTxnStatus.MANUAL_MATCHED,
        matchedExpenseId: expenseId,
        matchedById: actor.userId,
        matchedAt: new Date(),
      },
      include: txnInclude,
    });

    await this.afterMatchChange(this.prisma, expenseId);
    if (txn.matchedExpenseId && txn.matchedExpenseId !== expenseId) {
      await this.afterMatchChange(this.prisma, txn.matchedExpenseId);
    }

    await this.audit.log({
      userId: actor.userId,
      action: 'MANUAL_MATCH',
      objectType: 'BankTransaction',
      objectId: transactionId,
      oldValue: { status: txn.status, matchedExpenseId: txn.matchedExpenseId },
      newValue: { status: updated.status, matchedExpenseId: updated.matchedExpenseId },
    });
    return updated;
  }

  async unmatch(transactionId: string, actor: AuthUser) {
    const txn = await this.getTxnOrThrow(transactionId);
    await this.assertMatchOverride(actor, txn.matchedExpenseId);

    const updated = await this.prisma.bankTransaction.update({
      where: { id: transactionId },
      data: {
        status: BankTxnStatus.UNMATCHED,
        matchedExpenseId: null,
        matchScore: null,
        matchedById: null,
        matchedAt: null,
      },
      include: txnInclude,
    });

    if (txn.matchedExpenseId) {
      await this.afterMatchChange(this.prisma, txn.matchedExpenseId);
    }

    await this.audit.log({
      userId: actor.userId,
      action: 'UNMATCH',
      objectType: 'BankTransaction',
      objectId: transactionId,
      oldValue: { status: txn.status, matchedExpenseId: txn.matchedExpenseId },
      newValue: { status: updated.status },
    });
    return updated;
  }

  // "Manual, no billing statement" match - for spend that will never show up on a
  // bank/credit-card statement line at all (e-wallet, personal cash pending
  // reimbursement). Sets Expense.isMatched directly instead of linking a
  // BankTransaction - safe because recomputeIsMatched() only ever re-derives the
  // flag when a BankTransaction that references this Expense changes, and with
  // none linked, that never happens, so the flag holds until this endpoint (or
  // manualUnmatchExpense) changes it again.
  async manualMatchExpense(expenseId: string, actor: AuthUser) {
    const expense = await this.prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertMatchOverride(actor, expenseId);

    const linkedTxn = await this.getLinkedMatchedTxn(expenseId);
    if (linkedTxn) {
      throw new ConflictException('This expense is already linked to a bank transaction - unmatch that transaction instead');
    }

    await this.prisma.expense.update({ where: { id: expenseId }, data: { isMatched: true } });
    if (expense.status === ExpenseStatus.READY_TO_MATCHING) {
      await this.prisma.expense.update({ where: { id: expenseId }, data: { status: ExpenseStatus.READY_TO_SETTLED } });
    }

    await this.audit.log({
      userId: actor.userId,
      action: 'MANUAL_MATCH_NO_TXN',
      objectType: 'Expense',
      objectId: expenseId,
      oldValue: { isMatched: expense.isMatched, status: expense.status },
      newValue: { isMatched: true },
    });

    return this.prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
  }

  async manualUnmatchExpense(expenseId: string, actor: AuthUser) {
    const expense = await this.prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertMatchOverride(actor, expenseId);

    const linkedTxn = await this.getLinkedMatchedTxn(expenseId);
    if (linkedTxn) {
      throw new ConflictException('This expense is linked to a bank transaction - unmatch that transaction instead');
    }

    await this.prisma.expense.update({ where: { id: expenseId }, data: { isMatched: false } });
    if (expense.status === ExpenseStatus.READY_TO_SETTLED) {
      await this.prisma.expense.update({ where: { id: expenseId }, data: { status: ExpenseStatus.READY_TO_MATCHING } });
    }

    await this.audit.log({
      userId: actor.userId,
      action: 'MANUAL_UNMATCH_NO_TXN',
      objectType: 'Expense',
      objectId: expenseId,
      oldValue: { isMatched: expense.isMatched, status: expense.status },
      newValue: { isMatched: false },
    });

    return this.prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
  }

  private getLinkedMatchedTxn(expenseId: string) {
    return this.prisma.bankTransaction.findFirst({
      where: { matchedExpenseId: expenseId, status: { in: [BankTxnStatus.AUTO_MATCHED, BankTxnStatus.MANUAL_MATCHED] } },
    });
  }

  // Mirrors approvals.service's assertApprovalOverride: expense.match.all opens
  // every Expense, expense.match.ownpod only ones in the actor's own
  // Department(s) (UserDepartment or an active DepartmentPositionAssignment -
  // "POD" pre-merge_pod_into_department terminology). ADMIN/FINANCE/MANAGEMENT
  // keep the unrestricted access the controller's class-level @Roles already
  // implied before these permissions existed. A txn with no matchedExpenseId
  // (unmatch on an already-unmatched line) has nothing to scope against, so
  // only the unrestricted grants apply.
  private async assertMatchOverride(actor: AuthUser, expenseId: string | null): Promise<void> {
    const unrestrictedRoles: string[] = [RoleName.ADMIN, RoleName.FINANCE, RoleName.MANAGEMENT];
    if (actor.roles.some((r) => unrestrictedRoles.includes(r))) return;
    if (actor.permissions?.includes('expense.match.all')) return;
    if (expenseId && actor.permissions?.includes('expense.match.ownpod')) {
      const expense = await this.prisma.expense.findUnique({ where: { id: expenseId }, select: { departmentId: true } });
      if (expense?.departmentId) {
        const ownDepartmentIds = await getActorDepartmentIds(this.prisma, actor.userId);
        if (ownDepartmentIds.includes(expense.departmentId)) return;
      }
    }
    throw new ForbiddenException('You are not allowed to match/unmatch this expense');
  }

  private async getTxnOrThrow(id: string) {
    const txn = await this.prisma.bankTransaction.findUnique({ where: { id } });
    if (!txn) throw new NotFoundException('Bank transaction not found');
    return txn;
  }

  // Expense.isMatched mirrors "has at least one AUTO_MATCHED/MANUAL_MATCHED bank
  // transaction" - recomputed (rather than blindly set) so unmatching one of
  // several transactions linked to the same Expense doesn't clear a flag that
  // another still-matched transaction should keep true. Returns the resulting
  // isMatched value so callers can react to it flipping.
  private async recomputeIsMatched(client: PrismaService | Prisma.TransactionClient, expenseId: string): Promise<boolean> {
    const stillMatched = await client.bankTransaction.count({
      where: { matchedExpenseId: expenseId, status: { in: [BankTxnStatus.AUTO_MATCHED, BankTxnStatus.MANUAL_MATCHED] } },
    });
    const isMatched = stillMatched > 0;
    await client.expense.update({ where: { id: expenseId }, data: { isMatched } });
    return isMatched;
  }

  // Matching happens after the Expense chain, not before it: an Expense arrives
  // here already READY_TO_MATCHING (HEAD_POD -> CO-CSO-1 -> CO-CSO-2 all
  // approved), and matching is what makes it READY_TO_SETTLED, i.e. eligible to
  // be grouped into a Settlement. Unmatching walks that single step back. Every
  // other status is left alone - an Expense still mid-approval, rejected, or
  // already in a Settlement must not be moved by a match toggle.
  private async afterMatchChange(client: PrismaService | Prisma.TransactionClient, expenseId: string): Promise<void> {
    const isMatched = await this.recomputeIsMatched(client, expenseId);
    const expense = await client.expense.findUniqueOrThrow({ where: { id: expenseId } });

    if (isMatched && expense.status === ExpenseStatus.READY_TO_MATCHING) {
      await client.expense.update({ where: { id: expenseId }, data: { status: ExpenseStatus.READY_TO_SETTLED } });
    } else if (!isMatched && expense.status === ExpenseStatus.READY_TO_SETTLED) {
      await client.expense.update({ where: { id: expenseId }, data: { status: ExpenseStatus.READY_TO_MATCHING } });
    }
  }

  private async loadCandidates(): Promise<Candidate[]> {
    const expenses = await this.prisma.expense.findMany({
      // Only Expenses that have cleared their approval chain are matchable -
      // matching is the step right after it (READY_TO_MATCHING -> READY_TO_SETTLED).
      where: { isMatched: false, status: ExpenseStatus.READY_TO_MATCHING },
      select: {
        id: true,
        amount: true,
        expenseDate: true,
        sales: { select: { name: true } },
        advertiser: { select: { name: true } },
        brand: { select: { name: true } },
      },
    });
    return expenses.map((e) => ({
      id: e.id,
      amount: Number(e.amount),
      expenseDate: e.expenseDate,
      salesName: e.sales.name,
      advertiserName: e.advertiser.name,
      brandName: e.brand.name,
    }));
  }

  private bestMatch(
    line: { amount: number; transactionDate: Date | null; rawDescription: string },
    candidates: Candidate[],
  ): { expenseId: string | null; score: number; status: BankTxnStatus } {
    // Deterministic override: if amount AND calendar day both match exactly for
    // exactly one candidate, that's an unambiguous auto-match regardless of how
    // close a runner-up scores on weaker signals (date range / merchant name).
    // A tie between two-or-more exact candidates is genuinely ambiguous, so that
    // case falls through to the scored/margin logic below instead of guessing.
    if (line.transactionDate) {
      const exactMatches = candidates.filter(
        (c) =>
          Math.abs(line.amount - c.amount) < 0.01 &&
          this.isSameCalendarDay(line.transactionDate as Date, c.expenseDate),
      );
      if (exactMatches.length === 1) {
        return { expenseId: exactMatches[0].id, score: 100, status: BankTxnStatus.AUTO_MATCHED };
      }
    }

    const normalizedDescription = normalizeName(line.rawDescription);
    const scored = candidates
      .map((c) => ({ id: c.id, score: this.scoreCandidate(line, normalizedDescription, c) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { expenseId: null, score: 0, status: BankTxnStatus.UNMATCHED };

    const best = scored[0];
    const runnerUp = scored[1];
    // A tight race between the top two candidates means we're not confident
    // enough to auto-match, even if the raw score cleared the threshold. The
    // real score is still returned (not clamped to REVIEW_THRESHOLD) so the
    // stored matchScore keeps its diagnostic value - only `status` reflects
    // the margin-driven downgrade.
    if (best.score >= AUTO_MATCH_THRESHOLD && runnerUp && best.score - runnerUp.score < AUTO_MATCH_MARGIN) {
      return { expenseId: best.id, score: best.score, status: BankTxnStatus.REVIEW_REQUIRED };
    }
    const status =
      best.score >= AUTO_MATCH_THRESHOLD
        ? BankTxnStatus.AUTO_MATCHED
        : best.score >= REVIEW_THRESHOLD
        ? BankTxnStatus.REVIEW_REQUIRED
        : BankTxnStatus.UNMATCHED;
    return { expenseId: best.id, score: best.score, status };
  }

  // Compares calendar dates (UTC year/month/day) rather than raw millisecond
  // difference, so a transaction and an expense recorded on the same day but
  // with different times-of-day (e.g. midnight UTC vs. a stored offset) still
  // count as "same day" instead of silently falling into a >=1-day bucket.
  private isSameCalendarDay(a: Date, b: Date): boolean {
    return (
      a.getUTCFullYear() === b.getUTCFullYear() &&
      a.getUTCMonth() === b.getUTCMonth() &&
      a.getUTCDate() === b.getUTCDate()
    );
  }

  private scoreCandidate(
    line: { amount: number; transactionDate: Date | null },
    normalizedDescription: string,
    candidate: Candidate,
  ): number {
    const amountDiff = Math.abs(line.amount - candidate.amount);
    let score = 0;

    if (amountDiff < 0.01) {
      score += AMOUNT_EXACT_SCORE;
    } else if (candidate.amount > 0 && amountDiff / candidate.amount <= AMOUNT_CLOSE_TOLERANCE_PCT) {
      score += AMOUNT_CLOSE_SCORE;
    } else {
      return 0; // amount is the one required signal - without it, don't bother scoring the rest
    }

    if (line.transactionDate) {
      if (this.isSameCalendarDay(line.transactionDate, candidate.expenseDate)) {
        score += DATE_SAME_DAY_SCORE;
      } else {
        const days = Math.abs(
          (line.transactionDate.getTime() - candidate.expenseDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (days <= 3) score += DATE_WITHIN_3D_SCORE;
        else if (days <= 7) score += DATE_WITHIN_7D_SCORE;
      }
    }

    const haystack = normalizedDescription;
    const needles = [candidate.advertiserName, candidate.brandName, candidate.salesName].map(normalizeName);
    // An empty needle (name normalizes to nothing) must never "match" - every
    // haystack.includes('') is trivially true, which would award the merchant
    // bonus to every candidate for a line with no usable description.
    if (needles.some((needle) => needle.length > 0 && haystack.includes(needle))) {
      score += MERCHANT_MATCH_SCORE;
    }

    return score;
  }
}

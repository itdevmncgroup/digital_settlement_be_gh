import { createHash } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { BankTxnStatus, ExpenseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { normalizeName } from '../common/matching/normalize';
import { parseBankStatementPdf } from './bank-statement-parser.util';

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

    if (existing && !force) {
      return { ...(await this.findBatch(existing.id)), alreadyScanned: true };
    }

    const stored = await this.storage.save(file.buffer, 'bank-settlements', file.originalname);
    const lines = await parseBankStatementPdf(file.buffer);

    const batch = existing
      ? await this.prisma.bankSettlementBatch.update({
          where: { id: existing.id },
          data: { fileName: file.originalname, storageKey: stored.storageKey, uploadedById: actorId },
        })
      : await this.prisma.bankSettlementBatch.create({
          data: { fileName: file.originalname, storageKey: stored.storageKey, uploadedById: actorId, contentHash },
        });

    if (existing) {
      await this.prisma.bankTransaction.deleteMany({ where: { batchId: batch.id } });
    }

    const candidates = await this.loadCandidates();

    for (const line of lines) {
      const { expenseId, score } = this.bestMatch(line, candidates);
      const status =
        expenseId && score >= AUTO_MATCH_THRESHOLD
          ? BankTxnStatus.AUTO_MATCHED
          : expenseId && score >= REVIEW_THRESHOLD
          ? BankTxnStatus.REVIEW_REQUIRED
          : BankTxnStatus.UNMATCHED;

      await this.prisma.bankTransaction.create({
        data: {
          batchId: batch.id,
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
        await this.afterMatchChange(expenseId);
      }
    }

    await this.audit.log({
      userId: actorId,
      action: existing ? 'RESCAN' : 'UPLOAD',
      objectType: 'BankSettlementBatch',
      objectId: batch.id,
      newValue: { fileName: file.originalname, lineCount: lines.length },
    });

    return { ...(await this.findBatch(batch.id)), alreadyScanned: false };
  }

  async manualMatch(transactionId: string, expenseId: string, actorId: string) {
    const txn = await this.getTxnOrThrow(transactionId);
    const expense = await this.prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');

    const updated = await this.prisma.bankTransaction.update({
      where: { id: transactionId },
      data: {
        status: BankTxnStatus.MANUAL_MATCHED,
        matchedExpenseId: expenseId,
        matchedById: actorId,
        matchedAt: new Date(),
      },
      include: txnInclude,
    });

    await this.afterMatchChange(expenseId);
    if (txn.matchedExpenseId && txn.matchedExpenseId !== expenseId) {
      await this.afterMatchChange(txn.matchedExpenseId);
    }

    await this.audit.log({
      userId: actorId,
      action: 'MANUAL_MATCH',
      objectType: 'BankTransaction',
      objectId: transactionId,
      oldValue: { status: txn.status, matchedExpenseId: txn.matchedExpenseId },
      newValue: { status: updated.status, matchedExpenseId: updated.matchedExpenseId },
    });
    return updated;
  }

  async unmatch(transactionId: string, actorId: string) {
    const txn = await this.getTxnOrThrow(transactionId);

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
      await this.afterMatchChange(txn.matchedExpenseId);
    }

    await this.audit.log({
      userId: actorId,
      action: 'UNMATCH',
      objectType: 'BankTransaction',
      objectId: transactionId,
      oldValue: { status: txn.status, matchedExpenseId: txn.matchedExpenseId },
      newValue: { status: updated.status },
    });
    return updated;
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
  private async recomputeIsMatched(expenseId: string): Promise<boolean> {
    const stillMatched = await this.prisma.bankTransaction.count({
      where: { matchedExpenseId: expenseId, status: { in: [BankTxnStatus.AUTO_MATCHED, BankTxnStatus.MANUAL_MATCHED] } },
    });
    const isMatched = stillMatched > 0;
    await this.prisma.expense.update({ where: { id: expenseId }, data: { isMatched } });
    return isMatched;
  }

  // Being bank-matched is the sole gate into the Expense approval chain (there's
  // no separate manual Submit step) - newly matched while DRAFT enters the chain;
  // unmatched while still mid-chain reverts it to DRAFT. REJECTED/SETTLED are left
  // alone either way (a rejected-and-not-yet-edited or already-settled Expense
  // shouldn't silently resurrect just because its bank match was toggled).
  private async afterMatchChange(expenseId: string): Promise<void> {
    const isMatched = await this.recomputeIsMatched(expenseId);
    const expense = await this.prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });

    if (isMatched && expense.status === ExpenseStatus.DRAFT) {
      await this.prisma.$transaction((tx) =>
        this.approvals.enterExpenseApproval(tx, {
          expenseId,
          amount: expense.amount,
          podId: expense.podId,
          departmentId: expense.departmentId,
        }),
      );
    } else if (
      !isMatched &&
      expense.status !== ExpenseStatus.DRAFT &&
      expense.status !== ExpenseStatus.REJECTED &&
      expense.status !== ExpenseStatus.SETTLED
    ) {
      await this.prisma.$transaction((tx) => this.approvals.cancelExpenseApproval(tx, expenseId));
    }
  }

  private async loadCandidates(): Promise<Candidate[]> {
    const expenses = await this.prisma.expense.findMany({
      where: { isMatched: false },
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
  ): { expenseId: string | null; score: number } {
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
        return { expenseId: exactMatches[0].id, score: 100 };
      }
    }

    const normalizedDescription = normalizeName(line.rawDescription);
    const scored = candidates
      .map((c) => ({ id: c.id, score: this.scoreCandidate(line, normalizedDescription, c) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { expenseId: null, score: 0 };

    const best = scored[0];
    const runnerUp = scored[1];
    // A tight race between the top two candidates means we're not confident
    // enough to auto-match, even if the raw score cleared the threshold.
    if (best.score >= AUTO_MATCH_THRESHOLD && runnerUp && best.score - runnerUp.score < AUTO_MATCH_MARGIN) {
      return { expenseId: best.id, score: REVIEW_THRESHOLD };
    }
    return { expenseId: best.id, score: best.score };
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
    if (
      haystack.includes(normalizeName(candidate.advertiserName)) ||
      haystack.includes(normalizeName(candidate.brandName)) ||
      haystack.includes(normalizeName(candidate.salesName))
    ) {
      score += MERCHANT_MATCH_SCORE;
    }

    return score;
  }
}

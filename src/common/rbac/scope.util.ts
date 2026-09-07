import { RoleName } from '../constants/role-name';
import { AuthUser } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

const BACK_OFFICE_ROLES: string[] = [RoleName.ADMIN, RoleName.FINANCE, RoleName.SUPERVISOR, RoleName.MANAGEMENT];

/** True if the user can see records beyond their own (Admin/Finance/Supervisor/Management). */
export function canViewAllRecords(user: AuthUser): boolean {
  return user.roles.some((r) => BACK_OFFICE_ROLES.includes(r));
}

const OWNPOD_EXPENSE_PERMISSIONS = ['expense.read.ownpod', 'expense.approve.ownpod', 'expense.edit.ownpod'];
const ALL_EXPENSE_PERMISSIONS = ['expense.read.all', 'expense.approve.all', 'expense.edit.all'];

/**
 * True if the actor may view an Expense-owned record (photo, invoice/file) that
 * isn't theirs: back-office roles per canViewAllRecords(), an expense.*.all
 * permission holder, a SALES_ADMIN whose POD (PodMember) covers the expense's
 * POD, or an expense.*.ownpod permission holder (e.g. a HEAD_POD/BOD approver -
 * PodPositionAssignment, not PodMember) whose own POD(s) cover it - same
 * POD-scoping ExpensesService's resolveScope()/canEditExpense() already apply
 * elsewhere, extended here so photos/invoices don't 403 while the expense row
 * (and its Approve button) they belong to is already visible.
 */
export async function canAccessExpenseOwnedRecord(
  prisma: PrismaService,
  actor: AuthUser,
  owner: { salesId: string; podId?: string | null },
): Promise<boolean> {
  if (owner.salesId === actor.userId) return true;
  if (canViewAllRecords(actor)) return true;
  if (actor.permissions?.some((p) => ALL_EXPENSE_PERMISSIONS.includes(p))) return true;
  if (!owner.podId) return false;
  if (actor.roles.includes(RoleName.SALES_ADMIN)) {
    const membership = await prisma.podMember.findFirst({ where: { salesId: actor.userId, podId: owner.podId } });
    if (membership) return true;
  }
  if (actor.permissions?.some((p) => OWNPOD_EXPENSE_PERMISSIONS.includes(p))) {
    const [membership, assignment] = await Promise.all([
      prisma.podMember.findFirst({ where: { salesId: actor.userId, podId: owner.podId } }),
      prisma.podPositionAssignment.findFirst({ where: { userId: actor.userId, podId: owner.podId, status: 'ACTIVE' } }),
    ]);
    if (membership || assignment) return true;
  }
  return false;
}

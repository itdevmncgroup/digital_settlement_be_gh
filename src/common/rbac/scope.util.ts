import { Prisma } from '@prisma/client';
import { RoleName } from '../constants/role-name';
import { AuthUser } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

const BACK_OFFICE_ROLES: string[] = [RoleName.ADMIN, RoleName.MANAGEMENT];

/** True if the user can see records beyond their own (Admin/Management). */
export function canViewAllRecords(user: AuthUser): boolean {
  return user.roles.some((r) => BACK_OFFICE_ROLES.includes(r));
}

/**
 * A user's "own Department(s)": their UserDepartment membership rows (a
 * Sales/Sales Admin belonging to one or more Departments) plus any Department
 * they hold an active approval Position for (DepartmentPositionAssignment -
 * e.g. HEAD_POD, a Supervisor's "own" Department is never a membership row).
 * Shared by every service that used to compare a single User.departmentId.
 */
export async function getActorDepartmentIds(
  prisma: PrismaService | Prisma.TransactionClient,
  userId: string,
): Promise<string[]> {
  const [memberships, assignments] = await Promise.all([
    prisma.userDepartment.findMany({ where: { userId, status: 'ACTIVE' }, select: { departmentId: true } }),
    prisma.departmentPositionAssignment.findMany({ where: { userId, status: 'ACTIVE' }, select: { departmentId: true } }),
  ]);
  return Array.from(new Set([...memberships.map((m) => m.departmentId), ...assignments.map((a) => a.departmentId)]));
}

const OWNDEPT_EXPENSE_PERMISSIONS = ['expense.read.owndept', 'expense.approve.owndept', 'expense.edit.owndept'];
const ALL_EXPENSE_PERMISSIONS = ['expense.read.all', 'expense.approve.all', 'expense.edit.all'];

/**
 * True if the actor may view an Expense-owned record (photo, invoice/file) that
 * isn't theirs: back-office roles per canViewAllRecords(), an expense.*.all
 * permission holder, a SALES_ADMIN whose Department(s) (UserDepartment) cover
 * the expense's Department, or an expense.*.owndept permission holder (e.g. a
 * HEAD/BOD approver - DepartmentPositionAssignment, not UserDepartment)
 * whose own Department(s) cover it - same Department-scoping ExpensesService's
 * resolveScope()/canEditExpense() already apply elsewhere, extended here so
 * photos/invoices don't 403 while the expense row (and its Approve button)
 * they belong to is already visible.
 */
export async function canAccessExpenseOwnedRecord(
  prisma: PrismaService,
  actor: AuthUser,
  owner: { salesId: string; departmentId?: string | null },
): Promise<boolean> {
  if (owner.salesId === actor.userId) return true;
  if (canViewAllRecords(actor)) return true;
  if (actor.permissions?.some((p) => ALL_EXPENSE_PERMISSIONS.includes(p))) return true;
  if (actor.permissions?.some((p) => OWNDEPT_EXPENSE_PERMISSIONS.includes(p))) {
    const actorDeptIds = await getActorDepartmentIds(prisma, actor.userId);
    // No Department on the actor's own profile and no per-Department assignment
    // means their position sits above Department level (e.g. Co-Chief Sales
    // Officer) - they can access every Department's owned records.
    if (actorDeptIds.length === 0) return true;
    if (owner.departmentId && actorDeptIds.includes(owner.departmentId)) return true;
  }
  if (!owner.departmentId) return false;
  if (actor.roles.includes(RoleName.SALES_ADMIN)) {
    const actorDeptIds = await getActorDepartmentIds(prisma, actor.userId);
    if (actorDeptIds.includes(owner.departmentId)) return true;
  }
  return false;
}

// Attaching photos/invoices to an existing Expense is an edit: it needs one of
// the expense.edit.* permissions (ADMIN is back office and exempt).
// Exception: the owner's create flow (new-expense form) creates the Expense and
// then uploads its photos/invoices in follow-up requests, so the owner may still
// attach files for a short window after creating it, edit permission or not.
export const CREATE_FLOW_UPLOAD_WINDOW_MS = 15 * 60 * 1000;

export function canUploadExpenseFiles(
  expense: { salesId: string; createdAt: Date },
  actor: { userId: string; roles?: string[]; permissions?: string[] },
): boolean {
  const roles = actor.roles ?? [];
  const permissions = actor.permissions ?? [];
  if (roles.includes(RoleName.ADMIN)) return true;
  if (['expense.edit.all', 'expense.edit.own', 'expense.edit.owndept'].some((p) => permissions.includes(p))) return true;
  return expense.salesId === actor.userId && Date.now() - expense.createdAt.getTime() <= CREATE_FLOW_UPLOAD_WINDOW_MS;
}

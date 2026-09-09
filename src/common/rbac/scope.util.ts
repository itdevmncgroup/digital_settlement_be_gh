import { RoleName } from '../constants/role-name';
import { AuthUser } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

const BACK_OFFICE_ROLES: string[] = [RoleName.ADMIN, RoleName.FINANCE, RoleName.SUPERVISOR, RoleName.MANAGEMENT];

/** True if the user can see records beyond their own (Admin/Finance/Supervisor/Management). */
export function canViewAllRecords(user: AuthUser): boolean {
  return user.roles.some((r) => BACK_OFFICE_ROLES.includes(r));
}

const OWNDEPT_EXPENSE_PERMISSIONS = ['expense.read.owndept', 'expense.approve.owndept', 'expense.edit.owndept'];
const ALL_EXPENSE_PERMISSIONS = ['expense.read.all', 'expense.approve.all', 'expense.edit.all'];

/**
 * True if the actor may view an Expense-owned record (photo, invoice/file) that
 * isn't theirs: back-office roles per canViewAllRecords(), an expense.*.all
 * permission holder, a SALES_ADMIN whose Department (User.departmentId) covers
 * the expense's Department, or an expense.*.owndept permission holder (e.g. a
 * HEAD/BOD approver - DepartmentPositionAssignment, not User.departmentId)
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
    const [sales, hasAnyAssignment] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.userId }, select: { departmentId: true } }),
      prisma.departmentPositionAssignment.findFirst({ where: { userId: actor.userId, status: 'ACTIVE' } }),
    ]);
    // No Department on the actor's own profile and no per-Department assignment
    // means their position sits above Department level (e.g. Co-Chief Sales
    // Officer) - they can access every Department's owned records.
    if (!sales?.departmentId && !hasAnyAssignment) return true;
    if (sales?.departmentId && sales.departmentId === owner.departmentId) return true;
    if (owner.departmentId) {
      const assignment = await prisma.departmentPositionAssignment.findFirst({ where: { userId: actor.userId, departmentId: owner.departmentId, status: 'ACTIVE' } });
      if (assignment) return true;
    }
  }
  if (!owner.departmentId) return false;
  if (actor.roles.includes(RoleName.SALES_ADMIN)) {
    const sales = await prisma.user.findUnique({ where: { id: actor.userId }, select: { departmentId: true } });
    if (sales?.departmentId === owner.departmentId) return true;
  }
  return false;
}

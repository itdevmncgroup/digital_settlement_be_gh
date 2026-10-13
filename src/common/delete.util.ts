import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const inUse = (label: string) => new ConflictException(`${label} is still used by other data and cannot be deleted. Deactivate it instead.`);

/**
 * Runs a Prisma delete and turns a foreign-key violation (the row is still referenced by
 * Expenses, Approval Levels...) into a 409 the UI can show, instead of a 500. Postgres reports a
 * RESTRICT FK as SQLSTATE 23001, which Prisma doesn't map to P2003 (that's NO ACTION), so match
 * both. Master data that is in use should be deactivated (isActive = false), not deleted.
 */
export async function deleteRecord<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const known = err instanceof Prisma.PrismaClientKnownRequestError;
    if (known && (err.code === 'P2003' || err.code === 'P2014')) throw inUse(label);
    if (err instanceof Error && /23001|violates (RESTRICT setting of )?foreign key/i.test(err.message)) throw inUse(label);
    throw err;
  }
}

/**
 * For references whose FK is ON DELETE SET NULL (or CASCADE of real records): the database would
 * accept the delete and silently orphan those rows, so count them first and refuse instead.
 * `refs` is [what, count] pairs, e.g. ['user(s)', this.prisma.user.count({ where: { unitId: id } })].
 */
export async function assertUnused(label: string, refs: [string, Promise<number>][]) {
  const counts = await Promise.all(refs.map(([, count]) => count));
  const used = refs.map(([what], i) => (counts[i] > 0 ? `${counts[i]} ${what}` : '')).filter(Boolean);
  if (used.length > 0) {
    throw new ConflictException(`${label} is still used by ${used.join(', ')} and cannot be deleted. Reassign them first, or deactivate it instead.`);
  }
}

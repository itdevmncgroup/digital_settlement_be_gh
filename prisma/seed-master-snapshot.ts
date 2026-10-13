import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

// Loads the master-data snapshot in prisma/seed-data/master/*.json (produced by
// scripts/export-master-snapshot.js from a real database) into a FRESH database,
// keeping the original primary keys so every FK between the snapshot rows holds.
// Expenses, settlements, approvals in flight, bank statements, audit logs etc. are not
// part of it. prisma/seed.ts calls this first; its own upserts (keyed by code/name) then
// top the data up. Keep TABLE_ORDER in sync with MASTER_TABLES in the export script.
const TABLE_ORDER = [
  'roles',
  'permissions',
  'positions',
  'units',
  'departments',
  'users',
  'role_permissions',
  'user_roles',
  'user_departments',
  'department_position_assignments',
  'agencies',
  'advertisers',
  'brands',
  'department_assignments',
  'activity_types',
  'cost_centers',
  'expense_categories',
  'payment_methods',
  'merchants',
  'credit_cards',
  'sales_assignments',
  'approval_levels',
  'approval_level_steps',
  'approval_level_departments',
  'approval_level_requestor_positions',
  'approval_level_activity_types',
];

// Tables a migration also seeds, with the unique column that identifies a row (see the pre-delete below).
const NATURAL_KEY: Record<string, string> = { positions: 'code', activity_types: 'name', payment_methods: 'code' };

const CHUNK = 500;

export async function seedMasterSnapshot(prisma: PrismaClient) {
  const dir = path.join(__dirname, 'seed-data', 'master');
  if (!fs.existsSync(dir)) return;

  // Rows are inserted with their snapshot ids, so only do it on an empty database -
  // on one that already has its own Units/Users the ids would clash (SEED_MASTER_SNAPSHOT=force to override).
  if (process.env.SEED_MASTER_SNAPSHOT !== 'force' && ((await prisma.unit.count()) > 0 || (await prisma.user.count()) > 0)) {
    // eslint-disable-next-line no-console
    console.log('Master snapshot skipped: database already has data (set SEED_MASTER_SNAPSHOT=force to load anyway).');
    return;
  }

  const models = Prisma.dmmf.datamodel.models;
  for (const table of TABLE_ORDER) {
    const file = path.join(dir, `${table}.json`);
    if (!fs.existsSync(file)) continue;
    const model = models.find((m) => (m.dbName ?? m.name) === table);
    if (!model) continue;

    const rows = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>[];
    const delegate = (prisma as unknown as Record<string, { createMany: (args: unknown) => Promise<{ count: number }> }>)[
      model.name.charAt(0).toLowerCase() + model.name.slice(1)
    ];
    // A migration can pre-insert a row (e.g. SLS-PARTNER Position, 20261007120000) with a random id.
    // On this empty DB nothing references it yet, so drop it and let the snapshot row (same natural
    // key, original id) win - otherwise skipDuplicates skips the snapshot row and its FKs dangle.
    const key = NATURAL_KEY[table];
    if (key) {
      await (delegate as unknown as { deleteMany: (args: unknown) => Promise<unknown> }).deleteMany({
        where: { [key]: { in: rows.map((r) => r[key]) }, id: { notIn: rows.map((r) => r.id) } },
      });
    }
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      inserted += (await delegate.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true })).count;
    }
    // eslint-disable-next-line no-console
    console.log(`  snapshot ${table}: ${inserted}/${rows.length}`);
  }
}

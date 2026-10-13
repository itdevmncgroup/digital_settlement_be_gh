// Exports every MASTER-data table of a database into prisma/seed-data/master/<table>.json,
// which prisma/seed-master-snapshot.ts then loads on a fresh DB (npm run seed). Transactional
// data (expenses, settlements, approvals in flight, bank statements, audit logs, notifications...)
// is deliberately NOT exported.
//
// Reads from SNAPSHOT_SOURCE_URL if set, else the DATABASE_URL resolved from .env - so to
// snapshot a restored backup, point SNAPSHOT_SOURCE_URL at it. Read-only (SELECT only).
//
//   node scripts/export-master-snapshot.js
//   SNAPSHOT_SOURCE_URL=postgresql://user:pw@host:5432/other_db node scripts/export-master-snapshot.js
//
// Columns are matched to the CURRENT Prisma schema through the DMMF (column name -> field name,
// so @map'ed columns work) and anything the current schema no longer has is dropped, which lets
// an older dump be exported against a newer schema.
require('./resolve-database-url.js');
const fs = require('fs');
const path = require('path');
const { Prisma, PrismaClient } = require('@prisma/client');

// FK-safe load order (parents before children). Keep in sync with prisma/seed-master-snapshot.ts.
const MASTER_TABLES = [
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

const outDir = path.join(__dirname, '..', 'prisma', 'seed-data', 'master');
const sourceUrl = process.env.SNAPSHOT_SOURCE_URL || process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('No database URL - set SNAPSHOT_SOURCE_URL or DATABASE_URL');

const models = Prisma.dmmf.datamodel.models;
const prisma = new PrismaClient({ datasourceUrl: sourceUrl });

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(outDir, f));

  const summary = [];
  for (const table of MASTER_TABLES) {
    const model = models.find((m) => (m.dbName ?? m.name) === table);
    if (!model) {
      summary.push(`${table}: no model in current schema - skipped`);
      continue;
    }
    const fieldByColumn = new Map(
      model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => [f.dbName ?? f.name, f.name]),
    );

    let rows;
    try {
      rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`);
    } catch {
      summary.push(`${table}: not in source database - skipped`);
      continue;
    }

    const data = rows
      .map((row) => Object.fromEntries(Object.entries(row).filter(([col]) => fieldByColumn.has(col)).map(([col, v]) => [fieldByColumn.get(col), v])))
      .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    if (data.length === 0) {
      summary.push(`${table}: 0 rows`);
      continue;
    }
    fs.writeFileSync(
      path.join(outDir, `${table}.json`),
      JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n',
    );
    summary.push(`${table}: ${data.length} rows`);
  }
  console.log(summary.join('\n'));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

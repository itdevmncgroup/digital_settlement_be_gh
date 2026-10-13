// Merges the CURRENT users of a database into the master-data seed snapshot
// (prisma/seed-data/master/{users,user_roles,user_departments}.json) WITHOUT wiping the rest
// of it - unlike scripts/export-master-snapshot.js, which rewrites every file.
//
//  - users: matched by id, email or employeeId; the database row replaces the snapshot row.
//    Snapshot users that the database does not have are kept.
//  - positions: same merge (by id or code) - users.positionId points at them, so a stale
//    positions.json would break the seed's FKs.
//  - roles: same merge (by id or name). A snapshot role replaced by a DB role with a different id
//    (same name) has its old id remapped in the snapshot-only role_permissions/user_roles rows.
//  - permissions: same merge (by id or code). role_permissions: for every role in the database,
//    the snapshot's rows for that role are replaced by the database's.
//  - user_roles / user_departments: for every user present in the database, the snapshot's rows
//    for that user are replaced by the database's. Rows of kept (DB-absent) users stay.
//
// Reads from SNAPSHOT_SOURCE_URL if set, else the DATABASE_URL resolved from .env. Read-only.
//
//   node scripts/merge-users-into-seed.js
require('./resolve-database-url.js');
const fs = require('fs');
const path = require('path');
const { Prisma, PrismaClient } = require('@prisma/client');

const dir = path.join(__dirname, '..', 'prisma', 'seed-data', 'master');
const sourceUrl = process.env.SNAPSHOT_SOURCE_URL || process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('No database URL - set SNAPSHOT_SOURCE_URL or DATABASE_URL');

const models = Prisma.dmmf.datamodel.models;
const prisma = new PrismaClient({ datasourceUrl: sourceUrl });

const read = (t) => {
  const f = path.join(dir, `${t}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [];
};
const write = (t, rows) =>
  fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');

async function dump(table) {
  const model = models.find((m) => (m.dbName ?? m.name) === table);
  const fieldByColumn = new Map(
    model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => [f.dbName ?? f.name, f.name]),
  );
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`);
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([c]) => fieldByColumn.has(c)).map(([c, v]) => [fieldByColumn.get(c), v])),
  );
}

// Dates come back from JSON as ISO strings, from the DB as Date - normalise so output is uniform.
const norm = (rows) => JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

async function main() {
  const dbUsers = norm(await dump('users'));
  const dbRoles = norm(await dump('user_roles'));
  const dbDepts = norm(await dump('user_departments'));

  // --- positions (FK target of users.positionId)
  const dbPos = norm(await dump('positions'));
  const oldPos = read('positions');
  const posIds = new Set(dbPos.map((p) => p.id));
  const posCodes = new Set(dbPos.map((p) => p.code));
  const keptPos = oldPos.filter((p) => !posIds.has(p.id) && !posCodes.has(p.code));
  write('positions', [...keptPos, ...dbPos].sort((a, b) => a.id.localeCompare(b.id)));
  console.log(`positions: snapshot ${oldPos.length} -> db ${dbPos.length}, kept ${keptPos.length}, total ${keptPos.length + dbPos.length}`);

  // --- roles (FK target of role_permissions / user_roles)
  const dbRolesAll = norm(await dump('roles'));
  const oldRolesAll = read('roles');
  const roleIdsDb = new Set(dbRolesAll.map((r) => r.id));
  const roleNamesDb = new Set(dbRolesAll.map((r) => r.name));
  const keptRoles = oldRolesAll.filter((r) => !roleIdsDb.has(r.id) && !roleNamesDb.has(r.name));
  write('roles', [...keptRoles, ...dbRolesAll].sort((a, b) => a.id.localeCompare(b.id)));
  const roleIdByName = new Map(dbRolesAll.map((r) => [r.name, r.id]));
  const roleRemap = new Map(oldRolesAll.filter((r) => roleNamesDb.has(r.name) && !roleIdsDb.has(r.id)).map((r) => [r.id, roleIdByName.get(r.name)]));
  const remapRole = (row) => (roleRemap.has(row.roleId) ? { ...row, roleId: roleRemap.get(row.roleId) } : row);
  const dedupe = (rows, keyFn) => [...new Map(rows.map((r) => [keyFn(r), r])).values()];
  console.log(`roles: snapshot ${oldRolesAll.length} -> db ${dbRolesAll.length}, kept ${keptRoles.length}, remapped ids ${roleRemap.size}`);

  // --- permissions + role_permissions
  const dbPerms = norm(await dump('permissions'));
  const oldPerms = read('permissions');
  const permIds = new Set(dbPerms.map((p) => p.id));
  const permCodes = new Set(dbPerms.map((p) => p.code));
  const keptPerms = oldPerms.filter((p) => !permIds.has(p.id) && !permCodes.has(p.code));
  write('permissions', [...keptPerms, ...dbPerms].sort((a, b) => a.id.localeCompare(b.id)));
  const dbRoleIds = roleIdsDb;
  const oldRP = read('role_permissions');
  const rolePerms = dedupe(
    [...oldRP.map(remapRole).filter((r) => !dbRoleIds.has(r.roleId)), ...norm(await dump('role_permissions'))],
    (r) => r.roleId + r.permissionId,
  ).sort(
    (a, b) => a.roleId.localeCompare(b.roleId) || a.permissionId.localeCompare(b.permissionId),
  );
  write('role_permissions', rolePerms);
  console.log(`permissions: snapshot ${oldPerms.length} -> db ${dbPerms.length}, kept ${keptPerms.length}, total ${keptPerms.length + dbPerms.length}`);
  console.log(`role_permissions: snapshot ${oldRP.length} -> ${rolePerms.length}`);

  // --- users
  const old = read('users');
  const ids = new Set(dbUsers.map((u) => u.id));
  const emails = new Set(dbUsers.map((u) => u.email));
  const empIds = new Set(dbUsers.map((u) => u.employeeId));
  const kept = old.filter((u) => !ids.has(u.id) && !emails.has(u.email) && !empIds.has(u.employeeId));
  const replaced = old.length - kept.length;
  const users = [...kept, ...dbUsers].sort((a, b) => a.id.localeCompare(b.id));
  write('users', users);
  const keptIds = new Set(kept.map((u) => u.id));
  const allIds = new Set(users.map((u) => u.id));

  // --- user_roles (drop snapshot rows of any user that's replaced/dropped, then add DB's)
  const roles = dedupe([...read('user_roles').filter((r) => keptIds.has(r.userId)).map(remapRole), ...dbRoles], (r) => r.userId + r.roleId).sort(
    (a, b) => a.userId.localeCompare(b.userId) || a.roleId.localeCompare(b.roleId),
  );
  write('user_roles', roles);

  // --- user_departments
  const depts = [...read('user_departments').filter((r) => keptIds.has(r.userId)), ...dbDepts].sort((a, b) => a.id.localeCompare(b.id));
  write('user_departments', depts);

  console.log(`users: snapshot ${old.length} -> db ${dbUsers.length}, replaced ${replaced}, kept ${kept.length}, total ${users.length}`);
  console.log(`user_roles: ${roles.length}, user_departments: ${depts.length}`);

  // --- FK sanity against the other snapshot files
  const refs = [
    ['users.unitId', users.map((u) => u.unitId), 'units', 'id'],
    ['users.positionId', users.map((u) => u.positionId), 'positions', 'id'],
    ['user_roles.roleId', roles.map((r) => r.roleId), 'roles', 'id'],
    ['role_permissions.roleId', rolePerms.map((r) => r.roleId), 'roles', 'id'],
    ['role_permissions.permissionId', rolePerms.map((r) => r.permissionId), 'permissions', 'id'],
    ['user_departments.departmentId', depts.map((d) => d.departmentId), 'departments', 'id'],
  ];
  for (const [label, vals, table, col] of refs) {
    const have = new Set(read(table).map((r) => r[col]));
    const missing = [...new Set(vals.filter((v) => v != null && !have.has(v)))];
    if (missing.length) console.log(`WARN ${label}: ${missing.length} id(s) missing in ${table}.json: ${missing.join(', ')}`);
  }
  for (const [label, rows] of [['user_roles', roles], ['user_departments', depts]]) {
    const bad = rows.filter((r) => !allIds.has(r.userId));
    if (bad.length) console.log(`WARN ${label}: ${bad.length} row(s) with unknown userId`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

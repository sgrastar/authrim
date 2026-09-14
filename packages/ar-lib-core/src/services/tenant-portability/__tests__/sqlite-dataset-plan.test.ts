import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  sqliteSnapshotPageQuery,
} from '../sqlite-snapshot';
import { sqliteSnapshotStartStatement } from '../sqlite-capture-plan';
import { packedSqliteRowToJson } from '../sqlite-packed-row';
import { expect, it } from 'vitest';
import {
  inspectBackupSchema,
  inventoryBackupSchemas,
} from '../../../../../../scripts/tenant-backup/schema-inventory';
import { planSqliteTenantDatasets } from '../sqlite-dataset-plan';
import type { TenantBackupSelection } from '../selection-contract';
const selection: TenantBackupSelection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' },
};
function schemas(sql: string) {
  return inspectBackupSchema([sql]).tables;
}
it('uses explicit tenants.id ownership and direct tenant_id, excludes users without dropping their classification', () => {
  const tables = schemas(`CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE oauth_clients(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL);`);
  const plan = planSqliteTenantDatasets('core', tables, selection);
  expect(plan.entries.map((entry) => [entry.table, entry.selection.action])).toEqual([
    ['oauth_clients', 'selected'],
    ['tenants', 'selected'],
    ['users', 'excluded'],
  ]);
  expect(plan.captureSchemas.map((schema) => schema.table)).toEqual(['oauth_clients', 'tenants']);
  expect(plan.captureSchemas[1]).toMatchObject({ tenantColumn: 'id' });
});
it('captures parent ownership even when the parent is a dependency rather than a selected dataset', () => {
  const plan = planSqliteTenantDatasets(
    'core',
    schemas(`
    CREATE TABLE object_catalog(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL);
    CREATE TABLE object_catalog_objects(id TEXT PRIMARY KEY NOT NULL,catalog_id TEXT NOT NULL);
  `),
    selection
  );
  const child = plan.entries.find((entry) => entry.table === 'object_catalog_objects');
  expect(child?.selection.action).toBe('resolve_references');
  expect(child?.capture).toMatchObject({
    parent: {
      childColumns: ['catalog_id'],
      schema: { table: 'object_catalog', tenantColumn: 'tenant_id' },
    },
  });
  expect(plan.captureSchemas.map((schema) => schema.table)).toEqual([
    'object_catalog',
    'object_catalog_objects',
  ]);
});
it('does not infer ownership from tenant_id when an explicit scoped rule exists', () => {
  const plan = planSqliteTenantDatasets(
    'admin',
    schemas(`
    CREATE TABLE admin_destinations(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT,scope_type TEXT,scope_id TEXT);
  `),
    selection
  );
  expect(plan.entries[0].concerns).toEqual([]);
  expect(plan.captureSchemas[0]).toMatchObject({
    tenantColumn: 'scope_id',
    scopeTypeColumn: 'scope_type',
  });
});
it('blocks partial capture when parent ownership cannot be resolved', () => {
  const plan = planSqliteTenantDatasets(
    'core',
    schemas(`
    CREATE TABLE oauth_clients(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT);
    CREATE TABLE object_catalog_objects(id TEXT PRIMARY KEY NOT NULL,catalog_id TEXT);
  `),
    selection
  );
  expect(plan.entries.find((entry) => entry.table === 'oauth_clients')?.capture).not.toBeNull();
  expect(plan.entries.find((entry) => entry.table === 'object_catalog_objects')?.concerns).toEqual([
    'backup_plan_parent_missing',
  ]);
  expect(plan.captureSchemas).toEqual([]);
});
it('requires the entire parent primary key', () => {
  const plan = planSqliteTenantDatasets(
    'core',
    schemas(`
    CREATE TABLE object_catalog(id TEXT NOT NULL,tenant_id TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
    CREATE TABLE object_catalog_objects(id TEXT PRIMARY KEY NOT NULL,catalog_id TEXT);
  `),
    selection
  );
  expect(plan.entries.find((entry) => entry.table === 'object_catalog_objects')?.concerns).toEqual([
    'backup_plan_parent_key_mismatch',
  ]);
});
it('fails closed for unclassified tables or duplicate inventory entries', () => {
  const tables = schemas('CREATE TABLE unknown_table(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT)');
  expect(() => planSqliteTenantDatasets('core', tables, selection)).toThrow(
    'backup_plan_unclassified_table'
  );
  expect(() => planSqliteTenantDatasets('core', [...tables, ...tables], selection)).toThrow(
    'backup_plan_duplicate_table'
  );
});
it('preserves log-window requirements and never turns current safety state off', () => {
  const plan = planSqliteTenantDatasets(
    'core',
    schemas(`CREATE TABLE audit_log(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT);`),
    {
      ...selection,
      logs: { audit: true, other: false, sensitive: false, period: 7 },
    }
  );
  expect(plan.entries[0].selection).toEqual({ action: 'selected', timeFilter: 'log_window' });
});

it('splits user grants from role and organization permission settings', () => {
  const tables = schemas(`CREATE TABLE resource_permissions(
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL
  );`);
  const settingsPlan = planSqliteTenantDatasets('core', tables, selection);
  const settingsEntry = settingsPlan.entries[0];
  expect(settingsEntry.rowPartitions).toEqual([
    { value: 'user', kind: 'users', selection: { action: 'excluded', reason: 'not_selected' } },
    { value: 'role', kind: 'settings', selection: { action: 'selected', timeFilter: 'none' } },
    { value: 'org', kind: 'settings', selection: { action: 'selected', timeFilter: 'none' } },
  ]);
  expect(settingsEntry.capture).toMatchObject({
    rowPartition: { column: 'subject_type', values: ['user', 'role', 'org'] },
  });

  const usersPlan = planSqliteTenantDatasets('core', tables, {
    ...selection,
    settings: false,
    users: true,
  });
  expect(usersPlan.entries[0].selection).toEqual({ action: 'selected', timeFilter: 'none' });
  expect(
    usersPlan.entries[0].rowPartitions?.map(({ value, selection }) => [value, selection.action])
  ).toEqual([
    ['user', 'selected'],
    ['role', 'excluded'],
    ['org', 'excluded'],
  ]);
});

it('stops snapshot admission when a partitioned table contains an unknown row kind', () => {
  const sql = `CREATE TABLE resource_permissions(
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL
  );`;
  const plan = planSqliteTenantDatasets('core', schemas(sql), selection);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`${sql}${SQLITE_SNAPSHOT_SCHEMA}`);
    for (const capture of plan.captureSchemas) db.exec(sqliteSnapshotTriggers(capture));
    db.exec("INSERT INTO resource_permissions VALUES ('bad','a','device')");
    const start = sqliteSnapshotStartStatement(plan.captureSchemas, 'snapshot', 'a');
    expect(db.prepare(start.sql).run(...start.params).changes).toBe(0);
    expect(db.prepare('SELECT count(*) AS count FROM tenant_backup_snapshots').get()).toEqual({
      count: 0,
    });
  } finally {
    db.close();
  }
});

it('keeps scoped settings and children at the original tenant boundary through scope moves', async () => {
  const sql = `CREATE TABLE admin_destinations(id TEXT PRIMARY KEY NOT NULL,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL);
    CREATE TABLE credential_secret_metadata(id TEXT PRIMARY KEY NOT NULL,destination_id TEXT NOT NULL,value TEXT);`;
  const plan = planSqliteTenantDatasets('admin', schemas(sql), selection);
  expect(plan.entries.every((entry) => entry.concerns.length === 0)).toBe(true);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql + SQLITE_SNAPSHOT_SCHEMA);
    db.exec(`INSERT INTO admin_destinations VALUES ('ours','tenant','a'),('platform','platform','a'),('other','tenant','b');
      INSERT INTO credential_secret_metadata VALUES ('our-key','ours','old'),('platform-key','platform','hidden'),('other-key','other','hidden');`);
    for (const schema of plan.captureSchemas) db.exec(sqliteSnapshotTriggers(schema));
    const start = sqliteSnapshotStartStatement(plan.captureSchemas, 'snapshot', 'a');
    expect(db.prepare(start.sql).run(...start.params).changes).toBe(1);
    db.exec(`UPDATE admin_destinations SET scope_type='platform' WHERE id='ours';
      UPDATE admin_destinations SET scope_type='tenant' WHERE id='platform';
      UPDATE credential_secret_metadata SET value='changed';
      INSERT INTO credential_secret_metadata VALUES ('new-key','platform','new');`);
    const child = plan.captureSchemas.find(
      (schema) => schema.table === 'credential_secret_metadata'
    )!;
    const rows = db.prepare(sqliteSnapshotPageQuery(child)).all('snapshot', 'a', '', 100);
    expect(rows).toHaveLength(1);
    const bytes = rows[0].row_json as Uint8Array;
    async function* chunks() {
      yield bytes;
    }
    let json = '';
    for await (const part of packedSqliteRowToJson(chunks(), child.columns))
      json += new TextDecoder().decode(part);
    expect(JSON.parse(json)).toMatchObject({ id: ['text', 'our-key'], value: ['text', 'old'] });
  } finally {
    db.close();
  }
});

it('pins tenantKey separately from tenant ID for logs and parent-owned key versions', async () => {
  const sql = `CREATE TABLE logging_key_registry(id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL);
    CREATE TABLE logging_key_versions(id TEXT PRIMARY KEY NOT NULL,key_registry_id TEXT NOT NULL,value TEXT);`;
  const plan = planSqliteTenantDatasets('admin', schemas(sql), selection);
  expect(plan.entries.every((entry) => entry.concerns.length === 0)).toBe(true);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql + SQLITE_SNAPSHOT_SCHEMA);
    db.exec(`INSERT INTO logging_key_registry VALUES ('ours','key-a'),('collision','a'),('other','key-b');
      INSERT INTO logging_key_versions VALUES ('our-key','ours','old'),('wrong-key','collision','hidden'),('other-key','other','hidden');`);
    for (const schema of plan.captureSchemas) db.exec(sqliteSnapshotTriggers(schema));
    expect(() => sqliteSnapshotStartStatement(plan.captureSchemas, 'snapshot', 'a')).toThrow(
      'snapshot_missing_tenant_key'
    );
    const start = sqliteSnapshotStartStatement(plan.captureSchemas, 'snapshot', 'a', 'key-a');
    expect(db.prepare(start.sql).run(...start.params).changes).toBe(1);
    expect(() => db.exec("UPDATE tenant_backup_snapshots SET tenant_key='key-b'")).toThrow(
      'snapshot_identity_immutable'
    );
    expect(() => db.exec("UPDATE tenant_backup_snapshots SET tenant_id='b'")).toThrow(
      'snapshot_identity_immutable'
    );
    db.exec(`UPDATE logging_key_registry SET tenant_key='key-b' WHERE id='ours';
      UPDATE logging_key_versions SET value='changed';`);
    for (const schema of plan.captureSchemas) {
      const rows = db.prepare(sqliteSnapshotPageQuery(schema)).all('snapshot', 'a', '', 100);
      expect(rows).toHaveLength(1);
      const bytes = rows[0].row_json as Uint8Array;
      async function* chunks() {
        yield bytes;
      }
      let json = '';
      for await (const part of packedSqliteRowToJson(chunks(), schema.columns))
        json += new TextDecoder().decode(part);
      const record = JSON.parse(json);
      if (schema.table === 'logging_key_versions')
        expect(record).toMatchObject({ id: ['text', 'our-key'], value: ['text', 'old'] });
      else expect(record).toMatchObject({ id: ['text', 'ours'], tenant_key: ['text', 'key-a'] });
      expect(
        db.prepare(sqliteSnapshotPageQuery(schema)).all('snapshot', 'b', '', 100)
      ).toHaveLength(0);
    }
  } finally {
    db.close();
  }
});

it('binds Admin children to their resource parent, never their actor identifiers', () => {
  for (const [child, parent, column] of [
    ['admin_passkeys', 'admin_users', 'admin_user_id'],
    ['agent_task_set_versions', 'agent_task_sets', 'task_set_id'],
    ['agent_scope_policy_versions', 'agent_scope_policies', 'scope_policy_id'],
    ['approval_request_approvals', 'approval_requests', 'approval_request_id'],
  ]) {
    const plan = planSqliteTenantDatasets(
      'admin',
      schemas(`
      CREATE TABLE ${parent}(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL);
      CREATE TABLE ${child}(id TEXT PRIMARY KEY NOT NULL,${column} TEXT NOT NULL,subject_id TEXT);
    `),
      { ...selection, admin: true }
    );
    expect(plan.entries.find((entry) => entry.table === child)?.capture).toMatchObject({
      parent: { childColumns: [column], schema: { table: parent, tenantColumn: 'tenant_id' } },
    });
  }
});

it('uses both plan ID and version to isolate Agent configuration steps', async () => {
  const sql = `CREATE TABLE agent_configuration_plans(id TEXT NOT NULL,version INTEGER NOT NULL,tenant_id TEXT NOT NULL,PRIMARY KEY(id,version));
    CREATE TABLE agent_configuration_plan_steps(plan_id TEXT NOT NULL,plan_version INTEGER NOT NULL,step_id TEXT NOT NULL,value TEXT,PRIMARY KEY(plan_id,plan_version,step_id));`;
  const plan = planSqliteTenantDatasets('admin', schemas(sql), { ...selection, admin: true });
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql + SQLITE_SNAPSHOT_SCHEMA);
    db.exec(`INSERT INTO agent_configuration_plans VALUES ('same',1,'a'),('same',2,'b');
      INSERT INTO agent_configuration_plan_steps VALUES ('same',1,'step','old-a'),('same',2,'step','private-b');`);
    for (const schema of plan.captureSchemas) db.exec(sqliteSnapshotTriggers(schema));
    const start = sqliteSnapshotStartStatement(plan.captureSchemas, 's', 'a');
    expect(db.prepare(start.sql).run(...start.params).changes).toBe(1);
    db.exec(`UPDATE agent_configuration_plans SET tenant_id='b' WHERE version=1;
      UPDATE agent_configuration_plan_steps SET value='changed';`);
    const child = plan.captureSchemas.find(
      (schema) => schema.table === 'agent_configuration_plan_steps'
    );
    expect(child).toBeDefined();
    if (!child) throw new Error('missing_child');
    const rows = db.prepare(sqliteSnapshotPageQuery(child)).all('s', 'a', '', 100);
    expect(rows).toHaveLength(1);
    async function* chunks() {
      yield rows[0].row_json as Uint8Array;
    }
    let json = '';
    for await (const part of packedSqliteRowToJson(chunks(), child.columns))
      json += new TextDecoder().decode(part);
    expect(JSON.parse(json)).toMatchObject({
      plan_version: ['integer', '1'],
      value: ['text', 'old-a'],
    });
  } finally {
    db.close();
  }
});

it('excludes enrollment sessions while retaining invitation lifecycle records', () => {
  const plan = planSqliteTenantDatasets(
    'admin',
    schemas(`
    CREATE TABLE admin_invitations(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,status TEXT);
    CREATE TABLE admin_invitation_enrollments(token_hash TEXT PRIMARY KEY NOT NULL,invitation_id TEXT NOT NULL,state_json TEXT);
  `),
    { ...selection, admin: true }
  );
  expect(
    plan.entries.find((entry) => entry.table === 'admin_invitation_enrollments')?.selection
  ).toEqual({ action: 'excluded', reason: 'ephemeral' });
  expect(plan.captureSchemas.map((schema) => schema.table)).toEqual(['admin_invitations']);
});

it('plans the new Admin ownership adapters against manifest-selected migrations', () => {
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const stream = inventoryBackupSchemas(root).inspectedStreams.find(
    (stream) => stream.id === 'admin-d1'
  );
  if (!stream) throw new Error('missing_admin_stream');
  const plan = planSqliteTenantDatasets('admin', stream.tables, { ...selection, admin: true });
  for (const table of [
    'admin_passkeys',
    'agent_task_set_versions',
    'agent_scope_policy_versions',
    'approval_request_approvals',
    'agent_configuration_plan_steps',
  ]) {
    const entry = plan.entries.find((entry) => entry.table === table);
    expect(entry?.concerns, table).toEqual([]);
    expect(entry?.capture, table).not.toBeNull();
  }
});

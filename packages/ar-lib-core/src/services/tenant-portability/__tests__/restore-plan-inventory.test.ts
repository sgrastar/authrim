import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { DatabaseAdapter } from '../../../db/adapter';
import { DatabaseTenantBackupRestorePlanInventory } from '../restore-plan-inventory';

let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
let now: number;
const inputDigest = 'ab'.repeat(32);
const lease = {
  operationId: 'operation',
  tenantId: 'tenant',
  owner: 'worker',
  fencingToken: 1,
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '010_tenant_backup_execution_inventory.sql',
    '019_tenant_backup_input_validations.sql',
    '024_tenant_backup_restore_plan_inventory.sql',
  ])
    db.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${file}`, import.meta.url),
        'utf8'
      )
    );
  now = 100;
  db.prepare(
    `INSERT INTO tenant_backup_operations
    (id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,created_at,updated_at,revision,fencing_token,lease_owner,lease_expires_at)
    VALUES ('operation','tenant','import','request',?,'running','prepare_restore_plan','admin',1,1,1,1,'worker',1000)`
  ).run('cd'.repeat(32));
  db.prepare(
    `INSERT INTO tenant_backup_execution_inventories
    (operation_id,tenant_id,request_digest,state,item_count,chain_digest,created_at)
    VALUES ('operation','tenant',?,'sealed',0,?,1)`
  ).run('cd'.repeat(32), inputDigest);
  db.prepare(
    `INSERT INTO tenant_backup_validation_sessions
    (id,tenant_id,operation_id,fencing_token,state,created_at)
    VALUES ('validation','tenant','operation',1,'sealed',1)`
  ).run();
  db.prepare(
    `INSERT INTO tenant_backup_input_validations
    (operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance)
    VALUES ('operation','tenant','validation',?,0,0)`
  ).run(inputDigest);
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
  };
});
afterEach(() => db.close());

it('builds and seals a restore plan separately from the sealed input inventory', async () => {
  const inventory = new DatabaseTenantBackupRestorePlanInventory(adapter, lease, () => now);
  expect(await inventory.create(inputDigest)).toMatchObject({
    state: 'building',
    input_inventory_digest: inputDigest,
    item_count: 0,
  });
  await inventory.append(0, 'restore-target:core', '{"kind":"target"}');
  await inventory.append(0, 'restore-target:core', '{"kind":"target"}');
  const head = await inventory.headForLease(lease);
  expect(head.item_count).toBe(1);
  expect(await inventory.readPage(0)).toMatchObject([
    { ordinal: 0, item_id: 'restore-target:core', payload_json: '{"kind":"target"}' },
  ]);
  await expect(inventory.append(0, 'restore-target:core', '{"kind":"changed"}')).rejects.toThrow(
    'retry_conflict'
  );
  expect(await inventory.seal(1, head.chain_digest)).toMatchObject({ state: 'sealed' });
  await expect(inventory.append(1, 'later', '{}')).rejects.toThrow('append_conflict');
  expect(() =>
    db.exec("UPDATE tenant_backup_restore_plan_inventory_items SET payload_json='{}'")
  ).toThrow('immutable');
});

it('adopts an exact plan after an unknown create or append response', async () => {
  let loseCreate = true;
  let loseAppend = true;
  const uncertain = {
    ...adapter,
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const value = await adapter.queryOne<T>(sql, params);
      if (loseCreate && sql.startsWith('INSERT INTO tenant_backup_restore_plan_inventories')) {
        loseCreate = false;
        throw new Error('lost_create_response');
      }
      if (loseAppend && sql.startsWith('INSERT INTO tenant_backup_restore_plan_inventory_items')) {
        loseAppend = false;
        throw new Error('lost_append_response');
      }
      return value;
    },
  };
  const first = new DatabaseTenantBackupRestorePlanInventory(uncertain, lease, () => now);
  await expect(first.create(inputDigest)).rejects.toThrow('lost_create_response');
  await first.create(inputDigest);
  await expect(first.append(0, 'restore-target:core', '{}')).rejects.toThrow(
    'lost_append_response'
  );
  await first.append(0, 'restore-target:core', '{}');
  expect((await first.headForLease(lease)).item_count).toBe(1);
});

it('fails closed when input validation, tenant, lease, or input digest changes', async () => {
  const inventory = new DatabaseTenantBackupRestorePlanInventory(adapter, lease, () => now);
  await inventory.create(inputDigest);
  await expect(inventory.create('ef'.repeat(32))).rejects.toThrow('retry_conflict');
  await expect(inventory.headForLease({ ...lease, tenantId: 'other' })).rejects.toThrow('fenced');
  now = 1001;
  await expect(inventory.headForLease(lease)).rejects.toThrow('fenced');
  now = 100;
  db.exec('DELETE FROM tenant_backup_input_validations');
  await expect(inventory.headForLease(lease)).rejects.toThrow('fenced');
});

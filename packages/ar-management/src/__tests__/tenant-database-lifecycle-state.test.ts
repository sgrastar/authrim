/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- node:sqlite has no types in this package */
import { readFileSync } from 'node:fs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { updateTenantDatabaseLifecycleState } from '../tenant-deletion-jobs';

const BASELINE = fileURLToPath(
  new URL('../../../../migrations/admin/d1/001_0_5_0_admin_baseline.sql', import.meta.url)
);

function setup() {
  const db = new DatabaseSync(':memory:');
  const baseline = readFileSync(BASELINE, 'utf8');
  for (const table of ['tenant_database_registry', 'tenant_database_active_pointers']) {
    const match = new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`, 'u').exec(baseline);
    if (!match) throw new Error(`baseline_ddl_missing:${table}`);
    db.exec(match[0]);
  }
  db.prepare(
    `INSERT INTO tenant_database_registry (tenant_id, role, generation, shard_group, shard_index,
       provider, database_id, database_name, binding_ref, schema_version, status, shard_count,
       shard_key_strategy) VALUES ('t', 'tenant_core', 1, 'default', 0, 'd1', 'd', 'n', 'B', 2,
       'active', 1, 'none')`
  ).run();
  db.prepare(
    `INSERT INTO tenant_database_active_pointers (tenant_id, role, shard_group, generation,
       shard_count, shard_key_strategy, runtime_generation, status)
     VALUES ('t', 'tenant_core', 'default', 1, 1, 'none', 4, 'active')`
  ).run();
  const calls: string[] = [];
  const adapter = {
    async execute(sql: string, params: unknown[] = []) {
      calls.push(sql);
      const result = db.prepare(sql).run(...(params as never[]));
      return { rowsAffected: Number(result.changes) };
    },
  };
  const state = () => ({
    pointer: db
      .prepare('SELECT status, runtime_generation FROM tenant_database_active_pointers')
      .get(),
    registry: db.prepare('SELECT status FROM tenant_database_registry').get(),
  });
  return { adapter, calls, state, db };
}

describe('updateTenantDatabaseLifecycleState', () => {
  it('disables the pointers before touching the registry rows', async () => {
    const { adapter, calls } = setup();
    await updateTenantDatabaseLifecycleState(adapter as never, 't', 'job-1', 'deleting');
    expect(calls[0]).toContain('tenant_database_active_pointers');
    expect(calls[1]).toContain('tenant_database_registry');
  });

  it('is idempotent: repeated calls do not bump the runtime generation again', async () => {
    const { adapter, state } = setup();
    await updateTenantDatabaseLifecycleState(adapter as never, 't', 'job-1', 'deleting');
    expect(state()).toEqual({
      pointer: { status: 'disabled', runtime_generation: 5 },
      registry: { status: 'deleting' },
    });
    await updateTenantDatabaseLifecycleState(adapter as never, 't', 'job-1', 'deleting');
    await updateTenantDatabaseLifecycleState(adapter as never, 't', 'job-1', 'deleted');
    await updateTenantDatabaseLifecycleState(adapter as never, 't', 'job-1', 'deleted');
    expect(state()).toEqual({
      pointer: { status: 'disabled', runtime_generation: 5 },
      registry: { status: 'deleted' },
    });
  });

  it('completes from the intermediate state (pointers disabled, registry still active)', async () => {
    const { adapter, state, db } = setup();
    db.prepare(
      "UPDATE tenant_database_active_pointers SET status = 'disabled', runtime_generation = 5"
    ).run();
    await updateTenantDatabaseLifecycleState(adapter as never, 't', 'job-1', 'deleting');
    expect(state()).toEqual({
      pointer: { status: 'disabled', runtime_generation: 5 },
      registry: { status: 'deleting' },
    });
  });
});

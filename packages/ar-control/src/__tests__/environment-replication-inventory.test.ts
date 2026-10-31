import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, it } from 'vitest';
import type { ControlEnv } from '../types';
import { readControlEnvironmentReplicationInventory } from '../environment-replication-inventory';
it('reads only authenticated environment placements and rejects partial inventory at the bound', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE control_tenant_placement_policies(environment_id TEXT,tenant_id TEXT,policy_state TEXT,policy_generation INTEGER);CREATE TABLE control_tenant_placement_migrations(environment_id TEXT,operation_id TEXT,active_operation_key TEXT);CREATE TABLE control_tenant_disaster_recovery_operations(environment_id TEXT,operation_id TEXT,active_operation_key TEXT);'
    );
    db.exec(
      "INSERT INTO control_tenant_placement_policies VALUES('test','tenant-a','active',1),('other','foreign','active',1)"
    );
    const adapter = {
      prepare(sql: string) {
        return {
          bind(...params: SQLInputValue[]) {
            return {
              async all() {
                return { results: db.prepare(sql).all(...params) };
              },
              async first() {
                return db.prepare(sql).get(...params) ?? null;
              },
            };
          },
        };
      },
    } as unknown as ControlEnv['CONTROL_DB'];
    expect(await readControlEnvironmentReplicationInventory(adapter, 'test')).toEqual({
      environmentId: 'test',
      complete: true,
      pendingOperations: false,
      tenants: [{ tenantId: 'tenant-a', policyState: 'active', policyGeneration: 1 }],
    });
    db.exec(
      "INSERT INTO control_tenant_disaster_recovery_operations VALUES('test','dr-a','active')"
    );
    expect(
      (await readControlEnvironmentReplicationInventory(adapter, 'test')).pendingOperations
    ).toBe(true);
    for (let i = 0; i < 128; i++)
      db.prepare('INSERT INTO control_tenant_placement_policies VALUES(?,?,?,1)').run(
        'test',
        `extra-${i}`,
        'active'
      );
    await expect(readControlEnvironmentReplicationInventory(adapter, 'test')).rejects.toThrow(
      'inventory_limit'
    );
  } finally {
    db.close();
  }
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTenantMigrationCapturePlan } from '../tenant-placement-migration-capture';
import type { TenantMigrationTableInventory } from '../tenant-placement-migration-inventory';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const inventory: TenantMigrationTableInventory[] = [
  {
    table: 'tenants',
    columns: [
      { name: 'id', primaryKeyPosition: 1 },
      { name: 'tenant_key', primaryKeyPosition: 0 },
      { name: 'name', primaryKeyPosition: 0 },
    ],
    primaryKey: ['id'],
    ownership: { kind: 'tenant_row', column: 'id' },
    disposition: 'migrate',
  },
  {
    table: 'users',
    columns: [
      { name: 'id', primaryKeyPosition: 1 },
      { name: 'tenant_id', primaryKeyPosition: 0 },
      { name: 'display_name', primaryKeyPosition: 0 },
    ],
    primaryKey: ['id'],
    ownership: { kind: 'tenant_column', column: 'tenant_id' },
    disposition: 'migrate',
  },
  {
    table: 'internal_notification_events',
    columns: [
      { name: 'id', primaryKeyPosition: 1 },
      { name: 'tenant_id', primaryKeyPosition: 0 },
    ],
    primaryKey: ['id'],
    ownership: { kind: 'tenant_column', column: 'tenant_id' },
    disposition: 'migrate',
  },
  {
    table: 'internal_notification_delivery_attempts',
    columns: [
      { name: 'id', primaryKeyPosition: 1 },
      { name: 'event_id', primaryKeyPosition: 0 },
      { name: 'status', primaryKeyPosition: 0 },
    ],
    primaryKey: ['id'],
    ownership: {
      kind: 'parent',
      foreignKeyColumn: 'event_id',
      parentTable: 'internal_notification_events',
      parentKeyColumn: 'id',
      parentTenantColumn: 'tenant_id',
    },
    disposition: 'migrate',
  },
];

describe('tenant placement migration capture triggers', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        display_name TEXT NOT NULL
      );
      CREATE TABLE internal_notification_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL
      );
      CREATE TABLE internal_notification_delivery_attempts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES internal_notification_events(id)
      );
    `);
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/040_tenant_placement_migration_outbox.sql'),
        'utf8'
      )
    );
    database
      .prepare('INSERT INTO tenants (id, tenant_key, name) VALUES (?, ?, ?)')
      .run('tenant-a', 'tenant-key-a', 'Tenant A');
    database
      .prepare('INSERT INTO tenants (id, tenant_key, name) VALUES (?, ?, ?)')
      .run('tenant-b', 'tenant-key-b', 'Tenant B');
  });

  afterEach(() => database.close());

  async function install(): Promise<void> {
    const plan = await buildTenantMigrationCapturePlan({
      operationId: 'placement-migration:test-a',
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      sourceShardId: 'shared-users-jp-1',
      migrationGeneration: 2,
      fencingToken: 7,
      inventory,
      now: 100,
    });
    for (const query of plan.install) {
      if (query.params) database.prepare(query.sql).run(...(query.params as string[]));
      else database.exec(query.sql);
    }
  }

  it('records only the migrating tenant mutation in the same local transaction', async () => {
    await install();

    database.exec('BEGIN IMMEDIATE');
    database
      .prepare('INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)')
      .run('user-a-rolled-back', 'tenant-a', 'Rolled Back');
    database.exec('ROLLBACK');
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM tenant_placement_migration_outbox').get()
    ).toEqual({ count: 0 });

    database
      .prepare('INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)')
      .run('user-a', 'tenant-a', 'User A');
    database
      .prepare('INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)')
      .run('user-b', 'tenant-b', 'User B');

    const rows = database
      .prepare(
        `SELECT tenant_id, table_name, mutation_kind, mutation_key_json, row_json,
                capture_fencing_token
           FROM tenant_placement_migration_outbox
          ORDER BY source_sequence`
      )
      .all();
    expect(rows).toEqual([
      {
        tenant_id: 'tenant-a',
        table_name: 'users',
        mutation_kind: 'upsert',
        mutation_key_json: '{"id":"user-a"}',
        row_json: '{"id":"user-a","tenant_id":"tenant-a","display_name":"User A"}',
        capture_fencing_token: 7,
      },
    ]);
  });

  it('captures indirectly owned rows through their authoritative parent', async () => {
    await install();
    database
      .prepare('INSERT INTO internal_notification_events (id, tenant_id) VALUES (?, ?)')
      .run('event-a', 'tenant-a');
    database
      .prepare(
        `INSERT INTO internal_notification_delivery_attempts (id, event_id, status)
         VALUES (?, ?, ?)`
      )
      .run('attempt-a', 'event-a', 'queued');

    expect(
      database
        .prepare(
          `SELECT table_name, mutation_kind
             FROM tenant_placement_migration_outbox
            ORDER BY source_sequence`
        )
        .all()
    ).toEqual([
      { table_name: 'internal_notification_events', mutation_kind: 'upsert' },
      { table_name: 'internal_notification_delivery_attempts', mutation_kind: 'upsert' },
    ]);
  });

  it('write-fences only the migrating tenant and leaves co-resident tenants available', async () => {
    await install();
    database
      .prepare(
        `UPDATE tenant_placement_migration_captures
            SET capture_state = 'write_fenced', write_fenced_at = ?, updated_at = ?
          WHERE operation_id = ? AND fencing_token = ?`
      )
      .run(110, 110, 'placement-migration:test-a', 7);

    expect(() =>
      database
        .prepare('INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)')
        .run('user-a', 'tenant-a', 'User A')
    ).toThrow('tenant_placement_migration_write_fenced');
    expect(() =>
      database
        .prepare('INSERT INTO users (id, tenant_id, display_name) VALUES (?, ?, ?)')
        .run('user-b', 'tenant-b', 'User B')
    ).not.toThrow();
  });
});

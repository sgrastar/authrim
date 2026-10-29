import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupRestoreHoldStore } from '../restore-hold-store.js';
import type { GuestCurrentDenyWitness } from '../guest-current-deny-witness';

const KEY = '22'.repeat(32);
let db: DatabaseSync;
let store: TenantBackupRestoreHoldStore;

function migration(name: string): string {
  return readFileSync(
    new URL(`../../../../../../migrations/admin/d1/${name}`, import.meta.url),
    'utf8'
  );
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '006_tenant_backup_request_intent.sql',
    '030_tenant_backup_restored_holds.sql',
  ])
    db.exec(migration(name));
  db.prepare(
    `INSERT INTO tenant_backup_operations
     (id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,created_at,
      updated_at,request_json)
     VALUES ('operation-a','tenant-a','import','request-a',?,'queued','apply_sqlite_dataset',
       'admin-a',100,100,?)`
  ).run('ab'.repeat(32), JSON.stringify({ selection: { users: true } }));
  const adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'> = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
  };
  store = new TenantBackupRestoreHoldStore(adapter);
});

afterEach(() => db.close());

describe('tenant backup restored hold store', () => {
  const input = {
    tenantId: 'tenant-a',
    operationId: 'operation-a',
    datasetId: 'core.plugin_hook_outbox',
    recordId: JSON.stringify([['text', 'outbox-a']]),
    reason: 'source_outbox',
    rowJson: JSON.stringify({ outbox_id: ['text', 'outbox-a'], status: ['text', 'queued'] }),
    encryptionKey: KEY,
    keyVersion: 1,
  };

  it('writes idempotently, verifies ciphertext and reports bounded counts', async () => {
    await store.write({ ...input, now: 200 });
    await store.write({ ...input, now: 201 });
    await expect(store.verify(input)).resolves.toBeUndefined();
    expect(await store.summaries('tenant-a', 'operation-a')).toEqual([
      { datasetId: 'core.plugin_hook_outbox', reason: 'source_outbox', count: 1 },
    ]);
    const row = db.prepare('SELECT payload_encrypted FROM tenant_backup_restored_holds').get() as {
      payload_encrypted: string;
    };
    expect(row.payload_encrypted).toMatch(/^enc:v1:gcm:/);
    expect(row.payload_encrypted).not.toContain('outbox-a');
  });

  it('rejects conflicting retries and keeps stored holds immutable', async () => {
    await store.write({ ...input, now: 200 });
    await expect(
      store.write({ ...input, rowJson: JSON.stringify({ changed: ['text', 'yes'] }), now: 201 })
    ).rejects.toThrow('backup_restore_hold_conflict');
    expect(() =>
      db.prepare("DELETE FROM tenant_backup_restored_holds WHERE operation_id='operation-a'").run()
    ).toThrow('backup_restored_hold_immutable');
  });

  const witness: GuestCurrentDenyWitness = {
    version: 1,
    purpose: 'guest-current-deny-v1',
    tenantId: 'tenant-a',
    operationId: 'operation-a',
    planDigest: 'a'.repeat(64),
    sourceEnvironmentId: 'same-environment',
    sourceIssuer: 'https://source.example',
    inventoryDigest: 'b'.repeat(64),
    epochs: [
      { family: 'core', resourceId: 'core-store', revision: 3 },
      { family: 'pii', resourceId: 'pii-store', revision: 4 },
    ],
    denyDigest: 'c'.repeat(64),
    markerCount: 2,
  };
  const witnessInput = {
    tenantId: 'tenant-a',
    operationId: 'operation-a',
    planDigest: witness.planDigest,
    encryptionKey: KEY,
    keyVersion: 1,
    authorize: async () => {},
    assertCurrentSource: async (actual: GuestCurrentDenyWitness) => {
      expect(actual).toEqual(witness);
    },
  };

  it('keeps encrypted current-source evidence separate from all user held/live summaries', async () => {
    await store.writeGuestCurrentDenyWitness({
      witness,
      encryptionKey: KEY,
      keyVersion: 1,
      now: 200,
      authorize: async () => {},
    });
    await store.writeGuestCurrentDenyWitness({
      witness,
      encryptionKey: KEY,
      keyVersion: 1,
      now: 201,
      authorize: async () => {},
    });
    expect(await store.readGuestCurrentDenyWitness(witnessInput)).toEqual(witness);
    expect(await store.summaries('tenant-a', 'operation-a')).toEqual([]);
    await store.write({ ...input, now: 202 });
    expect(await store.summaries('tenant-a', 'operation-a')).toEqual([
      { datasetId: 'core.plugin_hook_outbox', reason: 'source_outbox', count: 1 },
    ]);
    const stored = db
      .prepare(
        `SELECT payload_encrypted FROM tenant_backup_restored_holds
      WHERE dataset_id='internal.guest_current_deny_authority'`
      )
      .get() as { payload_encrypted: string };
    expect(stored.payload_encrypted).toMatch(/^enc:v1:gcm:/);
    expect(stored.payload_encrypted).not.toContain('pii-store');
  });

  it('refuses missing, stale, foreign-plan and unauthorized evidence without an empty success', async () => {
    await expect(store.readGuestCurrentDenyWitness(witnessInput)).rejects.toThrow(
      'authority_unavailable'
    );
    await store.writeGuestCurrentDenyWitness({
      witness,
      encryptionKey: KEY,
      keyVersion: 1,
      now: 200,
      authorize: async () => {},
    });
    await expect(
      store.readGuestCurrentDenyWitness({ ...witnessInput, planDigest: 'd'.repeat(64) })
    ).rejects.toThrow('authority_unavailable');
    await expect(
      store.readGuestCurrentDenyWitness({
        ...witnessInput,
        assertCurrentSource: async () => {
          throw new Error('source_epoch_changed');
        },
      })
    ).rejects.toThrow('source_epoch_changed');
    await expect(
      store.readGuestCurrentDenyWitness({
        ...witnessInput,
        authorize: async () => {
          throw new Error('lease_lost');
        },
      })
    ).rejects.toThrow('lease_lost');
    await expect(
      store.writeGuestCurrentDenyWitness({
        witness: {
          ...witness,
          epochs: [
            { family: 'core', resourceId: 'core-store', revision: 3 },
            { family: 'pii', resourceId: 'pii-store', revision: 5 },
          ],
        },
        encryptionKey: KEY,
        keyVersion: 1,
        now: 201,
        authorize: async () => {},
      })
    ).rejects.toThrow('backup_restore_hold_conflict');
  });
});

/**
 * The lifecycle guard of the canonical identity repository, on SQLite (D1's engine): a normal
 * update never moves an account or subject out of `deleting` / `deleted`.
 */
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter, ExecuteResult } from '../../db/adapter';
import { CanonicalIdentityRepository } from '../identity';

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
  close(): void;
}

function openDatabase(): Sqlite {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- node:sqlite is untyped here
  return new DatabaseSync(':memory:');
}

function adapterFor(database: Sqlite): DatabaseAdapter {
  return {
    query: async (sql: string, params: unknown[] = []) => database.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) =>
      database.prepare(sql).get(...params) ?? null,
    execute: async (sql: string, params: unknown[] = []): Promise<ExecuteResult> => ({
      success: true,
      rowsAffected: Number(database.prepare(sql).run(...params).changes),
    }),
    getType: () => 'd1',
  } as unknown as DatabaseAdapter;
}

describe('canonical lifecycle guard', () => {
  let database: Sqlite;
  let repository: CanonicalIdentityRepository;

  beforeEach(() => {
    database = openDatabase();
    database.exec(`
      CREATE TABLE identity_accounts (id TEXT PRIMARY KEY, tenant_id TEXT, lifecycle_state TEXT,
        display_label TEXT, metadata_json TEXT, updated_at INTEGER, deleted_at INTEGER,
        primary_subject_id TEXT);
      CREATE TABLE identity_subjects (id TEXT PRIMARY KEY, tenant_id TEXT, lifecycle_state TEXT,
        display_label TEXT, updated_at INTEGER, deleted_at INTEGER);
      INSERT INTO identity_accounts VALUES
        ('account:live', 'tenant-a', 'active', NULL, NULL, 1, NULL, 'subject:live'),
        ('account:deleting', 'tenant-a', 'deleting', NULL, NULL, 1, 1, NULL),
        ('account:deleted', 'tenant-a', 'deleted', NULL, NULL, 1, 1, 'subject:deleted');
      INSERT INTO identity_subjects VALUES
        ('subject:live', 'tenant-a', 'active', NULL, 1, NULL),
        ('subject:deleted', 'tenant-a', 'deleted', NULL, 1, 1);
    `);
    repository = new CanonicalIdentityRepository(adapterFor(database), 'tenant-a');
  });

  afterEach(() => database.close());

  const account = (id: string) =>
    database
      .prepare('SELECT lifecycle_state, deleted_at FROM identity_accounts WHERE id = ?')
      .get(id) as { lifecycle_state: string; deleted_at: number | null };
  const subject = (id: string) =>
    (
      database.prepare('SELECT lifecycle_state FROM identity_subjects WHERE id = ?').get(id) as {
        lifecycle_state: string;
      }
    ).lifecycle_state;

  it('updates a live account and subject as before', async () => {
    await expect(
      repository.updateAccountRuntimeFields('account:live', { lifecycleState: 'deprovisioned' })
    ).resolves.toBe(true);
    await expect(repository.transitionAccountLifecycle('account:live', 'active')).resolves.toBe(
      true
    );
    await expect(
      repository.updateSubjectRuntimeFields('subject:live', { lifecycleState: 'deprovisioned' })
    ).resolves.toBe(true);
    expect(account('account:live').lifecycle_state).toBe('active');
    expect(subject('subject:live')).toBe('deprovisioned');
  });

  it('never moves an account being deleted, or deleted, back to another state', async () => {
    for (const id of ['account:deleting', 'account:deleted']) {
      await expect(
        repository.updateAccountRuntimeFields(id, { lifecycleState: 'active' })
      ).resolves.toBe(false);
      await expect(
        repository.updateAccountRuntimeFields(id, {
          lifecycleState: 'active',
          metadata: { k: 'v' },
        })
      ).resolves.toBe(false);
      await expect(repository.transitionAccountLifecycle(id, 'suspended')).resolves.toBe(false);
    }
    expect(account('account:deleting')).toEqual({ lifecycle_state: 'deleting', deleted_at: 1 });
    expect(account('account:deleted')).toEqual({ lifecycle_state: 'deleted', deleted_at: 1 });
  });

  it('never moves a deleted subject back to another state', async () => {
    await expect(
      repository.updateSubjectRuntimeFields('subject:deleted', { lifecycleState: 'active' })
    ).resolves.toBe(false);
    await expect(repository.transitionSubjectLifecycle('subject:deleted', 'active')).resolves.toBe(
      false
    );
    expect(subject('subject:deleted')).toBe('deleted');
  });

  it("still lets a deletion's own move through", async () => {
    await expect(repository.transitionSubjectLifecycle('subject:live', 'deleted')).resolves.toBe(
      true
    );
    expect(subject('subject:live')).toBe('deleted');
  });

  it('keeps a subject another live account shares when one of them is deleted', async () => {
    database.exec(`
      INSERT INTO identity_subjects VALUES ('subject:shared', 'tenant-a', 'active', NULL, 1, NULL);
      INSERT INTO identity_accounts VALUES
        ('account:a', 'tenant-a', 'deleted', NULL, NULL, 1, 1, 'subject:shared'),
        ('account:b', 'tenant-a', 'active', NULL, NULL, 1, NULL, 'subject:shared');
    `);

    await expect(repository.deleteSubjectWithAccount('subject:shared', 'account:a')).resolves.toBe(
      false
    );
    expect(subject('subject:shared')).toBe('active');
    // Once the other account goes too, the subject goes with it.
    database.exec(
      "UPDATE identity_accounts SET lifecycle_state = 'deleting' WHERE id = 'account:b'"
    );
    await expect(repository.deleteSubjectWithAccount('subject:shared', 'account:b')).resolves.toBe(
      true
    );
    expect(subject('subject:shared')).toBe('deleted');
    // An unshared subject is deleted with its account.
    await expect(repository.deleteSubjectWithAccount('subject:live', 'account:live')).resolves.toBe(
      true
    );
  });
});

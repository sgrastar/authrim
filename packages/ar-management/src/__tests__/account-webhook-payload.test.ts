import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import {
  captureAccountDeletionSnapshot,
  persistAccountEmailMutation,
  type DatabaseAdapter,
  type WebhookConfigWithScope,
} from '@authrim/ar-lib-core';
import { materializeAccountWebhookPayload } from '../account-webhook-payload';

let db: SQLiteDatabase;
let adapter: DatabaseAdapter;
const owner = {
  id: 'account:u',
  tenant_id: 't',
  legacy_user_id: 'u',
  account_type: 'user',
  registration_state: 'registered' as const,
  directory_publication_state: 'active',
  lifecycle_state: 'active',
};
const destination: WebhookConfigWithScope = {
  id: 'w',
  tenantId: 't',
  scope: 'tenant',
  name: 'Email',
  url: 'https://example.com/hook',
  events: ['account.*'],
  payloadFields: ['email'],
  active: true,
  createdAt: '2020-01-01T00:00:00Z',
  updatedAt: '2020-01-01T00:00:00Z',
  timeoutMs: 1000,
  retryPolicy: { maxRetries: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 60000 },
};
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const file of [
    '001_0_4_0_pii_baseline.sql',
    '002_guest_upgrade_operations.sql',
    '003_account_webhook_outbox.sql',
    '004_account_webhook_snapshots.sql',
  ]) {
    db.exec(
      readFileSync(new URL(`../../../../migrations/pii/d1/${file}`, import.meta.url), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
  }
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) ?? null) as T | null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements)
          results.push(await adapter.execute(statement.sql, statement.params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as DatabaseAdapter;
  db.exec(`INSERT INTO identity_sensitive_values (id,tenant_id,owner_type,owner_id,value_key,value_json,classification,lifecycle_state,created_at,updated_at)
    VALUES ('email','t','runtime_user','u','email','"old@example.com"','sensitive','active',1,1)`);
});
afterEach(() => db.close());
const change = (email = 'new@example.com', invalid = false) =>
  persistAccountEmailMutation(adapter, owner, email, {
    sql: invalid
      ? 'INSERT INTO nonexistent VALUES (1)'
      : 'UPDATE identity_sensitive_values SET value_json = ? WHERE id = ?',
    params: invalid ? [] : [JSON.stringify(email), 'email'],
  });
const render = async (
  eventId: string,
  eventType: string,
  webhook = destination,
  now = Date.now()
) =>
  materializeAccountWebhookPayload({
    tenantId: 't',
    userId: 'u',
    eventId,
    eventType,
    webhook,
    now,
    occurredAt: now,
    data: { userId: 'u' },
    adapters: async () => [adapter],
  });
const emailEventId = () =>
  String(
    (
      db.prepare('SELECT id FROM account_webhook_outbox ORDER BY rowid LIMIT 1').get() as {
        id: string;
      }
    ).id
  );

describe('account webhook event-time field selection', () => {
  it('captures old/new email atomically and replays the original values after another change', async () => {
    await change();
    const id = emailEventId();
    const first = await render(id, 'account.email.changed');
    expect(first).toEqual({
      userId: 'u',
      account_id: 'account:u',
      changes: { email: { before: 'old@example.com', after: 'new@example.com' } },
    });
    await change('later@example.com');
    expect(await render(id, 'account.email.changed')).toEqual(first);
  });
  it('rolls back notification and snapshot if mutation fails', async () => {
    await expect(change('new@example.com', true)).rejects.toThrow();
    expect(db.prepare('SELECT * FROM account_webhook_snapshots').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM account_webhook_outbox').all()).toEqual([]);
  });
  it('does not emit a change for identical values', async () => {
    await change('old@example.com');
    expect(db.prepare('SELECT * FROM account_webhook_outbox').all()).toEqual([]);
  });
  it('preserves deleted account data after physical PII removal and idempotent capture', async () => {
    await captureAccountDeletionSnapshot(adapter, owner);
    db.exec('DELETE FROM identity_sensitive_values');
    await captureAccountDeletionSnapshot(adapter, owner);
    expect(await render('deleted-event', 'account.deleted')).toEqual({
      userId: 'u',
      account_id: 'account:u',
      before: { email: 'old@example.com' },
      after: null,
    });
  });
  it('sends identifiers only to a destination with no selected fields', async () => {
    await change();
    expect(
      await render(emailEventId(), 'account.email.changed', { ...destination, payloadFields: [] })
    ).toEqual({ userId: 'u' });
  });
  it('does not include an already removed email in an account deletion', async () => {
    db.exec("UPDATE identity_sensitive_values SET lifecycle_state = 'deleted'");
    await captureAccountDeletionSnapshot(adapter, owner);
    expect(await render('deleted-event', 'account.deleted')).toEqual({
      userId: 'u',
      account_id: 'account:u',
      before: { email: null },
      after: null,
    });
  });
  it('does not expose malformed snapshot contents in an error', async () => {
    await change();
    db.exec("UPDATE account_webhook_snapshots SET email_before_json = 'private@example.com'");
    await expect(render(emailEventId(), 'account.email.changed')).rejects.toThrow(
      /^account_webhook_snapshot_invalid$/
    );
  });
  it.each(['tenant', 'client'] as const)('rejects invalid %s scope', async (scope) => {
    await change();
    await expect(
      render(emailEventId(), 'account.email.changed', {
        ...destination,
        scope,
        tenantId: scope === 'tenant' ? 'other' : 't',
      })
    ).rejects.toThrow('scope_denied');
  });
  it('does not expand selected fields or redirect a previously attempted payload', async () => {
    await change();
    const id = emailEventId();
    await render(id, 'account.email.changed');
    await expect(
      render(id, 'account.email.changed', {
        ...destination,
        payloadFields: ['email', 'registration_state'],
      })
    ).rejects.toThrow('selection_changed');
    await expect(
      render(id, 'account.email.changed', { ...destination, url: 'https://other.example/hook' })
    ).rejects.toThrow('selection_changed');
  });
  it('fails explicitly when a selected snapshot has expired', async () => {
    await change();
    await expect(
      render(emailEventId(), 'account.email.changed', destination, Date.now() + 8 * 86400_000)
    ).rejects.toThrow('snapshot_expired');
  });
  it('does not allow a newer configuration to select old event data', async () => {
    await change();
    await expect(
      render(emailEventId(), 'account.email.changed', {
        ...destination,
        updatedAt: '2100-01-01T00:00:00Z',
      })
    ).rejects.toThrow('selection_newer_than_event');
  });
});

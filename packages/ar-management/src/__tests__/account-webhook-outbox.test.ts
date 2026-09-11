import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import type {
  DatabaseAdapter,
  Env,
  EventPublishPayload,
  EventPublishOptions,
} from '@authrim/ar-lib-core';
import {
  processAccountWebhookOutbox,
  processScheduledAccountWebhookOutbox,
} from '../account-webhook-outbox';

let db: SQLiteDatabase;
let adapter: DatabaseAdapter;
const log = { warn: vi.fn() };
const now = 2_000_000_000_000;
const payloads: Array<{ payload: EventPublishPayload; options: EventPublishOptions }> = [];
const publish = vi.fn(async (payload: EventPublishPayload, options: EventPublishOptions) => {
  payloads.push({ payload, options });
  return true;
});
const targets = () => [{ tenantId: 't', adapters: [{ adapter, bindingRef: 'shard-1' }] }];
const run = (ready = true) =>
  processAccountWebhookOutbox({} as Env, targets(), log, {
    now: () => now,
    publisher: async () => publish,
    deletionReady: async () => ready,
  });
function account(state = 'guest', tenant = 't', id = 'u', type = 'user') {
  db.prepare(
    `INSERT INTO identity_accounts
    (id, tenant_id, legacy_user_id, account_type, registration_state, created_at, updated_at, directory_publication_state)
    VALUES (?, ?, ?, ?, ?, 1, 1, 'active')`
  ).run(`${tenant}:${id}`, tenant, id, type, state);
}
function events() {
  return db
    .prepare(
      'SELECT event_type, registration_state, previous_registration_state FROM account_webhook_outbox ORDER BY rowid'
    )
    .all() as Array<Record<string, unknown>>;
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const file of [
    '001_0_4_0_core_baseline.sql',
    '002_guest_account_lifecycle.sql',
    '003_account_registration_state.sql',
    '005_account_webhook_outbox.sql',
  ]) {
    db.exec(
      renderPortableMigrationSql(
        readFileSync(new URL(`../../../../migrations/core/d1/${file}`, import.meta.url), 'utf8'),
        'sqlite'
      )
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
  } as DatabaseAdapter;
  publish.mockClear();
  payloads.length = 0;
});
afterEach(() => db.close());

describe('transactional account webhook production and delivery', () => {
  it('preserves milliseconds in SQLite trigger event timestamps', () => {
    db.function('strftime', (format, _time) => (format === '%s' ? '2000000000' : '20.789'));
    account();
    expect(db.prepare('SELECT occurred_at FROM account_webhook_outbox').get()).toEqual({
      occurred_at: 2_000_000_000_789,
    });
  });
  it.each(['guest', 'registered'])(
    'captures %s create, update and delete without PII',
    async (state) => {
      account(state);
      db.exec(
        'UPDATE identity_accounts SET metadata_json = \'{"password_hash":"secret"}\' WHERE tenant_id = \'t\''
      );
      db.exec("UPDATE identity_accounts SET lifecycle_state = 'deleted' WHERE tenant_id = 't'");
      expect(events().map((r) => r.event_type)).toEqual([
        `account.created`,
        `account.updated`,
        `account.deleted`,
      ]);
      expect(await run()).toEqual({ delivered: 3, deferred: 0 });
      expect(JSON.stringify(payloads)).not.toContain('secret');
      expect(
        payloads.every((p) => p.payload.data && p.options.durableEvent?.id.startsWith('evt_'))
      ).toBe(true);
      await run();
      expect(publish).toHaveBeenCalledTimes(3);
    }
  );
  it('waits for directory activation and ignores failed/rolled back creation', () => {
    db.exec('BEGIN');
    account();
    db.exec('ROLLBACK');
    expect(events()).toEqual([]);
    db.exec(
      "INSERT INTO identity_accounts (id, tenant_id, legacy_user_id, account_type, created_at, updated_at) VALUES ('p', 't', 'p', 'user', 1, 1)"
    );
    expect(events()).toEqual([]);
    db.exec("UPDATE identity_accounts SET directory_publication_state = 'active' WHERE id = 'p'");
    expect(events().map((r) => r.event_type)).toEqual(['account.created']);
  });
  it('emits promotion only on the committed guest transition and supports the reverse transition', () => {
    account();
    db.exec(
      "INSERT INTO guest_account_lifecycle (tenant_id,user_id,client_id,created_at,policy_version,updated_at,phase) VALUES ('t','u','c',1,'v',1,'upgrading')"
    );
    db.exec("UPDATE identity_accounts SET registration_state = 'registered' WHERE tenant_id = 't'");
    expect(events()).toHaveLength(1);
    db.exec("UPDATE guest_account_lifecycle SET phase = 'registered' WHERE tenant_id = 't'");
    db.exec("UPDATE identity_accounts SET registration_state = 'guest' WHERE tenant_id = 't'");
    expect(events().slice(1)).toEqual([
      {
        event_type: 'account.registration.changed',
        registration_state: 'registered',
        previous_registration_state: 'guest',
      },
      {
        event_type: 'account.registration.changed',
        registration_state: 'guest',
        previous_registration_state: 'registered',
      },
    ]);
  });
  it('announces promotion again after a demotion with a historical guest record', () => {
    account('registered');
    db.exec(
      "INSERT INTO guest_account_lifecycle (tenant_id,user_id,client_id,created_at,policy_version,updated_at,phase) VALUES ('t','u','c',1,'v',1,'registered')"
    );
    db.exec("UPDATE identity_accounts SET registration_state = 'guest' WHERE tenant_id = 't'");
    db.exec("UPDATE identity_accounts SET registration_state = 'registered' WHERE tenant_id = 't'");
    expect(events().map((r) => r.event_type)).toEqual([
      'account.created',
      'account.registration.changed',
      'account.registration.changed',
    ]);
  });
  it('does not announce promotion before canonical registration commits', () => {
    account();
    db.exec(
      "INSERT INTO guest_account_lifecycle (tenant_id,user_id,client_id,created_at,policy_version,updated_at,phase) VALUES ('t','u','c',1,'v',1,'upgrading')"
    );
    db.exec("UPDATE guest_account_lifecycle SET phase = 'registered' WHERE tenant_id = 't'");
    expect(events().map((r) => r.event_type)).toEqual(['account.created']);
  });
  it('announces guest retention changes without exposing deadlines or policy data', () => {
    account();
    db.exec(
      "INSERT INTO guest_account_lifecycle (tenant_id,user_id,client_id,created_at,policy_version,updated_at) VALUES ('t','u','c',1,'v',1)"
    );
    db.exec(
      "UPDATE guest_account_lifecycle SET deletion_due_at = 9000, upgrade_hold_until = 8000 WHERE tenant_id = 't'"
    );
    expect(events().map((r) => r.event_type)).toEqual(['account.created', 'account.updated']);
    db.exec("UPDATE guest_account_lifecycle SET revision = revision + 1 WHERE tenant_id = 't'");
    expect(events()).toHaveLength(2);
  });
  it('waits for guest cleanup and authentication deletion before notifying', async () => {
    account();
    db.exec(
      "INSERT INTO guest_account_lifecycle (tenant_id,user_id,client_id,created_at,policy_version,updated_at,phase) VALUES ('t','u','c',1,'v',1,'deleting')"
    );
    db.exec("UPDATE identity_accounts SET lifecycle_state = 'deleted' WHERE tenant_id = 't'");
    expect(events()).toHaveLength(2);
    expect(await run(true)).toEqual({ delivered: 1, deferred: 1 });
    db.exec('UPDATE account_webhook_outbox SET next_attempt_at = 0');
    db.exec(
      "UPDATE guest_account_lifecycle SET phase = 'deleted', deleted_at = 2 WHERE tenant_id = 't'"
    );
    expect(await run(false)).toEqual({ delivered: 0, deferred: 1 });
    expect(payloads.map((p) => p.payload.type)).not.toContain('account.deleted');
    db.exec('UPDATE account_webhook_outbox SET next_attempt_at = 0');
    await run();
    expect(payloads.at(-1)?.payload.type).toBe('account.deleted');
  });
  it('emits registered deletion after an earlier guest promotion', () => {
    account('registered');
    db.exec(
      "INSERT INTO guest_account_lifecycle (tenant_id,user_id,client_id,created_at,policy_version,updated_at,phase) VALUES ('t','u','c',1,'v',1,'registered')"
    );
    db.exec("UPDATE identity_accounts SET lifecycle_state = 'deleted' WHERE tenant_id = 't'");
    expect(events().at(-1)?.event_type).toBe('account.deleted');
  });
  it('retries failures with the same immutable ID and timestamp after a lease expires', async () => {
    account();
    publish.mockResolvedValueOnce(false);
    expect(await run()).toEqual({ delivered: 0, deferred: 1 });
    const first = publish.mock.calls[0];
    expect(await run()).toEqual({ delivered: 0, deferred: 0 });
    db.exec('UPDATE account_webhook_outbox SET next_attempt_at = 0, lease_until = 1');
    await run();
    expect(publish.mock.calls[1][0]).toEqual(first[0]);
    expect(publish.mock.calls[1][1].durableEvent).toEqual(first[1].durableEvent);
  });
  it('does not steal an active delivery lease', async () => {
    account();
    db.prepare('UPDATE account_webhook_outbox SET lease_token = ?, lease_until = ?').run(
      'other-worker',
      now + 1000
    );
    expect(await run()).toEqual({ delivered: 0, deferred: 0 });
    expect(publish).not.toHaveBeenCalled();
    db.exec('UPDATE account_webhook_outbox SET lease_until = 0');
    expect(await run()).toEqual({ delivered: 1, deferred: 0 });
  });
  it('isolates tenants and excludes machine subjects', async () => {
    account('guest', 'other');
    account('registered', 't', 'machine', 'service_account');
    expect(await run()).toEqual({ delivered: 0, deferred: 0 });
    expect(publish).not.toHaveBeenCalled();
  });
  it('captures profile and contact mutations while excluding cross-tenant joins', () => {
    account();
    db.exec(
      "INSERT INTO identity_subjects (id,tenant_id,subject_type,created_at,updated_at) VALUES ('s','t','person',1,1)"
    );
    db.exec("UPDATE identity_accounts SET primary_subject_id = 's' WHERE tenant_id = 't'");
    db.exec(
      "INSERT INTO profiles (id,tenant_id,subject_id,created_at,updated_at) VALUES ('p','t','s',1,1)"
    );
    db.exec(
      "INSERT INTO profile_attribute_values (id,tenant_id,profile_id,catalog_entry_id,value_type,value_json,created_at,updated_at) VALUES ('v','t','p','name','string','private-name',1,1)"
    );
    db.exec(
      "UPDATE profile_attribute_values SET value_json = 'another-private-name' WHERE id = 'v'"
    );
    db.exec("DELETE FROM profile_attribute_values WHERE id = 'v'");
    db.exec(
      "INSERT INTO contact_points (id,tenant_id,subject_id,contact_type,created_at,updated_at) VALUES ('c','t','s','email',1,1)"
    );
    db.exec("UPDATE contact_points SET verification_state = 'verified' WHERE id = 'c'");
    db.exec("DELETE FROM contact_points WHERE id = 'c'");
    expect(events()).toHaveLength(8);
    db.exec(
      "INSERT INTO contact_points (id,tenant_id,subject_id,contact_type,created_at,updated_at) VALUES ('foreign','other','s','email',1,1)"
    );
    expect(events()).toHaveLength(8);
    expect(JSON.stringify(db.prepare('SELECT * FROM account_webhook_outbox').all())).not.toContain(
      'private-name'
    );
  });
  it('captures custom profile writes and deletes without leaking field values', () => {
    account();
    db.exec(
      "INSERT INTO user_custom_fields (user_id,tenant_id,field_name,field_value) VALUES ('u','t','secret-field','private-value')"
    );
    db.exec("DELETE FROM user_custom_fields WHERE tenant_id = 't'");
    expect(events().map((r) => r.event_type)).toEqual([
      'account.created',
      'account.updated',
      'account.updated',
    ]);
    expect(JSON.stringify(db.prepare('SELECT * FROM account_webhook_outbox').all())).not.toContain(
      'private-value'
    );
  });
  it('honors backoff committed after a concurrent worker selected the row', async () => {
    account();
    const execute = adapter.execute.bind(adapter);
    const spy = vi.spyOn(adapter, 'execute').mockImplementation(async (sql, params) => {
      if (sql.includes('SET lease_token = ?')) {
        db.prepare('UPDATE account_webhook_outbox SET next_attempt_at = ?').run(now + 30_000);
      }
      return execute(sql, params);
    });
    expect(await run()).toEqual({ delivered: 0, deferred: 0 });
    expect(publish).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it.each([false, true])(
    'collects PII notifications with cleanup failure=%s',
    async (failCleanup) => {
      const pii = new DatabaseSync(':memory:');
      try {
        pii.exec(
          readFileSync(
            new URL(
              '../../../../migrations/pii/d1/003_account_webhook_outbox.sql',
              import.meta.url
            ),
            'utf8'
          )
        );
        pii.exec(
          readFileSync(
            new URL(
              '../../../../migrations/pii/d1/004_account_webhook_snapshots.sql',
              import.meta.url
            ),
            'utf8'
          )
        );
        pii
          .prepare(
            `INSERT INTO account_webhook_outbox
        (id,tenant_id,user_id,event_type,registration_state,changed_field,occurred_at)
        VALUES ('evt_pii','t','u','account.updated','guest','custom_profile',1)`
          )
          .run();
        const piiAdapter = {
          async query<T>(sql: string, params: unknown[] = []) {
            return pii.prepare(sql).all(...(params as SQLInputValue[])) as T[];
          },
          async execute(sql: string, params: unknown[] = []) {
            return {
              success: true,
              rowsAffected: Number(pii.prepare(sql).run(...(params as SQLInputValue[])).changes),
            };
          },
        } as DatabaseAdapter;
        expect(
          await processScheduledAccountWebhookOutbox({} as Env, targets(), log, {
            now: () => now,
            publisher: async () => publish,
            resolvePii: async () => [
              ...(failCleanup
                ? [
                    {
                      bindingRef: 'pii-unavailable',
                      adapter: {
                        query: async () => [],
                        execute: async () => {
                          throw new Error('cleanup unavailable');
                        },
                      } as unknown as DatabaseAdapter,
                    },
                  ]
                : []),
              { bindingRef: 'pii-1', adapter: piiAdapter },
            ],
          })
        ).toEqual({ delivered: 1, deferred: 0 });
        expect(payloads[0].options.durableEvent?.id).toBe('evt_pii');
        expect(payloads[0].payload.data?.changed_fields).toEqual(['custom_profile']);
      } finally {
        pii.close();
      }
    }
  );
  it('continues Core delivery if PII shard discovery is unavailable', async () => {
    account();
    expect(
      await processScheduledAccountWebhookOutbox({} as Env, targets(), log, {
        now: () => now,
        publisher: async () => publish,
        resolvePii: async () => {
          throw new Error('unavailable');
        },
      })
    ).toEqual({ delivered: 1, deferred: 0 });
    expect(log.warn).toHaveBeenCalledWith('Account webhook PII shard resolution deferred', {
      tenantId: 't',
    });
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1PluginHookOutboxStore } from '../outbox';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class Session {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      bind: (...values: unknown[]) =>
        new BoundStatement(
          statement,
          values.map((value) => {
            if (
              typeof value === 'string' ||
              typeof value === 'number' ||
              value === null ||
              value instanceof Uint8Array
            ) {
              return value;
            }
            throw new Error('unsupported_test_sqlite_value');
          })
        ),
    };
  }

  async batch(statements: BoundStatement[]) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

function pluginOutboxSchema(): string {
  const migration = readFileSync(
    resolve(REPO_ROOT, 'migrations/032_tenant_directory_and_plugin_outboxes.sql'),
    'utf8'
  );
  const start = migration.indexOf('CREATE TABLE IF NOT EXISTS plugin_hook_outbox');
  const end = migration.indexOf('CREATE TABLE IF NOT EXISTS identifier_change_notification_outbox');
  if (start < 0 || end <= start) throw new Error('plugin_outbox_test_schema_missing');
  return migration.slice(start, end);
}

function notificationIntentSchema(): string {
  return [
    'migrations/035_notification_delivery_intents.sql',
    'migrations/050_email_delivery_history.sql',
  ]
    .map((path) => readFileSync(resolve(REPO_ROOT, path), 'utf8'))
    .join('\n');
}

function insertNotification(database: DatabaseSync, providerInstallationIds = ['installation-a']) {
  database
    .prepare(
      `INSERT INTO notification_delivery_intents (
         intent_id, tenant_id, plugin_installation_id, provider_order_version,
         provider_installation_ids_json, active_provider_index, provider_started_at,
         channel, notification_kind,
         payload_version, payload_key_id, payload_envelope_json, idempotency_key,
         request_fingerprint, fingerprint_key_id, state, expires_at, delete_after,
         created_at, updated_at
       ) VALUES ('intent-a', 'tenant-a', 'installation-a', 1,
                 ?, 0, 100, 'email', 'auth.email_otp',
                 1, 'key-a', '{"ciphertext":"opaque"}', 'notification/a',
                 ?, 'notification-intent-v1', 'pending', 500, 500, 100, 100)`
    )
    .run(JSON.stringify(providerInstallationIds), 'a'.repeat(64));
}

function insertNotificationOutbox(database: DatabaseSync) {
  database
    .prepare(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, payload_class,
         status, attempt_no, created_at, updated_at
       ) VALUES ('notification-a', 'tenant-a', 'installation-a', 'notifier.send',
                 'notification.delivery.requested', 1, 'notification/a', ?,
                 'reference_v1', 'queued', 0, 100, 100)`
    )
    .run(
      JSON.stringify({
        tenantId: 'tenant-a',
        intentId: 'intent-a',
        eventType: 'notification.delivery.requested',
        eventVersion: 1,
      })
    );
}

function insertOutbox(database: DatabaseSync, overrides: { payload?: string; id?: string } = {}) {
  database
    .prepare(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, payload_class,
         status, attempt_no, created_at, updated_at
       ) VALUES (?, 'tenant-a', 'installation-a', 'notifier.send', 'account.created',
                 1, 'event/a#1', ?, 'reference_v1', 'queued', 0, 100, 100)`
    )
    .run(
      overrides.id ?? 'outbox-a',
      overrides.payload ??
        JSON.stringify({
          tenantId: 'tenant-a',
          accountId: 'account-a',
          eventType: 'account.created',
          eventVersion: 1,
        })
    );
}

describe('D1PluginHookOutboxStore', () => {
  let database: DatabaseSync;
  let store: D1PluginHookOutboxStore;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(pluginOutboxSchema());
    database.exec(notificationIntentSchema());
    store = new D1PluginHookOutboxStore(d1(database));
  });

  afterEach(() => database.close());

  it('claims across tenant rows and completes through the fenced lease', async () => {
    insertOutbox(database);
    const claim = await store.claimNext({ ownerId: 'runner-a', now: 110 });
    expect(claim).toMatchObject({
      outboxId: 'outbox-a',
      attemptNo: 1,
      createdAt: 100,
      invocation: { tenantId: 'tenant-a', idempotencyKey: 'event/a#1' },
    });
    if (!claim) throw new Error('missing_test_claim');
    await store.succeed(claim, 111);
    expect(
      database
        .prepare(
          `SELECT status, attempt_no, claim_owner, succeeded_at, delete_after
             FROM plugin_hook_outbox WHERE outbox_id = 'outbox-a'`
        )
        .get()
    ).toEqual({
      status: 'succeeded',
      attempt_no: 1,
      claim_owner: null,
      succeeded_at: 111,
      delete_after: 604911,
    });
  });

  it('permits takeover only after lease expiry and increments attempt fencing', async () => {
    insertOutbox(database);
    const first = await store.claimNext({ ownerId: 'runner-a', now: 110 });
    expect(first).not.toBeNull();
    await expect(store.claimNext({ ownerId: 'runner-b', now: 169 })).resolves.toBeNull();
    const takeover = await store.claimNext({ ownerId: 'runner-b', now: 170 });
    expect(takeover).toMatchObject({ attemptNo: 2, claimOwner: 'runner-b' });
    if (!first) throw new Error('missing_test_claim');
    await expect(store.succeed(first, 141)).rejects.toThrow('plugin_outbox_stale_claim');
  });

  it('quarantines malformed reference payload once instead of retrying it forever', async () => {
    insertOutbox(database, {
      payload: JSON.stringify({ tenantId: 'other', accountId: 'account-a' }),
    });
    await expect(store.claimNext({ ownerId: 'runner-a', now: 110 })).rejects.toThrow(
      'plugin_outbox_claim_invalid'
    );
    expect(
      database
        .prepare(
          `SELECT status, last_error_code, dead_lettered_at, delete_after
             FROM plugin_hook_outbox WHERE outbox_id = 'outbox-a'`
        )
        .get()
    ).toEqual({
      status: 'dead_letter',
      last_error_code: 'plugin_outbox_payload_invalid',
      dead_lettered_at: 110,
      delete_after: 7776110,
    });
    await expect(store.claimNext({ ownerId: 'runner-b', now: 10_000 })).resolves.toBeNull();
  });

  it('atomically wipes a notification intent when its malformed outbox is quarantined', async () => {
    insertNotification(database);
    insertNotificationOutbox(database);
    database.exec(
      `UPDATE plugin_hook_outbox
          SET payload_json = '{"tenantId":"other","intentId":"intent-a"}'
        WHERE outbox_id = 'notification-a'`
    );

    await expect(store.claimNext({ ownerId: 'runner-a', now: 110 })).rejects.toThrow(
      'plugin_outbox_claim_invalid'
    );
    expect(
      database
        .prepare(
          `SELECT state, payload_key_id, payload_envelope_json, dead_lettered_at
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({
      state: 'dead_letter',
      payload_key_id: null,
      payload_envelope_json: null,
      dead_lettered_at: 110,
    });
    expect(
      database
        .prepare(
          `SELECT status, last_error_code FROM plugin_hook_outbox
            WHERE outbox_id = 'notification-a'`
        )
        .get()
    ).toEqual({ status: 'dead_letter', last_error_code: 'plugin_outbox_payload_invalid' });
  });

  it('accepts only the fixed notification intent reference contract', async () => {
    insertNotification(database);
    insertNotificationOutbox(database);
    await expect(store.claimNext({ ownerId: 'runner-a', now: 110 })).resolves.toMatchObject({
      invocation: {
        payload: {
          tenantId: 'tenant-a',
          intentId: 'intent-a',
          eventType: 'notification.delivery.requested',
          eventVersion: 1,
        },
      },
    });
  });

  it('claims an exact notification reference and reports concurrent or settled states', async () => {
    insertNotification(database);
    insertNotificationOutbox(database);
    const first = await store.claimReference({
      ownerId: 'immediate-a',
      now: 110,
      outboxId: 'notification-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      intentId: 'intent-a',
    });
    expect(first).toMatchObject({ state: 'claimed', claim: { attemptNo: 1 } });
    await expect(
      store.claimReference({
        ownerId: 'immediate-b',
        now: 111,
        outboxId: 'notification-a',
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        intentId: 'intent-a',
      })
    ).resolves.toEqual({ state: 'pending' });
    if (first.state !== 'claimed') throw new Error('missing_test_claim');
    database.exec(
      `UPDATE notification_delivery_intents
          SET state = 'delivered', payload_key_id = NULL, payload_envelope_json = NULL,
              delivered_at = 112, updated_at = 112
        WHERE intent_id = 'intent-a'`
    );
    await store.succeed(first.claim, 112);
    await expect(
      store.claimReference({
        ownerId: 'immediate-b',
        now: 113,
        outboxId: 'notification-a',
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        intentId: 'intent-a',
      })
    ).resolves.toEqual({ state: 'delivered' });
  });

  it('does not claim a guessed cross-tenant or wrong-intent reference', async () => {
    insertNotification(database);
    insertNotificationOutbox(database);
    await expect(
      store.claimReference({
        ownerId: 'immediate-a',
        now: 110,
        outboxId: 'notification-a',
        tenantId: 'tenant-b',
        pluginInstallationId: 'installation-a',
        intentId: 'intent-a',
      })
    ).rejects.toThrow('plugin_outbox_reference_not_found');
    await expect(
      store.claimReference({
        ownerId: 'immediate-a',
        now: 110,
        outboxId: 'notification-a',
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        intentId: 'intent-b',
      })
    ).rejects.toThrow('plugin_outbox_reference_not_found');
    expect(
      database
        .prepare(`SELECT status, attempt_no FROM plugin_hook_outbox WHERE outbox_id = ?`)
        .get('notification-a')
    ).toEqual({ status: 'queued', attempt_no: 0 });
  });

  it('atomically wipes a notification payload when delivery becomes terminal', async () => {
    insertNotification(database);
    insertNotificationOutbox(database);
    const result = await store.claimReference({
      ownerId: 'immediate-a',
      now: 110,
      outboxId: 'notification-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      intentId: 'intent-a',
    });
    if (result.state !== 'claimed') throw new Error('missing_test_claim');
    await store.fail(result.claim, {
      now: 111,
      errorCode: 'plugin_policy_unavailable',
      retryable: false,
      maxAttempts: 1,
      failureScope: 'message',
    });
    expect(
      database
        .prepare(
          `SELECT state, payload_key_id, payload_envelope_json, dead_lettered_at
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({
      state: 'dead_letter',
      payload_key_id: null,
      payload_envelope_json: null,
      dead_lettered_at: 111,
    });
    expect(
      database
        .prepare(`SELECT status FROM plugin_hook_outbox WHERE outbox_id = 'notification-a'`)
        .get()
    ).toEqual({ status: 'dead_letter' });
  });

  it('advances to the next provider without wiping the logical notification payload', async () => {
    insertNotification(database, ['installation-a', 'installation-b']);
    insertNotificationOutbox(database);
    const result = await store.claimReference({
      ownerId: 'immediate-a',
      now: 110,
      outboxId: 'notification-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      intentId: 'intent-a',
    });
    if (result.state !== 'claimed') throw new Error('missing_test_claim');

    await expect(
      store.fail(result.claim, {
        now: 111,
        errorCode: 'plugin_hook_provider_rejected',
        retryable: false,
        maxAttempts: 3,
        failureScope: 'provider',
      })
    ).resolves.toBe('waiting_retry');
    expect(
      database
        .prepare(
          `SELECT state, active_provider_index, provider_started_at,
                  payload_key_id, payload_envelope_json
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({
      state: 'pending',
      active_provider_index: 1,
      provider_started_at: 111,
      payload_key_id: 'key-a',
      payload_envelope_json: '{"ciphertext":"opaque"}',
    });
    expect(
      database
        .prepare(
          `SELECT plugin_installation_id, status, attempt_no, claim_owner, next_attempt_at
             FROM plugin_hook_outbox WHERE outbox_id = 'notification-a'`
        )
        .get()
    ).toEqual({
      plugin_installation_id: 'installation-b',
      status: 'waiting_retry',
      attempt_no: 0,
      claim_owner: null,
      next_attempt_at: 111,
    });

    await expect(
      store.claimReference({
        ownerId: 'immediate-b',
        now: 112,
        outboxId: 'notification-a',
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        intentId: 'intent-a',
      })
    ).resolves.toMatchObject({
      state: 'claimed',
      claim: {
        attemptNo: 1,
        providerStartedAt: 111,
        invocation: { pluginInstallationId: 'installation-b' },
      },
    });
  });

  it('retries an ambiguous provider response on the same provider before budget exhaustion', async () => {
    insertNotification(database, ['installation-a', 'installation-b']);
    insertNotificationOutbox(database);
    const result = await store.claimReference({
      ownerId: 'immediate-a',
      now: 110,
      outboxId: 'notification-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      intentId: 'intent-a',
    });
    if (result.state !== 'claimed') throw new Error('missing_test_claim');

    await expect(
      store.fail(result.claim, {
        now: 111,
        errorCode: 'plugin_hook_transient_failure',
        retryable: true,
        maxAttempts: 3,
        failureScope: 'provider',
      })
    ).resolves.toBe('waiting_retry');
    expect(
      database
        .prepare(
          `SELECT active_provider_index, provider_started_at
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({ active_provider_index: 0, provider_started_at: 100 });
    expect(
      database
        .prepare(
          `SELECT plugin_installation_id, status, attempt_no
             FROM plugin_hook_outbox WHERE outbox_id = 'notification-a'`
        )
        .get()
    ).toEqual({ plugin_installation_id: 'installation-a', status: 'waiting_retry', attempt_no: 1 });
  });

  it('advances after provider retries are exhausted but not for platform failures', async () => {
    insertNotification(database, ['installation-a', 'installation-b']);
    insertNotificationOutbox(database);
    const exhausted = await store.claimReference({
      ownerId: 'immediate-a',
      now: 110,
      outboxId: 'notification-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      intentId: 'intent-a',
    });
    if (exhausted.state !== 'claimed') throw new Error('missing_test_claim');
    await expect(
      store.fail(exhausted.claim, {
        now: 111,
        errorCode: 'plugin_hook_transient_failure',
        retryable: true,
        maxAttempts: 1,
        failureScope: 'provider',
      })
    ).resolves.toBe('waiting_retry');
    expect(
      database
        .prepare(
          `SELECT active_provider_index FROM notification_delivery_intents
            WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({ active_provider_index: 1 });

    const next = await store.claimReference({
      ownerId: 'immediate-b',
      now: 112,
      outboxId: 'notification-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      intentId: 'intent-a',
    });
    if (next.state !== 'claimed') throw new Error('missing_test_claim');
    await expect(
      store.fail(next.claim, {
        now: 113,
        errorCode: 'plugin_dispatch_limiter_unavailable',
        retryable: false,
        maxAttempts: 1,
        failureScope: 'platform',
      })
    ).resolves.toBe('dead_letter');
    expect(
      database
        .prepare(
          `SELECT state, active_provider_index, payload_key_id
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({ state: 'dead_letter', active_provider_index: 1, payload_key_id: null });
  });

  it('adopts a reflected provider advance after the mutation response is lost', async () => {
    insertNotification(database, ['installation-a', 'installation-b']);
    insertNotificationOutbox(database);
    const result = await store.claimReference({
      ownerId: 'immediate-a',
      now: 110,
      outboxId: 'notification-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      intentId: 'intent-a',
    });
    if (result.state !== 'claimed') throw new Error('missing_test_claim');
    database.exec(
      `UPDATE notification_delivery_intents
          SET active_provider_index = 1, provider_started_at = 111, updated_at = 111
        WHERE intent_id = 'intent-a';
       UPDATE plugin_hook_outbox
          SET plugin_installation_id = 'installation-b', status = 'waiting_retry', attempt_no = 0,
              claim_owner = NULL, claim_token = NULL, lease_until = NULL,
              next_attempt_at = 111, last_error_code = 'plugin_hook_provider_rejected',
              updated_at = 111
        WHERE outbox_id = 'notification-a';`
    );

    await expect(
      store.fail(result.claim, {
        now: 111,
        errorCode: 'plugin_hook_provider_rejected',
        retryable: false,
        maxAttempts: 3,
        failureScope: 'provider',
      })
    ).resolves.toBe('waiting_retry');
    expect(
      database
        .prepare(
          `SELECT plugin_installation_id, status, attempt_no
             FROM plugin_hook_outbox WHERE outbox_id = 'notification-a'`
        )
        .get()
    ).toEqual({ plugin_installation_id: 'installation-b', status: 'waiting_retry', attempt_no: 0 });
  });
});

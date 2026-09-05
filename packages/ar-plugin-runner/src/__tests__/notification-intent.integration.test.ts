import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNotificationDeliveryIntent } from '@authrim/ar-lib-core';
import {
  cleanupExpiredNotificationDeliveryIntents,
  D1NotificationIntentDeliveryStore,
  encryptNotificationPayloadFromEnv,
  notificationPayloadEncryptionKeyFromEnv,
  notificationPayloadSymmetricKeysFromEnv,
  notificationPrivateJwksFromEnv,
} from '../notification-intent';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const KEY_ID = 'notification-intent-test';

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
    this.database.exec('BEGIN IMMEDIATE');
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

function schema(): string {
  return readFileSync(resolve(REPO_ROOT, 'migrations/001_0_4_0_core_baseline.sql'), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

let publicJwks: string;
let privateJwk: string;
let unavailablePrivateJwk: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt']
  );
  if (!('publicKey' in pair)) throw new Error('notification_test_key_generation_failed');
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  publicJwks = JSON.stringify({
    keys: [{ ...publicKey, kid: KEY_ID, use: 'enc', alg: 'RSA-OAEP-256', key_ops: ['encrypt'] }],
  });
  privateJwk = JSON.stringify({
    ...privateKey,
    kid: KEY_ID,
    use: 'enc',
    alg: 'RSA-OAEP-256',
    key_ops: ['decrypt'],
  });
  unavailablePrivateJwk = JSON.stringify({
    ...privateKey,
    kid: 'notification-intent-unavailable',
    use: 'enc',
    alg: 'RSA-OAEP-256',
    key_ops: ['decrypt'],
  });
});

describe('notification delivery intent commit', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(schema());
  });

  afterEach(() => database.close());

  function create(overrides: Partial<Parameters<typeof createNotificationDeliveryIntent>[0]> = {}) {
    return createNotificationDeliveryIntent({
      db: d1(database),
      environmentId: 'test',
      publicJwks,
      activeKeyId: KEY_ID,
      idempotencyHmacKey: 'notification-intent-hmac-key-at-least-32-bytes',
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      outboxId: 'notification-outbox-a',
      providerOrder: { configVersion: 1, installationIds: ['notification-router-a'] },
      notificationKind: 'auth.email_otp',
      idempotencyKey: 'challenge-a/email',
      expiresAt: 1_300,
      now: 1_000,
      payload: {
        channel: 'email',
        to: 'person@example.test',
        subject: 'Sign-in code',
        body: 'Your code is 123456',
      },
      ...overrides,
    });
  }

  it('atomically stores an encrypted payload and reference-only outbox', async () => {
    await expect(create()).resolves.toMatchObject({
      intentId: 'intent-a',
      outboxId: 'notification-outbox-a',
      state: 'pending',
    });
    const intent = database
      .prepare(
        `SELECT payload_envelope_json, payload_key_id, state
           FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
      )
      .get() as { payload_envelope_json: string; payload_key_id: string; state: string };
    const outbox = database
      .prepare(
        `SELECT payload_json, capability, event_type
           FROM plugin_hook_outbox WHERE outbox_id = 'notification-outbox-a'`
      )
      .get() as { payload_json: string; capability: string; event_type: string };

    expect(intent).toMatchObject({ payload_key_id: KEY_ID, state: 'pending' });
    expect(intent.payload_envelope_json).not.toContain('person@example.test');
    expect(intent.payload_envelope_json).not.toContain('123456');
    expect(JSON.parse(outbox.payload_json)).toEqual({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      eventType: 'notification.delivery.requested',
      eventVersion: 1,
    });
    expect(outbox).toMatchObject({
      capability: 'notifier.send',
      event_type: 'notification.delivery.requested',
    });
  });

  it('adopts an exact duplicate without replacing the original ciphertext', async () => {
    await create();
    const first = database
      .prepare(`SELECT payload_envelope_json FROM notification_delivery_intents`)
      .get() as { payload_envelope_json: string };
    await expect(create()).resolves.toMatchObject({ intentId: 'intent-a' });
    const second = database
      .prepare(`SELECT payload_envelope_json FROM notification_delivery_intents`)
      .get() as { payload_envelope_json: string };
    expect(second.payload_envelope_json).toBe(first.payload_envelope_json);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM plugin_hook_outbox`).get()).toEqual({
      count: 1,
    });
  });

  it('includes reserved nested JSON keys in idempotency comparison', async () => {
    const payload = (polluted: boolean) => ({
      channel: 'email' as const,
      to: 'person@example.test',
      subject: 'Sign-in code',
      body: 'Your code is 123456',
      metadata: JSON.parse(`{"__proto__":{"polluted":${String(polluted)}}}`) as Record<
        string,
        unknown
      >,
    });

    await create({ payload: payload(true) });
    await expect(create({ payload: payload(true) })).resolves.toMatchObject({
      intentId: 'intent-a',
      state: 'pending',
    });
    await expect(create({ payload: payload(false) })).rejects.toThrow(
      'notification_intent_idempotency_conflict'
    );
  });

  it('adopts an exact retry after the active payload encryption key rotates', async () => {
    const rotatedKeyId = 'notification-intent-test-rotated';
    const rotatedPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt']
    );
    if (!('publicKey' in rotatedPair)) throw new Error('notification_test_key_generation_failed');
    const currentPublicKey = (JSON.parse(publicJwks) as { keys: Record<string, unknown>[] })
      .keys[0];
    const rotatedPublicKey = await crypto.subtle.exportKey('jwk', rotatedPair.publicKey);
    const dualPublicJwks = JSON.stringify({
      keys: [
        currentPublicKey,
        {
          ...rotatedPublicKey,
          kid: rotatedKeyId,
          use: 'enc',
          alg: 'RSA-OAEP-256',
          key_ops: ['encrypt'],
        },
      ],
    });

    await create({ publicJwks: dualPublicJwks });
    await expect(
      create({ publicJwks: dualPublicJwks, activeKeyId: rotatedKeyId })
    ).resolves.toMatchObject({ intentId: 'intent-a' });
    expect(
      database
        .prepare(
          `SELECT payload_key_id, fingerprint_key_id
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({
      payload_key_id: KEY_ID,
      fingerprint_key_id: 'notification-intent-v1',
    });
  });

  it('fails closed on an idempotency collision and leaves no partial second intent', async () => {
    await create();
    await expect(
      create({ intentId: 'intent-b', outboxId: 'notification-outbox-b' })
    ).rejects.toThrow('notification_intent_commit_failed');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM notification_delivery_intents`).get()
    ).toEqual({ count: 1 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM plugin_hook_outbox`).get()).toEqual({
      count: 1,
    });
  });

  it('rejects a different OTP payload under the same durable intent id', async () => {
    await create();
    await expect(
      create({
        payload: {
          channel: 'email',
          to: 'person@example.test',
          subject: 'Sign-in code',
          body: 'Your code is 654321',
        },
      })
    ).rejects.toThrow('notification_intent_idempotency_conflict');
    const stored = database
      .prepare(`SELECT payload_envelope_json FROM notification_delivery_intents`)
      .get() as { payload_envelope_json: string };
    expect(stored.payload_envelope_json).not.toContain('654321');
  });

  it('decrypts only the exact tenant intent and wipes payload after completion', async () => {
    await create();
    const store = new D1NotificationIntentDeliveryStore(
      d1(database),
      'test',
      notificationPrivateJwksFromEnv({
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: privateJwk,
      })
    );
    const reference = {
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      eventType: 'notification.delivery.requested' as const,
      eventVersion: 1 as const,
    };
    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-a',
        reference,
        now: 1_100,
      })
    ).resolves.toMatchObject({
      state: 'pending',
      payload: { to: 'person@example.test', body: 'Your code is 123456' },
    });
    await expect(
      store.load({
        tenantId: 'tenant-b',
        pluginInstallationId: 'notification-router-a',
        reference,
        now: 1_100,
      })
    ).rejects.toThrow('notification_intent_delivery_input_invalid');

    await store.complete({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      pluginInstallationId: 'notification-router-a',
      providerMessageId: 'provider-message-a',
      now: 1_101,
    });
    expect(
      database
        .prepare(
          `SELECT state, payload_key_id, payload_envelope_json, provider_message_id,
                  delivery_status, provider_accepted_at, attempt_count
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({
      state: 'delivered',
      payload_key_id: null,
      payload_envelope_json: null,
      provider_message_id: 'provider-message-a',
      delivery_status: 'provider_accepted',
      provider_accepted_at: 1_101,
      attempt_count: 1,
    });
    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-a',
        reference,
        now: 1_102,
      })
    ).resolves.toMatchObject({ state: 'delivered' });
    await expect(create()).resolves.toMatchObject({
      intentId: 'intent-a',
      outboxId: 'notification-outbox-a',
      state: 'delivered',
    });
  });

  it('loads a v2 symmetric envelope prepared by Plugin Runner', async () => {
    const keyEnv = {
      PLUGIN_ENCRYPTION_KEY: 'notification-payload-test-secret-value',
      PLUGIN_ENCRYPTION_ACTIVE_KEY_ID: 'v2-test',
    };
    const prepared = await encryptNotificationPayloadFromEnv(
      { ...keyEnv, AUTHRIM_ENVIRONMENT_NAME: 'test' },
      {
        context: {
          environmentId: 'test',
          tenantId: 'tenant-a',
          intentId: 'intent-a',
          notificationKind: 'auth.email_otp',
          payloadVersion: 1,
        },
        payload: {
          channel: 'email',
          to: 'person@example.test',
          subject: 'Sign-in code',
          body: 'Your code is 123456',
        },
      }
    );
    await create({
      publicJwks: undefined,
      activeKeyId: undefined,
      preparedEnvelope: { keyId: prepared.activeKeyId, envelope: prepared.envelope },
    });
    const store = new D1NotificationIntentDeliveryStore(
      d1(database),
      'test',
      notificationPrivateJwksFromEnv({
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: privateJwk,
      }),
      notificationPayloadSymmetricKeysFromEnv(keyEnv).all
    );

    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-a',
        reference: {
          tenantId: 'tenant-a',
          intentId: 'intent-a',
          eventType: 'notification.delivery.requested',
          eventVersion: 1,
        },
        now: 1_100,
      })
    ).resolves.toMatchObject({
      state: 'pending',
      payload: { to: 'person@example.test', body: 'Your code is 123456' },
    });
  });

  it('authorizes and completes only the reflected active failover provider', async () => {
    await create({
      providerOrder: {
        configVersion: 3,
        installationIds: ['notification-router-a', 'notification-router-b'],
      },
    });
    database.exec(
      `UPDATE notification_delivery_intents
          SET active_provider_index = 1, provider_started_at = 1_050, updated_at = 1_050
        WHERE intent_id = 'intent-a';
       UPDATE plugin_hook_outbox
          SET plugin_installation_id = 'notification-router-b', updated_at = 1_050
        WHERE outbox_id = 'notification-outbox-a';`
    );
    const store = new D1NotificationIntentDeliveryStore(
      d1(database),
      'test',
      JSON.stringify({ keys: [JSON.parse(privateJwk)] })
    );
    const reference = {
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      eventType: 'notification.delivery.requested' as const,
      eventVersion: 1 as const,
    };
    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-a',
        reference,
        now: 1_100,
      })
    ).rejects.toThrow('notification_intent_row_invalid');
    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-b',
        reference,
        now: 1_100,
      })
    ).resolves.toMatchObject({
      state: 'pending',
      pluginInstallationId: 'notification-router-b',
    });
    await expect(
      store.complete({
        tenantId: 'tenant-a',
        intentId: 'intent-a',
        pluginInstallationId: 'notification-router-b',
        now: 1_101,
      })
    ).resolves.toBeUndefined();
  });

  it('expires and wipes a payload before attempting provider delivery', async () => {
    await create();
    const store = new D1NotificationIntentDeliveryStore(
      d1(database),
      'test',
      JSON.stringify({ keys: [JSON.parse(privateJwk)] })
    );
    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-a',
        reference: {
          tenantId: 'tenant-a',
          intentId: 'intent-a',
          eventType: 'notification.delivery.requested',
          eventVersion: 1,
        },
        now: 1_300,
      })
    ).rejects.toThrow('notification_intent_expired');
    expect(
      database
        .prepare(
          `SELECT state, payload_key_id, payload_envelope_json
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({ state: 'expired', payload_key_id: null, payload_envelope_json: null });
  });

  it('dead-letters and wipes a payload after a permanent provider rejection', async () => {
    await create();
    const store = new D1NotificationIntentDeliveryStore(
      d1(database),
      'test',
      JSON.stringify({ keys: [JSON.parse(privateJwk)] })
    );
    const failure = {
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      pluginInstallationId: 'notification-router-a',
      now: 1_100,
    };
    await expect(store.failPermanent(failure)).resolves.toBeUndefined();
    await expect(store.failPermanent(failure)).resolves.toBeUndefined();
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
      dead_lettered_at: 1_100,
    });
  });

  it('dead-letters and wipes a tampered encrypted payload', async () => {
    await create();
    database.exec('DROP TRIGGER trg_notification_delivery_intent_payload_immutable');
    const row = database
      .prepare(`SELECT payload_envelope_json FROM notification_delivery_intents`)
      .get() as { payload_envelope_json: string };
    const envelope = JSON.parse(row.payload_envelope_json) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.startsWith('A') ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`;
    database
      .prepare(`UPDATE notification_delivery_intents SET payload_envelope_json = ?`)
      .run(JSON.stringify(envelope));
    const store = new D1NotificationIntentDeliveryStore(
      d1(database),
      'test',
      JSON.stringify({ keys: [JSON.parse(privateJwk)] })
    );
    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-a',
        reference: {
          tenantId: 'tenant-a',
          intentId: 'intent-a',
          eventType: 'notification.delivery.requested',
          eventVersion: 1,
        },
        now: 1_100,
      })
    ).rejects.toThrow('notification_intent_payload_authentication_failed');
    expect(
      database
        .prepare(
          `SELECT state, payload_key_id, payload_envelope_json
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({ state: 'dead_letter', payload_key_id: null, payload_envelope_json: null });
  });

  it('reports and wipes an intent encrypted for an unavailable key', async () => {
    await create();
    const store = new D1NotificationIntentDeliveryStore(
      d1(database),
      'test',
      JSON.stringify({ keys: [JSON.parse(unavailablePrivateJwk)] })
    );
    await expect(
      store.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'notification-router-a',
        reference: {
          tenantId: 'tenant-a',
          intentId: 'intent-a',
          eventType: 'notification.delivery.requested',
          eventVersion: 1,
        },
        now: 1_100,
      })
    ).rejects.toThrow('notification_intent_key_unavailable');
    expect(
      database
        .prepare(
          `SELECT state, payload_key_id, payload_envelope_json
             FROM notification_delivery_intents WHERE intent_id = 'intent-a'`
        )
        .get()
    ).toEqual({ state: 'dead_letter', payload_key_id: null, payload_envelope_json: null });
  });

  it('rejects malformed and duplicate private decryption key slots at configuration load', () => {
    expect(() =>
      notificationPrivateJwksFromEnv({
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: '{not-json',
      })
    ).toThrow('notification_decryption_slot_a_invalid');
    expect(() =>
      notificationPrivateJwksFromEnv({
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: privateJwk,
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B: privateJwk,
      })
    ).toThrow('notification_decryption_key_set_invalid');
  });

  it('derives only the matching public encryption key from the active private slot', () => {
    const result = notificationPayloadEncryptionKeyFromEnv({
      NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: privateJwk,
    });
    const parsedPublicJwks: unknown = JSON.parse(result.publicJwks);
    if (
      parsedPublicJwks === null ||
      typeof parsedPublicJwks !== 'object' ||
      !('keys' in parsedPublicJwks) ||
      !Array.isArray(parsedPublicJwks.keys)
    ) {
      throw new Error('Expected a public JWK set');
    }
    const publicKey = parsedPublicJwks.keys[0] as Record<string, unknown>;
    const source = JSON.parse(privateJwk) as Record<string, unknown>;

    expect(result.activeKeyId).toBe(KEY_ID);
    expect(publicKey).toEqual({
      kty: 'RSA',
      n: source.n,
      e: source.e,
      kid: KEY_ID,
      use: 'enc',
      alg: 'RSA-OAEP-256',
      key_ops: ['encrypt'],
    });
    expect(result.publicJwks).not.toContain(String(source.d));
  });

  it('encrypts and validates a delivery payload with the active symmetric-key slot', async () => {
    const result = await encryptNotificationPayloadFromEnv(
      {
        AUTHRIM_ENVIRONMENT_NAME: 'test',
        PLUGIN_ENCRYPTION_KEY: 'notification-payload-test-secret-value',
      },
      {
        context: {
          environmentId: 'test',
          tenantId: 'tenant-a',
          intentId: 'intent-a',
          notificationKind: 'auth.email_otp',
          payloadVersion: 1,
        },
        payload: {
          channel: 'email',
          to: 'person@example.test',
          subject: 'Sign-in code',
          body: 'Your code is 123456',
        },
      }
    );

    expect(result.activeKeyId).toBe('notification:v1');
    expect(result.envelope).not.toContain('person@example.test');
    expect(result.envelope).not.toContain('123456');
  });

  it('rejects payload encryption for a different environment', async () => {
    await expect(
      encryptNotificationPayloadFromEnv(
        {
          AUTHRIM_ENVIRONMENT_NAME: 'test',
          PLUGIN_ENCRYPTION_KEY: 'notification-payload-test-secret-value',
        },
        {
          context: {
            environmentId: 'production',
            tenantId: 'tenant-a',
            intentId: 'intent-a',
            notificationKind: 'auth.email_otp',
            payloadVersion: 1,
          },
          payload: {
            channel: 'email',
            to: 'person@example.test',
            body: '123456',
          },
        }
      )
    ).rejects.toThrow('plugin_notification_encryption_input_invalid');
  });

  it('deletes expired encrypted intents in bounded batches without reading payloads', async () => {
    await create();
    await create({
      tenantId: 'tenant-b',
      intentId: 'intent-b',
      outboxId: 'notification-outbox-b',
      idempotencyKey: 'challenge-b/email',
      expiresAt: 1_400,
    });

    await expect(
      cleanupExpiredNotificationDeliveryIntents(d1(database), {
        now: 1_000 + 90 * 24 * 60 * 60 - 1,
        limit: 1,
      })
    ).resolves.toEqual({ deleted: 0 });
    await expect(
      cleanupExpiredNotificationDeliveryIntents(d1(database), {
        now: 1_000 + 90 * 24 * 60 * 60,
        limit: 1,
      })
    ).resolves.toEqual({ deleted: 1 });
    expect(
      database
        .prepare(
          `SELECT tenant_id, intent_id FROM notification_delivery_intents ORDER BY intent_id`
        )
        .all()
    ).toEqual([{ tenant_id: 'tenant-b', intent_id: 'intent-b' }]);
    await expect(
      cleanupExpiredNotificationDeliveryIntents(d1(database), {
        now: 1_000 + 90 * 24 * 60 * 60,
        limit: 0,
      })
    ).rejects.toThrow('notification_intent_cleanup_input_invalid');
  });
});

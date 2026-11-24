import type { DatabaseSync } from 'node:sqlite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptNotificationIntentPayload } from '@authrim/ar-lib-core';
import {
  D1NotificationIntentDeliveryStore,
  encryptNotificationPayloadFromEnv,
  notificationPayloadSymmetricKeysFromEnv,
  notificationPrivateJwksFromEnv,
} from '../notification-intent';
import { intentRow } from './helpers/outbox-seed';
import { createD1, openCoreDatabase, type D1Options } from './helpers/sqlite-d1';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    decryptNotificationIntentPayload: vi.fn(actual.decryptNotificationIntentPayload),
  };
});

const KEY_ENV = { PLUGIN_ENCRYPTION_KEY: 'notification-payload-test-secret-value' };
const SYMMETRIC = notificationPayloadSymmetricKeysFromEnv(KEY_ENV).all;
const PAYLOAD = {
  channel: 'email',
  to: 'person@example.test',
  subject: 'Code',
  body: 'Your code is 123456',
};
const REFERENCE = {
  tenantId: 'tenant-a',
  intentId: 'intent-a',
  eventType: 'notification.delivery.requested' as const,
  eventVersion: 1 as const,
};
let privateJwks: string;
let database: DatabaseSync;

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
  if (!('privateKey' in pair)) throw new Error('key generation failed');
  privateJwks = notificationPrivateJwksFromEnv({
    NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: JSON.stringify({
      ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
      kid: 'key-a',
      use: 'enc',
      alg: 'RSA-OAEP-256',
      key_ops: ['decrypt'],
    }),
  });
});

async function seed(
  over: {
    intentId?: string;
    channel?: string;
    expiresAt?: number;
    kind?: string;
    key?: string;
    providers?: string[];
    activeIndex?: number;
    payload?: unknown;
  } = {}
): Promise<void> {
  const intentId = over.intentId ?? 'intent-a';
  const kind = over.kind ?? 'auth.email_otp';
  const prepared = await encryptNotificationPayloadFromEnv(
    { ...KEY_ENV, AUTHRIM_ENVIRONMENT_NAME: 'test' },
    {
      context: {
        environmentId: 'test',
        tenantId: 'tenant-a',
        intentId,
        notificationKind: kind,
        payloadVersion: 1,
      },
      payload: over.payload ?? PAYLOAD,
    }
  );
  const providers = over.providers ?? ['provider-a'];
  database
    .prepare(
      `INSERT INTO notification_delivery_intents (
         intent_id, tenant_id, plugin_installation_id, provider_order_version,
         provider_installation_ids_json, active_provider_index, provider_started_at,
         channel, notification_kind, payload_version, payload_key_id, payload_envelope_json,
         idempotency_key, request_fingerprint, fingerprint_key_id, state, expires_at,
         delete_after, created_at, updated_at
       ) VALUES (?, 'tenant-a', ?, 1, ?, ?, 100, ?, ?, 1, ?, ?, ?, ?, 'fp', 'pending', ?, 99999, 100, 100)`
    )
    .run(
      intentId,
      providers[0] ?? 'provider-a',
      JSON.stringify(providers),
      over.activeIndex ?? 0,
      over.channel ?? 'email',
      kind,
      prepared.activeKeyId,
      prepared.envelope,
      over.key ?? `key/${intentId}`,
      'a'.repeat(64),
      over.expiresAt ?? 1_000
    );
}

function store(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return {
    store: new D1NotificationIntentDeliveryStore(d1.db, 'test', privateJwks, SYMMETRIC),
    calls: d1.calls,
  };
}
const load = (over: Record<string, unknown> = {}, options: D1Options = {}) =>
  store(options).store.load({
    tenantId: 'tenant-a',
    pluginInstallationId: 'provider-a',
    reference: REFERENCE,
    now: 500,
    ...over,
  });
const row = () => intentRow(database);
const decrypt = vi.mocked(decryptNotificationIntentPayload);

beforeEach(() => {
  database = openCoreDatabase();
  decrypt.mockClear();
});

describe('construction', () => {
  it.each(['', '-x', 'a b', 'a'.repeat(257)])('rejects environment %j', (environment) => {
    expect(
      () => new D1NotificationIntentDeliveryStore(createD1(database).db, environment, privateJwks)
    ).toThrow(/^notification_intent_environment_invalid$/u);
  });
});

describe('load', () => {
  it('returns a pending intent with its decrypted payload and identifiers', async () => {
    await seed();
    await expect(load()).resolves.toEqual({
      state: 'pending',
      intentId: 'intent-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'provider-a',
      notificationKind: 'auth.email_otp',
      idempotencyKey: 'key/intent-a',
      payload: PAYLOAD,
      expiresAt: 1_000,
    });
    expect(decrypt).toHaveBeenCalledWith({
      privateJwks,
      symmetricKeys: SYMMETRIC,
      context: {
        environmentId: 'test',
        tenantId: 'tenant-a',
        intentId: 'intent-a',
        notificationKind: 'auth.email_otp',
        payloadVersion: 1,
      },
      envelope: (row() as { payload_envelope_json: string }).payload_envelope_json,
    });
  });
  it('queries by intent and tenant on the primary', async () => {
    await seed();
    const { store: s, calls } = store();
    await s.load({
      tenantId: 'tenant-a',
      pluginInstallationId: 'provider-a',
      reference: REFERENCE,
      now: 500,
    });
    expect(calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
    expect(calls.find((c) => c.kind === 'first')?.values).toEqual(['intent-a', 'tenant-a']);
  });
  it('reads the active provider of a failed-over intent', async () => {
    await seed({ providers: ['provider-a', 'provider-b'], activeIndex: 1 });
    await expect(load({ pluginInstallationId: 'provider-b' })).resolves.toMatchObject({
      pluginInstallationId: 'provider-b',
    });
    await expect(load({ pluginInstallationId: 'provider-a' })).rejects.toThrow(
      /^notification_intent_row_invalid$/u
    );
  });
  it.each([
    ['an unsafe tenant', { tenantId: 'a b' }],
    ['an unsafe installation', { pluginInstallationId: '-x' }],
    ['an unsafe intent', { reference: { ...REFERENCE, intentId: '' } }],
    ['a reference of another tenant', { reference: { ...REFERENCE, tenantId: 'tenant-b' } }],
    ['another event type', { reference: { ...REFERENCE, eventType: 'other' } }],
    ['another event version', { reference: { ...REFERENCE, eventVersion: 2 } }],
    ['a zero clock', { now: 0 }],
    ['a fractional clock', { now: 1.5 }],
    ['an unsafe clock', { now: 2 ** 53 }],
  ])('rejects %s before reading', async (_label, over) => {
    const { store: s, calls } = store();
    await expect(
      s.load({
        tenantId: 'tenant-a',
        pluginInstallationId: 'provider-a',
        reference: REFERENCE,
        now: 500,
        ...over,
      } as never)
    ).rejects.toThrow(/^notification_intent_delivery_input_invalid$/u);
    expect(calls).toEqual([]);
  });
  it('does not see an intent of another tenant', async () => {
    await seed();
    await expect(
      load({ tenantId: 'tenant-b', reference: { ...REFERENCE, tenantId: 'tenant-b' } })
    ).rejects.toThrow(/^notification_intent_unavailable$/u);
    await expect(load({ reference: { ...REFERENCE, intentId: 'other' } })).rejects.toThrow(
      /^notification_intent_unavailable$/u
    );
  });
  it('accepts the last instant before expiry and expires at the instant itself', async () => {
    await seed({ expiresAt: 600 });
    await expect(load({ now: 599 })).resolves.toMatchObject({ state: 'pending' });
    await expect(load({ now: 600 })).rejects.toThrow(/^notification_intent_expired$/u);
    expect(row()).toMatchObject({
      state: 'expired',
      payload_key_id: null,
      payload_envelope_json: null,
      canceled_at: 600,
      dead_lettered_at: null,
      updated_at: 600,
    });
  });
  it('reports a settled intent as terminal and a delivered one by its identifiers', async () => {
    await seed();
    database.exec(
      "UPDATE notification_delivery_intents SET state = 'delivered', payload_key_id = NULL, payload_envelope_json = NULL, delivered_at = 150"
    );
    await expect(load()).resolves.toEqual({
      state: 'delivered',
      intentId: 'intent-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'provider-a',
      notificationKind: 'auth.email_otp',
      idempotencyKey: 'key/intent-a',
      expiresAt: 1_000,
    });
    for (const state of ['canceled', 'dead_letter'] as const) {
      database.exec('DELETE FROM notification_delivery_intents');
      await seed();
      database.exec(
        `UPDATE notification_delivery_intents SET state = '${state}', payload_key_id = NULL, payload_envelope_json = NULL, ${
          state === 'canceled' ? 'canceled_at' : 'dead_lettered_at'
        } = 150`
      );
      await expect(load()).rejects.toThrow(/^notification_intent_terminal$/u);
    }
  });
  describe('rows the database would not hold', () => {
    const loadWith = async (
      patch: Record<string, unknown>,
      seeded: Parameters<typeof seed>[0] = {}
    ) => {
      await seed(seeded);
      return load(
        {},
        {
          intercept: (call) => {
            if (call.kind !== 'first') return undefined;
            return { value: { ...(row() as object), ...patch } };
          },
        }
      );
    };
    const INVALID = /^notification_intent_row_invalid$/u;
    it.each([
      ['unparseable provider ids', { provider_installation_ids_json: '{nope' }],
      ['non-array provider ids', { provider_installation_ids_json: '{}' }],
      ['an empty provider list', { provider_installation_ids_json: '[]' }],
      [
        'nine providers',
        {
          provider_installation_ids_json: JSON.stringify([
            'provider-a',
            ...Array.from({ length: 8 }, (_, i) => `p${i}`),
          ]),
        },
      ],
      ['a numeric provider', { provider_installation_ids_json: JSON.stringify(['provider-a', 5]) }],
      [
        'an unsafe provider',
        { provider_installation_ids_json: JSON.stringify(['provider-a', 'a b']) },
      ],
      [
        'duplicate providers',
        { provider_installation_ids_json: JSON.stringify(['provider-a', 'provider-a']) },
      ],
      [
        'another first provider',
        { provider_installation_ids_json: JSON.stringify(['provider-z']) },
      ],
      ['a negative index', { active_provider_index: -1 }],
      ['an index beyond the list', { active_provider_index: 1 }],
      ['a textual index', { active_provider_index: 'x' }],
      ['a zero start time', { provider_started_at: 0 }],
      ['a textual start time', { provider_started_at: 'x' }],
      ['a textual expiry', { expires_at: 'x' }],
      ['another intent id', { intent_id: 'other' }],
      ['another tenant', { tenant_id: 'tenant-b' }],
      ['an unsafe kind', { notification_kind: 'Bad Kind' }],
      ['a kind starting with a digit', { notification_kind: '1kind' }],
      ['an idempotency key with a space', { idempotency_key: 'a b' }],
      ['an empty idempotency key', { idempotency_key: '' }],
      ['another payload version', { payload_version: 2 }],
      ['a textual payload version', { payload_version: 'x' }],
    ])('rejects %s', async (_label, patch) => {
      await expect(loadWith(patch)).rejects.toThrow(INVALID);
    });
    it('reads numeric strings from storage', async () => {
      await expect(
        loadWith({
          active_provider_index: '0',
          provider_started_at: '100',
          expires_at: '1000',
          payload_version: '1',
        })
      ).resolves.toMatchObject({ state: 'pending', expiresAt: 1_000 });
    });
    it('accepts a provider list of eight', async () => {
      const eight = ['provider-a', ...Array.from({ length: 7 }, (_, i) => `p${i}`)];
      await expect(
        loadWith({ provider_installation_ids_json: JSON.stringify(eight) })
      ).resolves.toMatchObject({ state: 'pending' });
    });
    it('rejects an active index that points at another provider', async () => {
      const eight = ['provider-a', ...Array.from({ length: 7 }, (_, i) => `p${i}`)];
      await expect(
        loadWith({
          provider_installation_ids_json: JSON.stringify(eight),
          active_provider_index: 7,
        })
      ).rejects.toThrow(INVALID);
    });
    it('accepts a notification kind of 128 characters', async () => {
      const kind = `a${'b'.repeat(127)}`;
      await expect(loadWith({ notification_kind: kind }, { kind })).resolves.toMatchObject({
        state: 'pending',
        notificationKind: kind,
      });
    });
    it.each([
      ['no key id', { payload_key_id: null }],
      ['no envelope', { payload_envelope_json: null }],
      ['an empty key id', { payload_key_id: '' }],
    ])('rejects a pending row with %s', async (_label, patch) => {
      await expect(loadWith(patch)).rejects.toThrow(INVALID);
      expect(row().state).toBe('pending');
    });
  });
  describe('decryption failures', () => {
    it.each([
      ['notification_encryption_key_unavailable', 'notification_intent_key_unavailable'],
      ['notification_encryption_key_invalid', 'notification_intent_envelope_invalid'],
      ['notification_envelope_invalid', 'notification_intent_envelope_invalid'],
      ['notification_envelope_context_invalid', 'notification_intent_envelope_invalid'],
      ['notification_envelope_key_unwrap_failed', 'notification_intent_key_unwrap_failed'],
      [
        'notification_envelope_payload_authentication_failed',
        'notification_intent_payload_authentication_failed',
      ],
      ['something else', 'notification_intent_decryption_failed'],
    ])('maps %s to %s and dead-letters the intent', async (message, code) => {
      await seed();
      decrypt.mockRejectedValueOnce(new Error(message));
      await expect(load()).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
      expect(row()).toMatchObject({
        state: 'dead_letter',
        payload_key_id: null,
        payload_envelope_json: null,
        dead_lettered_at: 500,
        canceled_at: null,
        updated_at: 500,
      });
    });
    it('maps a non-Error failure to the generic code', async () => {
      await seed();
      decrypt.mockRejectedValueOnce('boom');
      await expect(load()).rejects.toThrow(/^notification_intent_decryption_failed$/u);
    });
    it('dead-letters a payload that does not match its channel', async () => {
      await seed({ channel: 'sms' });
      await expect(load()).rejects.toThrow(/^notification_intent_payload_invalid$/u);
      expect(row()).toMatchObject({ state: 'dead_letter', dead_lettered_at: 500 });
    });
    it('reports a stale wipe when the intent changed meanwhile', async () => {
      await seed({ expiresAt: 400 });
      await expect(
        load(
          {},
          {
            intercept: (call) =>
              call.kind === 'run'
                ? { value: { success: true, results: [], meta: { changes: 0 } } }
                : undefined,
          }
        )
      ).rejects.toThrow(/^notification_intent_wipe_stale$/u);
    });
    it('binds the wipe to the intent, tenant and first provider', async () => {
      await seed({ expiresAt: 400 });
      const { store: s, calls } = store();
      await s
        .load({
          tenantId: 'tenant-a',
          pluginInstallationId: 'provider-a',
          reference: REFERENCE,
          now: 500,
        })
        .catch(() => undefined);
      expect(calls.find((c) => c.kind === 'run')?.values).toEqual([
        'expired',
        'expired',
        500,
        'expired',
        500,
        500,
        'intent-a',
        'tenant-a',
        'provider-a',
      ]);
    });
  });
});

describe('complete', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    tenantId: 'tenant-a',
    intentId: 'intent-a',
    pluginInstallationId: 'provider-a',
    now: 500,
    ...over,
  });
  const INVALID = /^notification_intent_completion_input_invalid$/u;
  it('marks the intent delivered, wiping the payload and recording provider acceptance', async () => {
    await seed();
    await expect(
      store().store.complete(input({ providerMessageId: 'msg-1' }))
    ).resolves.toBeUndefined();
    expect(row()).toMatchObject({
      state: 'delivered',
      payload_key_id: null,
      payload_envelope_json: null,
      delivered_at: 500,
      provider_accepted_at: 500,
      provider_message_id: 'msg-1',
      delivery_status: 'provider_accepted',
      delivery_status_updated_at: 500,
      attempt_count: 1,
      last_error_code: null,
      updated_at: 500,
    });
  });
  it('stores a missing provider message id as null', async () => {
    await seed();
    await store().store.complete(input());
    expect(row().provider_message_id).toBeNull();
  });
  it('adopts a completion that already happened', async () => {
    await seed();
    await store().store.complete(input());
    await expect(store().store.complete(input({ now: 600 }))).resolves.toBeUndefined();
    expect(row()).toMatchObject({ delivered_at: 500, attempt_count: 1 });
  });
  it.each([
    ['another provider', { pluginInstallationId: 'provider-b' }],
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another intent', { intentId: 'other' }],
  ])('is stale for %s', async (_label, over) => {
    await seed();
    await expect(store().store.complete(input(over))).rejects.toThrow(
      /^notification_intent_completion_stale$/u
    );
    expect(row().state).toBe('pending');
  });
  it('is stale when the intent was dead-lettered meanwhile', async () => {
    await seed();
    await store().store.failPermanent(input());
    await expect(store().store.complete(input())).rejects.toThrow(
      /^notification_intent_completion_stale$/u
    );
  });
  it.each([
    ['an unsafe tenant', { tenantId: '' }],
    ['an unsafe intent', { intentId: '-x' }],
    ['an unsafe installation', { pluginInstallationId: 'a b' }],
    ['an oversized message id', { providerMessageId: 'm'.repeat(513) }],
    ['a zero clock', { now: 0 }],
    ['a fractional clock', { now: 0.5 }],
  ])('rejects %s', async (_label, over) => {
    await expect(store().store.complete(input(over))).rejects.toThrow(INVALID);
  });
  it('accepts a message id of exactly 512 characters', async () => {
    await seed();
    await expect(
      store().store.complete(input({ providerMessageId: 'm'.repeat(512) }))
    ).resolves.toBeUndefined();
  });
  it('treats a missing change count as not applied and reads the reflected state', async () => {
    await seed();
    await expect(
      store({
        intercept: (call) =>
          call.kind === 'run' ? { value: { success: true, results: [], meta: {} } } : undefined,
      }).store.complete(input())
    ).rejects.toThrow(/^notification_intent_completion_stale$/u);
  });
});

describe('failPermanent', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    tenantId: 'tenant-a',
    intentId: 'intent-a',
    pluginInstallationId: 'provider-a',
    now: 500,
    ...over,
  });
  it('dead-letters the intent and wipes the payload', async () => {
    await seed();
    await store().store.failPermanent(input());
    expect(row()).toMatchObject({
      state: 'dead_letter',
      payload_key_id: null,
      payload_envelope_json: null,
      dead_lettered_at: 500,
      updated_at: 500,
    });
  });
  it('adopts an intent that is already dead-lettered but not a delivered one', async () => {
    await seed();
    await store().store.failPermanent(input());
    await expect(store().store.failPermanent(input({ now: 700 }))).resolves.toBeUndefined();
    expect(row().dead_lettered_at).toBe(500);
    database.exec('DELETE FROM notification_delivery_intents');
    await seed();
    await store().store.complete({ ...input(), now: 500 });
    await expect(store().store.failPermanent(input())).rejects.toThrow(
      /^notification_intent_failure_stale$/u
    );
  });
  it.each([
    ['another provider', { pluginInstallationId: 'provider-b' }],
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another intent', { intentId: 'other' }],
  ])('is stale for %s', async (_label, over) => {
    await seed();
    await expect(store().store.failPermanent(input(over))).rejects.toThrow(
      /^notification_intent_failure_stale$/u
    );
  });
  it.each([
    ['an unsafe tenant', { tenantId: '' }],
    ['an unsafe intent', { intentId: '-x' }],
    ['an unsafe installation', { pluginInstallationId: 'a b' }],
    ['a zero clock', { now: 0 }],
    ['a fractional clock', { now: 0.5 }],
  ])('rejects %s', async (_label, over) => {
    await expect(store().store.failPermanent(input(over))).rejects.toThrow(
      /^notification_intent_failure_input_invalid$/u
    );
  });
  it('binds the update in order', async () => {
    await seed();
    const { store: s, calls } = store();
    await s.failPermanent(input());
    expect(calls.find((c) => c.kind === 'run')?.values).toEqual([
      500,
      500,
      'intent-a',
      'tenant-a',
      'provider-a',
    ]);
  });
});

describe('boundaries', () => {
  it('reads an intent whose provider list has exactly eight entries', async () => {
    await seed();
    const eight = ['provider-a', ...Array.from({ length: 7 }, (_, i) => `p${i}`)];
    await expect(
      load(
        { pluginInstallationId: 'p6' },
        {
          rewrite: (call, value) =>
            call.kind === 'first' && value
              ? {
                  ...value,
                  provider_installation_ids_json: JSON.stringify(eight),
                  active_provider_index: 7,
                }
              : value,
        }
      )
    ).resolves.toMatchObject({ state: 'pending', pluginInstallationId: 'p6' });
  });
  it('completes and fails permanently at the smallest clock value, with a single statement each', async () => {
    await seed();
    const first = store();
    await first.store.complete({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      pluginInstallationId: 'provider-a',
      now: 1,
    });
    expect(first.calls.filter((c) => c.kind === 'first')).toEqual([]);
    expect(row()).toMatchObject({ state: 'delivered', delivered_at: 1 });
    database.exec('DELETE FROM notification_delivery_intents');
    await seed();
    const second = store();
    await second.store.failPermanent({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      pluginInstallationId: 'provider-a',
      now: 1,
    });
    expect(second.calls.filter((c) => c.kind === 'first')).toEqual([]);
    expect(row()).toMatchObject({ state: 'dead_letter', dead_lettered_at: 1 });
  });
});

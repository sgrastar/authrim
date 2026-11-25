import { beforeAll, describe, expect, it } from 'vitest';
import { decryptNotificationIntentPayload } from '@authrim/ar-lib-core';
import {
  cleanupExpiredNotificationDeliveryIntents,
  encryptNotificationPayloadFromEnv,
  notificationPayloadEncryptionKeyFromEnv,
  notificationPayloadSymmetricKeysFromEnv,
  notificationPrivateJwksFromEnv,
} from '../notification-intent';
import { createD1, openCoreDatabase } from './helpers/sqlite-d1';
import { must } from './helpers/mock-kit';

let privateKey: Record<string, unknown>;

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
  privateKey = {
    ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
    kid: 'key-a',
    use: 'enc',
    alg: 'RSA-OAEP-256',
    key_ops: ['decrypt'],
  };
});

const jwk = (over: Record<string, unknown> = {}) => JSON.stringify({ ...privateKey, ...over });
const slotA = (over: Record<string, unknown> = {}) => ({
  NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: jwk(over),
});
const INVALID_A = /^notification_decryption_slot_a_invalid$/u;
const INVALID_B = /^notification_decryption_slot_b_invalid$/u;

describe('notificationPrivateJwksFromEnv', () => {
  it('returns the active key alone as a key set', () => {
    expect(JSON.parse(notificationPrivateJwksFromEnv(slotA()))).toEqual({ keys: [privateKey] });
  });
  it('appends the previous slot after the active one', () => {
    const result = JSON.parse(
      notificationPrivateJwksFromEnv({
        ...slotA(),
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B: jwk({ kid: 'key-b' }),
      })
    ) as { keys: Array<{ kid: string }> };
    expect(result.keys.map((key) => key.kid)).toEqual(['key-a', 'key-b']);
  });
  it.each([undefined, '', '   \n'])('ignores an unset previous slot (%j)', (value) => {
    const env = { ...slotA(), NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B: value };
    expect(
      (JSON.parse(notificationPrivateJwksFromEnv(env)) as { keys: unknown[] }).keys
    ).toHaveLength(1);
  });
  it('rejects two slots sharing a key id', () => {
    expect(() =>
      notificationPrivateJwksFromEnv({
        ...slotA(),
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B: jwk(),
      })
    ).toThrow(/^notification_decryption_key_set_invalid$/u);
  });
  it.each([
    ['empty', ''],
    ['not JSON', '{nope'],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['null', 'null'],
    ['a number', '5'],
    ['oversized', jwk({ pad: 'x'.repeat(16_400) })],
  ])('rejects slot A that is %s', (_label, value) => {
    expect(() =>
      notificationPrivateJwksFromEnv({ NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: value })
    ).toThrow(INVALID_A);
  });
  it.each([
    ['another key type', { kty: 'EC' }],
    ['another use', { use: 'sig' }],
    ['another algorithm', { alg: 'RSA-OAEP' }],
    ['no key id', { kid: undefined }],
    ['a numeric key id', { kid: 5 }],
    ['an empty key id', { kid: '' }],
    ['a key id starting with a dash', { kid: '-a' }],
    ['a key id with a space', { kid: 'a b' }],
    ['a key id that is too long', { kid: `a${'b'.repeat(128)}` }],
    ['no operations', { key_ops: undefined }],
    ['operations that are not a list', { key_ops: 'decrypt' }],
    ['no listed operation', { key_ops: [] }],
    ['two operations', { key_ops: ['decrypt', 'unwrapKey'] }],
    ['the wrong operation', { key_ops: ['encrypt'] }],
    ...['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'].flatMap((field) => [
      [`no ${field}`, { [field]: undefined }] as [string, Record<string, unknown>],
      [`a numeric ${field}`, { [field]: 5 }] as [string, Record<string, unknown>],
      [`a ${field} with padding`, { [field]: 'AAAA==' }] as [string, Record<string, unknown>],
      [`an empty ${field}`, { [field]: '' }] as [string, Record<string, unknown>],
    ]),
  ])('rejects slot A with %s', (_label, over) => {
    expect(() => notificationPrivateJwksFromEnv(slotA(over))).toThrow(INVALID_A);
  });
  it('accepts a key id of exactly 128 characters and one of a single character', () => {
    expect(() =>
      notificationPrivateJwksFromEnv(slotA({ kid: `a${'b'.repeat(127)}` }))
    ).not.toThrow();
    expect(() => notificationPrivateJwksFromEnv(slotA({ kid: '9' }))).not.toThrow();
  });
  it('accepts a slot of exactly 16384 characters', () => {
    const padded = JSON.stringify({ ...privateKey, pad: '' });
    const fill = 16_384 - padded.length;
    const exact = JSON.stringify({ ...privateKey, pad: 'x'.repeat(fill) });
    expect(exact).toHaveLength(16_384);
    expect(() =>
      notificationPrivateJwksFromEnv({ NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: exact })
    ).not.toThrow();
  });
  it('reports a malformed previous slot as slot B', () => {
    expect(() =>
      notificationPrivateJwksFromEnv({
        ...slotA(),
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B: jwk({ kid: 'key-b', kty: 'EC' }),
      })
    ).toThrow(INVALID_B);
    expect(() =>
      notificationPrivateJwksFromEnv({
        ...slotA(),
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B: '{nope',
      })
    ).toThrow(INVALID_B);
    expect(() =>
      notificationPrivateJwksFromEnv({
        ...slotA(),
        NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B: 'null',
      })
    ).toThrow(INVALID_B);
  });
});

describe('notificationPayloadEncryptionKeyFromEnv', () => {
  it('exposes only the public half of the active key for encryption', () => {
    const result = notificationPayloadEncryptionKeyFromEnv(slotA());
    expect(result.activeKeyId).toBe('key-a');
    const parsed = JSON.parse(result.publicJwks) as { keys: Array<Record<string, unknown>> };
    expect(parsed.keys).toEqual([
      {
        kty: 'RSA',
        n: privateKey.n,
        e: privateKey.e,
        kid: 'key-a',
        use: 'enc',
        alg: 'RSA-OAEP-256',
        key_ops: ['encrypt'],
      },
    ]);
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(result.publicJwks).not.toContain(String(privateKey[secret]));
    }
  });
  it('rejects a malformed active slot', () => {
    expect(() => notificationPayloadEncryptionKeyFromEnv(slotA({ kty: 'EC' }))).toThrow(INVALID_A);
  });
});

describe('notificationPayloadSymmetricKeysFromEnv', () => {
  const SECRET = 'notification-payload-test-secret-value';
  it('defaults the active key id to v1 under a notification namespace', () => {
    const result = notificationPayloadSymmetricKeysFromEnv({ PLUGIN_ENCRYPTION_KEY: SECRET });
    expect(result).toEqual({
      active: { keyId: 'notification:v1', secret: SECRET },
      all: [{ keyId: 'notification:v1', secret: SECRET }],
    });
  });
  it('uses a configured active key id and appends the previous key', () => {
    const previous = 'previous-secret-value-with-32-chars!';
    const result = notificationPayloadSymmetricKeysFromEnv({
      PLUGIN_ENCRYPTION_KEY: SECRET,
      PLUGIN_ENCRYPTION_ACTIVE_KEY_ID: 'v2',
      PLUGIN_ENCRYPTION_KEY_PREVIOUS: previous,
      PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v1',
    });
    expect(result.active).toEqual({ keyId: 'notification:v2', secret: SECRET });
    expect(result.all).toEqual([
      { keyId: 'notification:v2', secret: SECRET },
      { keyId: 'notification:v1', secret: previous },
    ]);
  });
  it('ignores a previous pair whose values are empty', () => {
    const result = notificationPayloadSymmetricKeysFromEnv({
      PLUGIN_ENCRYPTION_KEY: SECRET,
      PLUGIN_ENCRYPTION_KEY_PREVIOUS: '',
      PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: '',
    });
    expect(result.all).toHaveLength(1);
  });
  it.each([
    ['an id without a secret', { PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v1' }],
    ['a secret without an id', { PLUGIN_ENCRYPTION_KEY_PREVIOUS: 'p'.repeat(40) }],
  ])('rejects %s for the previous key', (_label, extra) => {
    expect(() =>
      notificationPayloadSymmetricKeysFromEnv({ PLUGIN_ENCRYPTION_KEY: SECRET, ...extra })
    ).toThrow(/^plugin_notification_symmetric_keyring_invalid$/u);
  });
  it.each([
    ['a short active secret', { PLUGIN_ENCRYPTION_KEY: 'short' }],
    [
      'an unsafe active id',
      { PLUGIN_ENCRYPTION_KEY: SECRET, PLUGIN_ENCRYPTION_ACTIVE_KEY_ID: 'V 1' },
    ],
    [
      'a previous id equal to the active id',
      {
        PLUGIN_ENCRYPTION_KEY: SECRET,
        PLUGIN_ENCRYPTION_KEY_PREVIOUS: 'p'.repeat(40),
        PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v1',
      },
    ],
  ])('rejects %s through the shared keyring check', (_label, env) => {
    expect(() => notificationPayloadSymmetricKeysFromEnv(env)).toThrow(
      /^plugin_encryption_keyring_invalid$/u
    );
  });
});

describe('encryptNotificationPayloadFromEnv', () => {
  const ENV = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    PLUGIN_ENCRYPTION_KEY: 'notification-payload-test-secret-value',
  };
  const context = (over: Record<string, unknown> = {}) => ({
    environmentId: 'test',
    tenantId: 'tenant-a',
    intentId: 'intent-a',
    notificationKind: 'auth.email_otp',
    payloadVersion: 1,
    ...over,
  });
  const payload = {
    channel: 'email',
    to: 'person@example.test',
    subject: 'Code',
    body: 'Your code is 123456',
  };
  const INPUT = /^plugin_notification_encryption_input_invalid$/u;

  it('returns an envelope the matching key can open, bound to its context', async () => {
    const result = await encryptNotificationPayloadFromEnv(ENV, { context: context(), payload });
    expect(result.activeKeyId).toBe('notification:v1');
    expect(result.envelope).not.toContain('person@example.test');
    await expect(
      decryptNotificationIntentPayload({
        symmetricKeys: [{ keyId: 'notification:v1', secret: ENV.PLUGIN_ENCRYPTION_KEY }],
        context: context() as never,
        envelope: result.envelope,
      })
    ).resolves.toMatchObject({ to: 'person@example.test', body: 'Your code is 123456' });
    await expect(
      decryptNotificationIntentPayload({
        symmetricKeys: [{ keyId: 'notification:v1', secret: ENV.PLUGIN_ENCRYPTION_KEY }],
        context: context({ intentId: 'intent-b' }) as never,
        envelope: result.envelope,
      })
    ).rejects.toThrow();
  });
  it('encrypts with the configured active key id', async () => {
    const result = await encryptNotificationPayloadFromEnv(
      { ...ENV, PLUGIN_ENCRYPTION_ACTIVE_KEY_ID: 'v9' },
      { context: context(), payload }
    );
    expect(result.activeKeyId).toBe('notification:v9');
  });
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'x'],
    ['no payload', { context: context() }],
    ['an extra key', { context: context(), payload, extra: 1 }],
    ['no context', { payload }],
    ['a null context', { context: null, payload }],
    ['an array context', { context: [], payload }],
    ['a string context', { context: 'x', payload }],
    ['another environment', { context: context({ environmentId: 'prod' }), payload }],
    ['an extra context key', { context: context({ extra: 1 }), payload }],
    ['a missing tenant', { context: context({ tenantId: undefined }), payload }],
    ['a numeric tenant', { context: context({ tenantId: 5 }), payload }],
    ['a numeric intent', { context: context({ intentId: 5 }), payload }],
    ['a numeric kind', { context: context({ notificationKind: 5 }), payload }],
    ['another payload version', { context: context({ payloadVersion: 2 }), payload }],
    ['a string payload version', { context: context({ payloadVersion: '1' }), payload }],
  ])('rejects %s', async (_label, input) => {
    await expect(encryptNotificationPayloadFromEnv(ENV, input)).rejects.toThrow(INPUT);
  });
  it('rejects a payload the delivery contract does not accept', async () => {
    await expect(
      encryptNotificationPayloadFromEnv(ENV, { context: context(), payload: { channel: 'fax' } })
    ).rejects.toThrow();
  });
  it('reports a broken key configuration with a fixed code', async () => {
    await expect(
      encryptNotificationPayloadFromEnv(
        { ...ENV, PLUGIN_ENCRYPTION_KEY: 'short' },
        { context: context(), payload }
      )
    ).rejects.toThrow(/^plugin_notification_key_configuration_invalid$/u);
    await expect(
      encryptNotificationPayloadFromEnv(
        { ...ENV, PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v0' },
        { context: context(), payload }
      )
    ).rejects.toThrow(/^plugin_notification_key_configuration_invalid$/u);
  });
});

describe('cleanupExpiredNotificationDeliveryIntents', () => {
  const insertExpired = (
    database: ReturnType<typeof openCoreDatabase>,
    id: string,
    deleteAfter: number
  ) =>
    database
      .prepare(
        `INSERT INTO notification_delivery_intents (
           intent_id, tenant_id, plugin_installation_id, provider_order_version,
           provider_installation_ids_json, active_provider_index, provider_started_at,
           channel, notification_kind, payload_version, payload_key_id, payload_envelope_json,
           idempotency_key, request_fingerprint, fingerprint_key_id, state, expires_at,
           delete_after, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'p', 1, '["p"]', 0, 1, 'email', 'k', 1, 'key', '{}', ?, ?,
                   'fp', 'pending', 50, ?, 1, 1)`
      )
      .run(id, id, 'a'.repeat(64), deleteAfter);
  const remaining = (database: ReturnType<typeof openCoreDatabase>) =>
    (
      database
        .prepare('SELECT intent_id FROM notification_delivery_intents ORDER BY intent_id')
        .all() as Array<{
        intent_id: string;
      }>
    ).map((row) => row.intent_id);
  it.each([
    ['zero clock', { now: 0 }],
    ['fractional clock', { now: 1.5 }],
    ['unsafe clock', { now: 2 ** 53 }],
    ['zero limit', { now: 100, limit: 0 }],
    ['fractional limit', { now: 100, limit: 1.5 }],
    ['oversized limit', { now: 100, limit: 1_001 }],
  ])('rejects a %s', async (_label, input) => {
    const database = openCoreDatabase();
    await expect(
      cleanupExpiredNotificationDeliveryIntents(createD1(database).db, input)
    ).rejects.toThrow(/^notification_intent_cleanup_input_invalid$/u);
  });
  it('deletes the oldest due rows first, inclusive of the cut-off, up to the limit', async () => {
    const database = openCoreDatabase();
    insertExpired(database, 'c', 100);
    insertExpired(database, 'a', 90);
    insertExpired(database, 'b', 90);
    insertExpired(database, 'd', 101);
    const d1 = createD1(database);
    await expect(
      cleanupExpiredNotificationDeliveryIntents(d1.db, { now: 100, limit: 2 })
    ).resolves.toEqual({ deleted: 2 });
    expect(remaining(database)).toEqual(['c', 'd']);
    expect(must(d1.calls.find((call) => call.kind === 'run')).values).toEqual([100, 2, 100]);
    await expect(cleanupExpiredNotificationDeliveryIntents(d1.db, { now: 100 })).resolves.toEqual({
      deleted: 1,
    });
    expect(remaining(database)).toEqual(['d']);
  });
  it('defaults to a limit of 100 and accepts the bounds', async () => {
    const database = openCoreDatabase();
    const d1 = createD1(database);
    await cleanupExpiredNotificationDeliveryIntents(d1.db, { now: 1 });
    await cleanupExpiredNotificationDeliveryIntents(d1.db, { now: 1, limit: 1_000 });
    expect(d1.calls.filter((call) => call.kind === 'run').map((call) => call.values[1])).toEqual([
      100, 1_000,
    ]);
  });
  it.each([
    ['an unsuccessful result', { success: false, meta: { changes: 1 } }],
    ['a reported error', { success: true, error: 'x', meta: { changes: 1 } }],
    ['a missing count', { success: true, meta: {} }],
    ['a negative count', { success: true, meta: { changes: -1 } }],
    ['a fractional count', { success: true, meta: { changes: 0.5 } }],
    ['a count beyond the limit', { success: true, meta: { changes: 101 } }],
  ])('refuses %s', async (_label, value) => {
    const d1 = createD1(openCoreDatabase(), {
      intercept: (call) => (call.kind === 'run' ? { value } : undefined),
    });
    await expect(cleanupExpiredNotificationDeliveryIntents(d1.db, { now: 5 })).rejects.toThrow(
      /^notification_intent_cleanup_failed$/u
    );
  });
  it('accepts a count equal to the limit and a count of zero', async () => {
    const answer = (changes: number) =>
      createD1(openCoreDatabase(), {
        intercept: (call) =>
          call.kind === 'run' ? { value: { success: true, meta: { changes } } } : undefined,
      }).db;
    await expect(
      cleanupExpiredNotificationDeliveryIntents(answer(100), { now: 5 })
    ).resolves.toEqual({ deleted: 100 });
    await expect(cleanupExpiredNotificationDeliveryIntents(answer(0), { now: 5 })).resolves.toEqual(
      { deleted: 0 }
    );
  });
  it('needs the D1 sessions API', async () => {
    const d1 = createD1(openCoreDatabase(), { withoutSession: true });
    await expect(cleanupExpiredNotificationDeliveryIntents(d1.db, { now: 5 })).rejects.toThrow(
      /^notification_intent_d1_session_required$/u
    );
  });
});

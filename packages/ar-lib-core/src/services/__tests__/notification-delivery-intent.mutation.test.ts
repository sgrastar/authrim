import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envelope = vi.hoisted(() => ({
  encrypt: vi.fn(),
  keyId: vi.fn(),
}));
vi.mock('../notification-intent-envelope', () => ({
  encryptNotificationIntentPayload: envelope.encrypt,
  notificationIntentEnvelopeKeyId: envelope.keyId,
}));

import { createNotificationDeliveryIntent } from '../notification-delivery-intent';
import {
  HMAC_KEY,
  NOW,
  baseInput,
  hmacHex,
  makeD1,
  norm,
  sortKeys,
} from './notification-delivery-intent.fixtures';

const INVALID_INPUT = 'notification_intent_input_invalid';
const INVALID_PLAN = 'notification_intent_provider_order_invalid';

beforeEach(() => {
  envelope.encrypt.mockReset().mockResolvedValue('ENVELOPE');
  envelope.keyId.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('provider plan validation', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `inst-${i}`);
  const bad: Array<[string, unknown]> = [
    ['null plan', null],
    ['non-object plan', 'plan'],
    ['configVersion 0', { configVersion: 0, installationIds: ['a'] }],
    ['configVersion fractional', { configVersion: 1.5, installationIds: ['a'] }],
    ['configVersion NaN', { configVersion: Number.NaN, installationIds: ['a'] }],
    ['configVersion string', { configVersion: '1', installationIds: ['a'] }],
    ['ids not an array', { configVersion: 1, installationIds: 'a' }],
    ['ids empty', { configVersion: 1, installationIds: [] }],
    ['too many ids', { configVersion: 1, installationIds: ids(9) }],
    ['non-string id', { configVersion: 1, installationIds: [1] }],
    ['empty id', { configVersion: 1, installationIds: [''] }],
    ['id with leading dot', { configVersion: 1, installationIds: ['.a'] }],
    ['id with space', { configVersion: 1, installationIds: ['a b'] }],
    ['id too long', { configVersion: 1, installationIds: ['a'.repeat(257)] }],
    ['duplicate ids', { configVersion: 1, installationIds: ['a', 'a'] }],
  ];
  it.each(bad)('rejects %s', async (_name, plan) => {
    const { db, session } = makeD1();
    await expect(
      createNotificationDeliveryIntent(baseInput(db, { providerOrder: plan as never }))
    ).rejects.toThrow(INVALID_PLAN);
    expect(session.batch).not.toHaveBeenCalled();
  });

  it('accepts the boundary plan (configVersion 1, 8 ids of length 256) and copies the ids', async () => {
    const longId = 'a'.repeat(256);
    const list = [...ids(7), longId];
    const { db, batches } = makeD1();
    const providerOrder = { configVersion: 1, installationIds: list };
    const ref = await createNotificationDeliveryIntent(baseInput(db, { providerOrder }));
    expect(ref.pluginInstallationId).toBe('inst-0');
    expect(batches[0][0].args[4]).toBe(JSON.stringify(list));
    expect(batches[0][0].args[3]).toBe(1);
  });
});

describe('input validation', () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['environmentId empty', { environmentId: '' }, false],
    ['environmentId bad first char', { environmentId: '.env' }, false],
    ['environmentId too long', { environmentId: 'e'.repeat(257) }, false],
    ['environmentId max length', { environmentId: 'e'.repeat(256) }, true],
    ['environmentId punctuation', { environmentId: 'e.n:v_1-x' }, true],
    ['tenantId invalid', { tenantId: 'bad tenant' }, false],
    ['intentId invalid', { intentId: '' }, false],
    ['outboxId invalid', { outboxId: 'a/b' }, false],
    ['kind uppercase', { notificationKind: 'Auth' }, false],
    ['kind empty', { notificationKind: '' }, false],
    ['kind leading digit', { notificationKind: '1auth' }, false],
    ['kind max length', { notificationKind: 'a'.repeat(128) }, true],
    ['kind too long', { notificationKind: 'a'.repeat(129) }, false],
    ['accountId invalid', { accountId: 'bad id' }, false],
    ['accountId valid', { accountId: 'acct-1' }, true],
    ['masked max', { recipientMasked: 'm'.repeat(2048) }, true],
    ['masked too long', { recipientMasked: 'm'.repeat(2049) }, false],
    [
      'encrypted max',
      { recipientEncrypted: 'e'.repeat(8192), recipientEncryptionKeyVersion: 1 },
      true,
    ],
    [
      'encrypted too long',
      { recipientEncrypted: 'e'.repeat(8193), recipientEncryptionKeyVersion: 1 },
      false,
    ],
    ['encrypted without key version', { recipientEncrypted: 'x' }, false],
    [
      'encrypted key version 0',
      { recipientEncrypted: 'x', recipientEncryptionKeyVersion: 0 },
      false,
    ],
    [
      'encrypted key version fractional',
      { recipientEncrypted: 'x', recipientEncryptionKeyVersion: 1.5 },
      false,
    ],
    [
      'encrypted key version 1',
      { recipientEncrypted: 'x', recipientEncryptionKeyVersion: 1 },
      true,
    ],
    ['idempotency empty', { idempotencyKey: '' }, false],
    ['idempotency space', { idempotencyKey: 'a b' }, false],
    ['idempotency non-ascii', { idempotencyKey: 'café' }, false],
    ['idempotency 0x7f', { idempotencyKey: 'a\u007f' }, false],
    ['idempotency max', { idempotencyKey: '!'.repeat(256) }, true],
    ['idempotency too long', { idempotencyKey: '!'.repeat(257) }, false],
    ['idempotency tilde', { idempotencyKey: '~' }, true],
    ['now zero', { now: 0, expiresAt: 5 }, false],
    ['now fractional', { now: 1.5, expiresAt: 5 }, false],
    ['now one', { now: 1, expiresAt: 2 }, true],
    ['expiresAt equals now', { expiresAt: NOW }, false],
    ['expiresAt before now', { expiresAt: NOW - 1 }, false],
    ['expiresAt now+1', { expiresAt: NOW + 1 }, true],
    ['expiresAt fractional', { expiresAt: NOW + 1.5 }, false],
    ['expiresAt NaN', { expiresAt: Number.NaN }, false],
    ['expiresAt at 7 days', { expiresAt: NOW + 7 * 24 * 60 * 60 }, true],
    ['expiresAt beyond 7 days', { expiresAt: NOW + 7 * 24 * 60 * 60 + 1 }, false],
  ];

  it.each(cases)('%s', async (_name, over, valid) => {
    const { db, batches } = makeD1();
    const run = createNotificationDeliveryIntent(baseInput(db, over));
    if (valid) {
      await expect(run).resolves.toMatchObject({ state: 'pending' });
      expect(batches).toHaveLength(1);
    } else {
      await expect(run).rejects.toThrow(INVALID_INPUT);
      expect(batches).toHaveLength(0);
    }
  });

  it('validates the plan before the other inputs', async () => {
    const { db } = makeD1();
    await expect(
      createNotificationDeliveryIntent(
        baseInput(db, { tenantId: '', providerOrder: { configVersion: 0, installationIds: [] } })
      )
    ).rejects.toThrow(INVALID_PLAN);
  });

  it('derives now from the clock in whole seconds when not supplied', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000 + 999);
    const { db, batches } = makeD1();
    const input = baseInput(db, { now: undefined, expiresAt: NOW + 60 });
    await createNotificationDeliveryIntent(input);
    const args = batches[0][0].args;
    expect(args[5]).toBe(NOW);
    expect(args[19]).toBe(NOW);
    await expect(
      createNotificationDeliveryIntent(baseInput(db, { now: undefined, expiresAt: NOW }))
    ).rejects.toThrow(INVALID_INPUT);
  });

  it('validates the payload and the HMAC key length', async () => {
    const { db } = makeD1();
    await expect(
      createNotificationDeliveryIntent(
        baseInput(db, { payload: { channel: 'email', to: '', body: 'x' } })
      )
    ).rejects.toThrow('notification_intent_payload_invalid');
    for (const length of [0, 31, 513]) {
      await expect(
        createNotificationDeliveryIntent(baseInput(db, { idempotencyHmacKey: 'k'.repeat(length) }))
      ).rejects.toThrow('notification_intent_hmac_key_invalid');
    }
    for (const length of [32, 512]) {
      await expect(
        createNotificationDeliveryIntent(baseInput(db, { idempotencyHmacKey: 'k'.repeat(length) }))
      ).resolves.toMatchObject({ intentId: 'intent-1' });
    }
  });
});

describe('envelope selection', () => {
  const prepared = { keyId: 'prep-key', envelope: 'PREP-ENVELOPE' };

  it('encrypts the parsed payload with the exact context and stores the active key id', async () => {
    const { db, batches } = makeD1();
    await createNotificationDeliveryIntent(
      baseInput(db, { payload: { channel: 'sms', to: '+8100', body: 'b', subject: 's' } })
    );
    expect(envelope.encrypt).toHaveBeenCalledWith({
      publicJwks: '{"keys":[]}',
      activeKeyId: 'key-1',
      context: {
        environmentId: 'env-1',
        tenantId: 'tenant-1',
        intentId: 'intent-1',
        notificationKind: 'auth.otp',
        payloadVersion: 1,
      },
      payload: { channel: 'sms', to: '+8100', body: 'b', subject: 's' },
    });
    expect(batches[0][0].args[12]).toBe('key-1');
    expect(batches[0][0].args[13]).toBe('ENVELOPE');
    expect(envelope.keyId).not.toHaveBeenCalled();
  });

  it('uses a prepared envelope whose key id matches, without re-encrypting', async () => {
    envelope.keyId.mockReturnValue('prep-key');
    const { db, batches } = makeD1();
    await createNotificationDeliveryIntent(
      baseInput(db, { publicJwks: undefined, activeKeyId: undefined, preparedEnvelope: prepared })
    );
    expect(envelope.keyId).toHaveBeenCalledWith('PREP-ENVELOPE');
    expect(envelope.encrypt).not.toHaveBeenCalled();
    expect(batches[0][0].args[12]).toBe('prep-key');
    expect(batches[0][0].args[13]).toBe('PREP-ENVELOPE');
  });

  it.each([
    ['publicJwks alongside prepared', { activeKeyId: undefined }, 'prep-key'],
    ['activeKeyId alongside prepared', { publicJwks: undefined }, 'prep-key'],
    ['mismatching key id', { publicJwks: undefined, activeKeyId: undefined }, 'other-key'],
  ])('rejects a prepared envelope with %s', async (_name, over, derived) => {
    envelope.keyId.mockReturnValue(derived);
    const { db, session } = makeD1();
    await expect(
      createNotificationDeliveryIntent(baseInput(db, { ...over, preparedEnvelope: prepared }))
    ).rejects.toThrow('notification_encryption_key_invalid');
    expect(session.batch).not.toHaveBeenCalled();
  });

  it.each([
    ['publicJwks', { publicJwks: undefined }],
    ['activeKeyId', { activeKeyId: undefined }],
  ])('requires %s when no envelope was prepared', async (_name, over) => {
    const { db, session } = makeD1();
    await expect(createNotificationDeliveryIntent(baseInput(db, over))).rejects.toThrow(
      'notification_encryption_key_invalid'
    );
    expect(envelope.encrypt).not.toHaveBeenCalled();
    expect(session.batch).not.toHaveBeenCalled();
  });

  it('requires a D1 session-capable database', async () => {
    const { db } = makeD1({ withSession: false });
    await expect(createNotificationDeliveryIntent(baseInput(db))).rejects.toThrow(
      'notification_intent_d1_session_required'
    );
  });
});

describe('commit', () => {
  it('writes the intent and outbox rows atomically with exact bindings', async () => {
    const { db, session, batches, reads } = makeD1();
    const input = baseInput(db, {
      accountId: 'acct-1',
      recipientMasked: 'a***@example.com',
      recipientEncrypted: 'ENC',
      recipientEncryptionKeyVersion: 7,
    });
    const ref = await createNotificationDeliveryIntent(input);

    expect(db.withSession).toHaveBeenCalledWith('first-primary');
    expect(session.batch).toHaveBeenCalledTimes(1);
    const [intent, outbox] = batches[0];
    const payload = sortKeys({ channel: 'email', to: 'a@example.com', body: 'hello' });
    const canonical = JSON.stringify([
      'authrim-notification-intent-idempotency-v1',
      'env-1',
      'tenant-1',
      'intent-1',
      'outbox-1',
      { configVersion: 4, installationIds: ['inst-a', 'inst-b'] },
      'auth.otp',
      'acct-1',
      'a***@example.com',
      'idem-1',
      NOW + 600,
      payload,
    ]);
    const fingerprint = await hmacHex(HMAC_KEY, canonical);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(norm(intent.sql)).toBe(
      norm(`INSERT INTO notification_delivery_intents (
           intent_id, tenant_id, plugin_installation_id, provider_order_version,
           provider_installation_ids_json, active_provider_index, provider_started_at,
           channel, notification_kind,
           account_id, recipient_masked, recipient_encrypted, recipient_encryption_key_version,
           payload_version, payload_key_id, payload_envelope_json, idempotency_key,
           request_fingerprint, fingerprint_key_id, state, expires_at, delete_after,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    );
    expect(intent.args).toEqual([
      'intent-1',
      'tenant-1',
      'inst-a',
      4,
      '["inst-a","inst-b"]',
      NOW,
      'email',
      'auth.otp',
      'acct-1',
      'a***@example.com',
      'ENC',
      7,
      'key-1',
      'ENVELOPE',
      'idem-1',
      fingerprint,
      'notification-intent-v1',
      NOW + 600,
      NOW + 90 * 24 * 60 * 60,
      NOW,
      NOW,
    ]);
    expect(norm(outbox.sql)).toBe(
      norm(`INSERT INTO plugin_hook_outbox (
           outbox_id, tenant_id, plugin_installation_id, capability, event_type,
           event_version, idempotency_key, payload_json, payload_class,
           status, attempt_no, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reference_v1', 'queued', 0, ?, ?)`)
    );
    expect(outbox.args).toEqual([
      'outbox-1',
      'tenant-1',
      'inst-a',
      'notifier.send',
      'notification.delivery.requested',
      1,
      'idem-1',
      '{"tenantId":"tenant-1","intentId":"intent-1","eventType":"notification.delivery.requested","eventVersion":1}',
      NOW,
      NOW,
    ]);

    expect(reads).toHaveLength(2);
    expect(norm(reads[0].sql)).toBe(
      norm(`SELECT intent_id, tenant_id, plugin_installation_id, provider_order_version,
                provider_installation_ids_json, active_provider_index, provider_started_at,
                channel, notification_kind,
                account_id, recipient_masked,
                payload_version, payload_key_id, idempotency_key, state, expires_at
                , request_fingerprint, fingerprint_key_id
           FROM notification_delivery_intents
          WHERE intent_id = ? AND tenant_id = ?`)
    );
    expect(reads[0].args).toEqual(['intent-1', 'tenant-1']);
    expect(norm(reads[1].sql)).toBe(
      norm(`SELECT outbox_id, tenant_id, plugin_installation_id, capability, event_type,
                event_version, idempotency_key, payload_json, payload_class, status
           FROM plugin_hook_outbox
          WHERE outbox_id = ? AND tenant_id = ?`)
    );
    expect(reads[1].args).toEqual(['outbox-1', 'tenant-1']);
    expect(ref).toEqual({
      tenantId: 'tenant-1',
      intentId: 'intent-1',
      outboxId: 'outbox-1',
      pluginInstallationId: 'inst-a',
      notificationKind: 'auth.otp',
      channel: 'email',
      expiresAt: NOW + 600,
      state: 'pending',
    });
  });

  it('binds null for omitted optional recipient fields', async () => {
    const { db, batches } = makeD1();
    await createNotificationDeliveryIntent(baseInput(db));
    expect(batches[0][0].args.slice(8, 12)).toEqual([null, null, null, null]);
  });

  it('keeps delete_after at least 90 days out regardless of expiry', async () => {
    const { db, batches } = makeD1();
    await createNotificationDeliveryIntent(baseInput(db, { expiresAt: NOW + 7 * 86_400 }));
    expect(batches[0][0].args[18]).toBe(NOW + 90 * 86_400);
  });

  it('reports commit failure when nothing was persisted, whatever the batch outcome', async () => {
    const outcomes = [
      new Error('d1 down'),
      [{ success: true }],
      [{ success: true }, { success: false }],
      [{ success: true }, { success: true, error: 'boom' }],
      [{ success: true }, { success: true }, { success: true }],
    ];
    for (const batchResult of outcomes) {
      const { db } = makeD1({ persist: false, batchResult });
      await expect(createNotificationDeliveryIntent(baseInput(db))).rejects.toThrow(
        'notification_intent_commit_failed'
      );
    }
  });

  it('adopts the persisted rows when the batch response was lost', async () => {
    const { db } = makeD1({ batchResult: new Error('timeout') });
    await expect(createNotificationDeliveryIntent(baseInput(db))).resolves.toMatchObject({
      state: 'pending',
    });
  });
});

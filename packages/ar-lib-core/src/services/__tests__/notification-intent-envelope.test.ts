import { beforeAll, describe, expect, it } from 'vitest';
import {
  decryptNotificationIntentPayload,
  encryptNotificationIntentPayload,
  type NotificationIntentEnvelopeContext,
} from '../notification-intent-envelope';
import { parseNotificationDeliveryPayload } from '../notification-delivery-intent';

const KEY_ID = 'notification-test-key';
const CONTEXT: NotificationIntentEnvelopeContext = {
  environmentId: 'test',
  tenantId: 'tenant-a',
  intentId: 'intent-1',
  notificationKind: 'auth.email_otp',
  payloadVersion: 1,
};

let publicJwks: string;
let privateJwks: string;

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
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey('jwk', pair.publicKey),
    crypto.subtle.exportKey('jwk', pair.privateKey),
  ]);
  publicJwks = JSON.stringify({
    keys: [{ ...publicKey, kid: KEY_ID, use: 'enc', alg: 'RSA-OAEP-256', key_ops: ['encrypt'] }],
  });
  privateJwks = JSON.stringify({
    keys: [{ ...privateKey, kid: KEY_ID, use: 'enc', alg: 'RSA-OAEP-256', key_ops: ['decrypt'] }],
  });
});

describe('notification intent envelope', () => {
  it('round-trips a protected notification payload', async () => {
    const payload = {
      channel: 'email',
      to: 'person@example.test',
      subject: 'Sign-in code',
      body: 'Code: 123456',
    };
    const envelope = await encryptNotificationIntentPayload({
      publicJwks,
      activeKeyId: KEY_ID,
      context: CONTEXT,
      payload,
    });

    expect(envelope).not.toContain(payload.to);
    expect(envelope).not.toContain('123456');
    await expect(
      decryptNotificationIntentPayload({ privateJwks, context: CONTEXT, envelope })
    ).resolves.toEqual(payload);
  });

  it.each([
    ['environmentId', 'other'],
    ['tenantId', 'tenant-b'],
    ['intentId', 'intent-2'],
    ['notificationKind', 'auth.password_reset'],
  ] as const)('rejects a valid envelope under a different %s', async (field, value) => {
    const envelope = await encryptNotificationIntentPayload({
      publicJwks,
      activeKeyId: KEY_ID,
      context: CONTEXT,
      payload: { channel: 'email', to: 'person@example.test', body: 'secret' },
    });

    await expect(
      decryptNotificationIntentPayload({
        privateJwks,
        context: { ...CONTEXT, [field]: value },
        envelope,
      })
    ).rejects.toThrow('notification_envelope_authentication_failed');
  });

  it('rejects ciphertext tampering without exposing crypto details', async () => {
    const envelope = await encryptNotificationIntentPayload({
      publicJwks,
      activeKeyId: KEY_ID,
      context: CONTEXT,
      payload: { channel: 'email', to: 'person@example.test', body: 'secret' },
    });
    const parsed = JSON.parse(envelope) as { ciphertext: string };
    parsed.ciphertext = `${parsed.ciphertext.slice(0, -1)}${parsed.ciphertext.endsWith('A') ? 'B' : 'A'}`;

    await expect(
      decryptNotificationIntentPayload({
        privateJwks,
        context: CONTEXT,
        envelope: JSON.stringify(parsed),
      })
    ).rejects.toThrow('notification_envelope_authentication_failed');
  });

  it('rejects an unavailable key id without trying another key', async () => {
    const envelope = await encryptNotificationIntentPayload({
      publicJwks,
      activeKeyId: KEY_ID,
      context: CONTEXT,
      payload: { body: 'secret' },
    });
    const parsed = JSON.parse(envelope) as { keyId: string };
    parsed.keyId = 'unknown-key';

    await expect(
      decryptNotificationIntentPayload({
        privateJwks,
        context: CONTEXT,
        envelope: JSON.stringify(parsed),
      })
    ).rejects.toThrow('notification_encryption_key_unavailable');
  });

  it('rejects private key material in the producer public JWKS', async () => {
    await expect(
      encryptNotificationIntentPayload({
        publicJwks: privateJwks,
        activeKeyId: KEY_ID,
        context: CONTEXT,
        payload: { body: 'secret' },
      })
    ).rejects.toThrow('notification_encryption_key_invalid');
  });

  it('rejects duplicate key ids and incomplete private RSA parameters', async () => {
    const publicKey = (JSON.parse(publicJwks) as { keys: Record<string, unknown>[] }).keys[0];
    await expect(
      encryptNotificationIntentPayload({
        publicJwks: JSON.stringify({ keys: [publicKey, publicKey] }),
        activeKeyId: KEY_ID,
        context: CONTEXT,
        payload: { body: 'secret' },
      })
    ).rejects.toThrow('notification_encryption_key_invalid');

    const envelope = await encryptNotificationIntentPayload({
      publicJwks,
      activeKeyId: KEY_ID,
      context: CONTEXT,
      payload: { body: 'secret' },
    });
    const incomplete = (JSON.parse(privateJwks) as { keys: Record<string, unknown>[] }).keys[0];
    delete incomplete.p;
    await expect(
      decryptNotificationIntentPayload({
        privateJwks: JSON.stringify({ keys: [incomplete] }),
        context: CONTEXT,
        envelope,
      })
    ).rejects.toThrow('notification_encryption_key_invalid');
  });

  it('rejects oversized plaintext before storage', async () => {
    await expect(
      encryptNotificationIntentPayload({
        publicJwks,
        activeKeyId: KEY_ID,
        context: CONTEXT,
        payload: { body: 'x'.repeat(128 * 1024) },
      })
    ).rejects.toThrow('notification_payload_invalid');
  });
});

describe('notification delivery payload parsing', () => {
  it('normalizes supported provider fields without retaining caller-owned arrays', () => {
    const cc = ['copy@example.test'];
    const parsed = parseNotificationDeliveryPayload({
      channel: 'email',
      to: 'person@example.test',
      from: 'sender@example.test',
      subject: 'Subject',
      body: 'Body',
      replyTo: 'reply@example.test',
      cc,
      bcc: ['audit@example.test'],
      templateId: 'sign-in',
      templateVars: { code: '123456' },
      metadata: { attempt: 1 },
    });
    cc[0] = 'mutated@example.test';

    expect(parsed.cc).toEqual(['copy@example.test']);
    expect(parsed.templateVars).toEqual({ code: '123456' });
  });

  it.each([
    [{ channel: 'email', to: 'a@example.test', body: 'Body', providerApiKey: 'secret' }],
    [{ channel: 'email', to: 'a@example.test', body: 'Body', cc: [''] }],
    [{ channel: 'email', to: 'a@example.test', body: 'Body', metadata: { value: Infinity } }],
    [{ channel: 'email', to: 'a@example.test', body: 'Body', replyTo: '' }],
  ])('rejects malformed or unexpected provider payload fields', (payload) => {
    expect(() => parseNotificationDeliveryPayload(payload)).toThrow(
      'notification_intent_payload_invalid'
    );
  });

  it('preserves reserved JSON keys as own data without changing object prototypes', () => {
    const metadata = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"nested":"value"}}'
    ) as Record<string, unknown>;

    const parsed = parseNotificationDeliveryPayload({
      channel: 'email',
      to: 'a@example.test',
      subject: 'Subject',
      body: 'Body',
      metadata,
    });

    expect(Object.getPrototypeOf(parsed.metadata)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed.metadata!, '__proto__')).toBe(true);
    expect(parsed.metadata).toEqual(metadata);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    { values: Array.from({ length: 2_049 }, (_, index) => index) },
    Object.fromEntries(Array.from({ length: 2_049 }, (_, index) => [`key-${index}`, index])),
    { ['x'.repeat(513)]: true },
    {
      a: Array.from({ length: 2_048 }, () => null),
      b: Array.from({ length: 2_048 }, () => null),
      c: Array.from({ length: 2_048 }, () => null),
      d: Array.from({ length: 2_048 }, () => null),
    },
  ])('rejects unbounded nested JSON before encryption', (metadata) => {
    expect(() =>
      parseNotificationDeliveryPayload({
        channel: 'email',
        to: 'a@example.test',
        subject: 'Subject',
        body: 'Body',
        metadata,
      })
    ).toThrow('notification_intent_payload_invalid');
  });

  it('rejects a decrypted payload whose channel differs from the stored channel', () => {
    expect(() =>
      parseNotificationDeliveryPayload(
        { channel: 'sms', to: '+15555550123', body: 'Body' },
        'email'
      )
    ).toThrow('notification_intent_payload_invalid');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptNotificationIntentPayload,
  encryptNotificationIntentPayloadWithSecret,
  parseNotificationDeliveryPayload,
} from '@authrim/ar-lib-core';
import { encryptNotificationPayloadFromEnv } from '../notification-intent';
import { rejectOpaque } from './helpers/mock-kit';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    encryptNotificationIntentPayloadWithSecret: vi.fn(
      actual.encryptNotificationIntentPayloadWithSecret
    ),
    decryptNotificationIntentPayload: vi.fn(actual.decryptNotificationIntentPayload),
    parseNotificationDeliveryPayload: vi.fn(actual.parseNotificationDeliveryPayload),
  };
});

const ENV = {
  AUTHRIM_ENVIRONMENT_NAME: 'test',
  PLUGIN_ENCRYPTION_KEY: 'notification-payload-test-secret-value',
};
const INPUT = {
  context: {
    environmentId: 'test',
    tenantId: 'tenant-a',
    intentId: 'intent-a',
    notificationKind: 'auth.email_otp',
    payloadVersion: 1,
  },
  payload: { channel: 'email', to: 'person@example.test', body: 'code' },
};
const encrypt = vi.mocked(encryptNotificationIntentPayloadWithSecret);
const decrypt = vi.mocked(decryptNotificationIntentPayload);
const parse = vi.mocked(parseNotificationDeliveryPayload);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('encryption round trip', () => {
  it('encrypts under the active key for exactly the supplied context and verifies the result', async () => {
    const result = await encryptNotificationPayloadFromEnv(ENV, INPUT);
    expect(encrypt).toHaveBeenCalledWith({
      secret: ENV.PLUGIN_ENCRYPTION_KEY,
      keyId: 'notification:v1',
      context: INPUT.context,
      payload: INPUT.payload,
    });
    expect(decrypt).toHaveBeenCalledWith({
      symmetricKeys: [{ keyId: 'notification:v1', secret: ENV.PLUGIN_ENCRYPTION_KEY }],
      context: INPUT.context,
      envelope: result.envelope,
    });
    expect(parse).toHaveBeenLastCalledWith(INPUT.payload, 'email');
  });
  it('verifies against the previous key as well when one is configured', async () => {
    const previous = 'previous-secret-value-with-32-chars!';
    await encryptNotificationPayloadFromEnv(
      { ...ENV, PLUGIN_ENCRYPTION_KEY_PREVIOUS: previous, PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v0' },
      INPUT
    );
    expect(must(decrypt.mock.calls[0])[0].symmetricKeys).toEqual([
      { keyId: 'notification:v1', secret: ENV.PLUGIN_ENCRYPTION_KEY },
      { keyId: 'notification:v0', secret: previous },
    ]);
  });
  it('reports an encryption failure with a fixed code', async () => {
    encrypt.mockRejectedValueOnce(new Error('webcrypto exploded'));
    await expect(encryptNotificationPayloadFromEnv(ENV, INPUT)).rejects.toThrow(
      /^plugin_notification_payload_encryption_failed$/u
    );
  });
  it.each([
    [
      'notification_envelope_private_key_import_failed',
      'plugin_notification_private_key_import_failed',
    ],
    [
      'notification_envelope_payload_authentication_failed',
      'plugin_notification_payload_authentication_failed',
    ],
    ['notification_envelope_other', 'plugin_notification_encryption_round_trip_failed'],
  ])('maps the verification failure %s to %s', async (message, code) => {
    decrypt.mockRejectedValueOnce(new Error(message));
    await expect(encryptNotificationPayloadFromEnv(ENV, INPUT)).rejects.toThrow(
      new RegExp(`^${code}$`, 'u')
    );
  });
  it('maps a non-Error verification failure to the generic round-trip code', async () => {
    decrypt.mockImplementationOnce(() =>
      rejectOpaque('notification_envelope_private_key_import_failed')
    );
    await expect(encryptNotificationPayloadFromEnv(ENV, INPUT)).rejects.toThrow(
      /^plugin_notification_encryption_round_trip_failed$/u
    );
  });
  it('refuses a round trip that no longer satisfies the delivery contract', async () => {
    parse
      .mockImplementationOnce((value) => value as never)
      .mockImplementationOnce(() => {
        throw new Error('contract broken');
      });
    await expect(encryptNotificationPayloadFromEnv(ENV, INPUT)).rejects.toThrow(
      /^plugin_notification_payload_round_trip_invalid$/u
    );
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

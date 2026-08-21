import { describe, expect, it, vi } from 'vitest';
import {
  readEncryptedLoggingMessagePayload,
  writeEncryptedLoggingMessagePayload,
} from '../logging-message-payload-storage';

const ROOT_KEY = '22'.repeat(32);

function createBucket() {
  const objects = new Map<
    string,
    { body: string; customMetadata: Record<string, string>; contentType?: string }
  >();
  return {
    objects,
    put: vi.fn(
      async (
        key: string,
        body: string,
        options?: {
          httpMetadata?: { contentType?: string };
          customMetadata?: Record<string, string>;
        }
      ) => {
        objects.set(key, {
          body,
          customMetadata: options?.customMetadata ?? {},
          contentType: options?.httpMetadata?.contentType,
        });
      }
    ),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object
        ? {
            size: new TextEncoder().encode(object.body).byteLength,
            customMetadata: object.customMetadata,
            text: async () => object.body,
          }
        : null;
    }),
    delete: vi.fn(),
  };
}

describe('encrypted logging message payload storage', () => {
  it('stores only an encrypted envelope and verifies plaintext integrity on read', async () => {
    const bucket = createBucket();
    const env = {
      AUDIT_ARCHIVE: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      OBJECT_ENCRYPTION_KEY_VERSION: '2',
    } as never;
    const write = await writeEncryptedLoggingMessagePayload(env, {
      bucket,
      jobId: 'job-1',
      payloadType: 'retry_delivery',
      schemaVersion: 1,
      lane: 'default',
      criticality: 'standard',
      sourceType: 'payload_object',
      tenantKey: 'tenant-key-1',
      payload: { secret_token: 'never-store-plaintext', count: 1 },
      now: Date.UTC(2026, 0, 1),
    });

    const stored = bucket.objects.get(write.objectRef)!;
    expect(stored.body).not.toContain('never-store-plaintext');
    expect(stored.contentType).toBe('application/vnd.authrim.object-envelope+json');
    expect(stored.customMetadata.encryption).toBe('authrim-object-envelope-v1');
    await expect(
      readEncryptedLoggingMessagePayload(env, write.objectRef, 1024 * 1024)
    ).resolves.toEqual({ ok: true, value: { count: 1, secret_token: 'never-store-plaintext' } });

    stored.customMetadata.sha256 = '00'.repeat(32);
    await expect(
      readEncryptedLoggingMessagePayload(env, write.objectRef, 1024 * 1024)
    ).resolves.toEqual({ ok: false, reason: 'integrity_mismatch' });
  });

  it('rejects plaintext objects without a compatibility fallback', async () => {
    const bucket = createBucket();
    bucket.objects.set('message-jobs/plain.json', {
      body: JSON.stringify({ value: true }),
      customMetadata: { sha256: '00'.repeat(32) },
    });
    await expect(
      readEncryptedLoggingMessagePayload(
        { AUDIT_ARCHIVE: bucket, OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY } as never,
        'message-jobs/plain.json',
        1024
      )
    ).resolves.toEqual({ ok: false, reason: 'unencrypted_payload' });
  });
});

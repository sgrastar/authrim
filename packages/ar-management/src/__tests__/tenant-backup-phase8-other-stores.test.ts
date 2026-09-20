import { describe, expect, it, vi } from 'vitest';
import { createPhase8OtherStoreHandlers } from '../tenant-backup-phase8-other-stores';
import { encodePortableUserAvatar } from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import { encodePortableR2ObjectChunk } from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';

const digest = 'a'.repeat(64);
const context = {
  lease: { tenantId: 'tenant-a' },
  signal: new AbortController().signal,
} as never;

function cursor(datasetId: string, purpose: 'restore' | 'verify' = 'restore') {
  return JSON.stringify({
    version: 1,
    purpose,
    stage: 'phase8',
    datasetId,
    sourceCursor: null,
  });
}

function source(datasetId: string, ignored: string[], rowJson: string, target: unknown = {}) {
  return {
    policy: {
      dataset: { id: datasetId },
      verificationIgnoredColumns: ignored,
    },
    manifest: {},
    target,
    readNextValidatedRow: vi.fn(async ({ sourceCursor }: { sourceCursor: string | null }) =>
      sourceCursor === null ? { rowJson, nextCursor: 'row-1' } : null
    ),
  } as never;
}

describe('Phase 8 sensitive sidecars', () => {
  it('restores target-environment material after the SQL placeholder row exists', async () => {
    const target = {
      writeSidecarText: vi.fn(async (...args: unknown[]) => {
        const value = args[4] as string;
        const matches = args[5] as (stored: string) => Promise<boolean>;
        expect(await matches(value)).toBe(true);
      }),
      writeSidecarValue: vi.fn(async (...args: unknown[]) => {
        const value = args[4] as readonly ['integer', string];
        const matches = args[5] as (stored: readonly ['integer', string]) => Promise<boolean>;
        expect(await matches(value)).toBe(true);
      }),
    };
    const loaded = source(
      'core.totp_credentials',
      ['secret_encrypted', 'secret_key_version'],
      JSON.stringify({
        id: ['text', 'totp-a'],
        tenant_id: ['text', 'tenant-a'],
        secret_encrypted: [
          'text',
          JSON.stringify({
            version: 1,
            kind: 'totp_secret',
            sourceKeyVersion: 3,
            value: 'JBSWY3DPEHPK3PXP',
          }),
        ],
        secret_key_version: ['integer', '3'],
      }),
      target
    );
    const restorePhase8Envelope = vi.fn();
    const handlers = createPhase8OtherStoreHandlers(
      {
        PII_ENCRYPTION_KEY: '22'.repeat(32),
        PII_ENCRYPTION_KEY_VERSION: '7',
      },
      {
        loadPhase8Sqlite: vi.fn(async () => loaded),
        restorePhase8Envelope,
        verifyPhase8Envelope: vi.fn(),
      } as never
    );

    const result = await handlers.restoreOtherStores(
      context,
      digest,
      cursor('core.totp_credentials')
    );

    expect(result.done).toBe(false);
    expect(restorePhase8Envelope).not.toHaveBeenCalled();
    expect(target.writeSidecarText).toHaveBeenCalledOnce();
    expect(target.writeSidecarValue).toHaveBeenCalledOnce();
  });

  it('does not materialize a sensitive sidecar for quarantined source work', async () => {
    const loaded = source(
      'core.notification_delivery_intents',
      [
        'payload_key_id',
        'payload_envelope_json',
        'recipient_encrypted',
        'recipient_encryption_key_version',
      ],
      JSON.stringify({ intent_id: ['text', 'intent-a'], state: ['text', 'pending'] })
    );
    const restorePhase8Envelope = vi.fn();
    const handlers = createPhase8OtherStoreHandlers({}, {
      loadPhase8Sqlite: vi.fn(async () => loaded),
      restorePhase8Envelope,
      verifyPhase8Envelope: vi.fn(),
    } as never);

    await handlers.restoreOtherStores(
      context,
      digest,
      cursor('core.notification_delivery_intents')
    );
    expect(restorePhase8Envelope).not.toHaveBeenCalled();
  });

  it('requires semantic verification for every restored sensitive sidecar', async () => {
    const loaded = source(
      'pii.pii_log',
      ['values_encrypted', 'encryption_key_id', 'encryption_iv'],
      JSON.stringify({
        id: ['text', 'pii-log-a'],
        tenant_id: ['text', 'tenant-a'],
        affected_fields: ['text', '["email"]'],
        values_r2_key: ['text', 'sensitive-detail-catalog:catalog-a'],
        values_encrypted: ['null', null],
        encryption_key_id: ['text', 'pii-key-v1'],
        encryption_iv: ['text', 'source-iv'],
      })
    );
    const handlers = createPhase8OtherStoreHandlers({}, {
      loadPhase8Sqlite: vi.fn(async () => loaded),
      restorePhase8Envelope: vi.fn(),
      verifyPhase8Envelope: vi.fn(async () => false),
    } as never);

    await expect(
      handlers.verifyOtherStores(context, digest, cursor('pii.pii_log', 'verify'))
    ).rejects.toThrow('backup_phase8_other_store_invalid');
  });

  it('restores user avatars through the user-owned record dataset', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3]);
    const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const rowJson = new TextDecoder()
      .decode(
        await encodePortableUserAvatar({
          tenantId: 'tenant-a',
          key: 'avatars/tenant-a/users/user-a.png',
          contentType: 'image/png',
          sha256: [...hashed].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
          bytes,
        })
      )
      .trim();
    const loaded = source('users.public_avatars', [], rowJson);
    const importAsset = vi.fn();
    const handlers = createPhase8OtherStoreHandlers({}, {
      loadPhase8Record: vi.fn(async () => loaded),
      importAsset,
    } as never);

    await handlers.restoreOtherStores(context, digest, cursor('users.public_avatars'));

    expect(importAsset).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ key: 'avatars/tenant-a/users/user-a.png', bytes })
    );
  });

  it('restores a validated portable R2 chunk through the installed object port', async () => {
    const bytes = new TextEncoder().encode('object-body');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const rowJson = new TextDecoder()
      .decode(
        await encodePortableR2ObjectChunk({
          tenantId: 'tenant-a',
          objectId: 'object-a',
          bucketBinding: 'EXPORT_ARTIFACTS',
          objectKey: 'exports/tenant-a/object-a',
          sourceEncoding: 'plaintext',
          objectSha256: sha256,
          totalBytes: bytes.length,
          chunkIndex: 0,
          chunkCount: 1,
          chunkSha256: sha256,
          bytes,
          context: {},
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: null,
        })
      )
      .trim();
    const loaded = source('artifacts.object_catalog_bodies', [], rowJson);
    const importR2Chunk = vi.fn();
    const handlers = createPhase8OtherStoreHandlers({}, {
      loadPhase8Record: vi.fn(async () => loaded),
      importR2Chunk,
    } as never);

    await handlers.restoreOtherStores(context, digest, cursor('artifacts.object_catalog_bodies'));

    expect(importR2Chunk).toHaveBeenCalledWith(
      context,
      digest,
      'artifacts.object_catalog_bodies',
      expect.objectContaining({ objectId: 'object-a', bytes })
    );
  });

  it('restores independent R2 objects concurrently in one bounded checkpoint batch', async () => {
    const active = { value: 0, maximum: 0 };
    const rows = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const bytes = new TextEncoder().encode(`object-${index}`);
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        return new TextDecoder()
          .decode(
            await encodePortableR2ObjectChunk({
              tenantId: 'tenant-a',
              objectId: `object-${index}`,
              bucketBinding: 'EXPORT_ARTIFACTS',
              objectKey: `exports/tenant-a/object-${index}`,
              sourceEncoding: 'plaintext',
              objectSha256: sha256,
              totalBytes: bytes.length,
              chunkIndex: 0,
              chunkCount: 1,
              chunkSha256: sha256,
              bytes,
              context: {},
              httpMetadata: null,
              customMetadata: null,
            })
          )
          .trim();
      })
    );
    const loaded = {
      policy: { dataset: { id: 'artifacts.object_catalog_bodies' } },
      manifest: {},
      readNextValidatedRow: vi.fn(async ({ sourceCursor }: { sourceCursor: string | null }) => {
        const index = sourceCursor === null ? 0 : Number(sourceCursor.split('-')[1]);
        return rows[index] ? { rowJson: rows[index], nextCursor: `row-${index + 1}` } : null;
      }),
    } as never;
    const importR2Chunk = vi.fn(async () => {
      active.value += 1;
      active.maximum = Math.max(active.maximum, active.value);
      await Promise.resolve();
      active.value -= 1;
    });
    const handlers = createPhase8OtherStoreHandlers({}, {
      loadPhase8Record: vi.fn(async () => loaded),
      importR2Chunk,
    } as never);

    const result = await handlers.restoreOtherStores(
      context,
      digest,
      cursor('artifacts.object_catalog_bodies')
    );

    expect(result).toEqual({
      cursor: JSON.stringify({
        version: 1,
        purpose: 'restore',
        stage: 'phase8',
        datasetId: 'artifacts.object_catalog_bodies',
        sourceCursor: 'row-4',
      }),
      done: false,
    });
    expect(importR2Chunk).toHaveBeenCalledTimes(4);
    expect(active.maximum).toBe(4);
  });
});

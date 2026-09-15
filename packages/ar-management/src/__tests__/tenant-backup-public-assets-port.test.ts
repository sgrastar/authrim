import { describe, expect, it } from 'vitest';
import {
  decodePortablePublicAsset,
  decodePortableUserAvatar,
  type PortablePublicAsset,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { createTenantBackupPublicAssetPorts } from '../tenant-backup-public-assets-port';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function bucket(
  initial: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }> = new Map()
) {
  const values = new Map(initial);
  return {
    values,
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: R2PutOptions) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const metadata = options?.httpMetadata;
      values.set(key, {
        bytes: new Uint8Array(bytes),
        contentType:
          (metadata instanceof Headers ? metadata.get('content-type') : metadata?.contentType) ??
          'application/json',
      });
      return {};
    },
    async get(key: string) {
      const value = values.get(key);
      return value
        ? {
            arrayBuffer: async () => value.bytes.slice().buffer,
            text: async () => new TextDecoder().decode(value.bytes),
            httpMetadata: { contentType: value.contentType },
          }
        : null;
    },
    async head(key: string) {
      return values.has(key) ? { key } : null;
    },
    async list(input: { prefix: string; limit: number; cursor?: string }) {
      const keys = [...values.keys()].filter((key) => key.startsWith(input.prefix)).sort();
      const offset = input.cursor ? Number(input.cursor) : 0;
      const objects = keys.slice(offset, offset + input.limit).map((key) => ({ key }));
      const next = offset + objects.length;
      return {
        objects,
        truncated: next < keys.length,
        cursor: next < keys.length ? String(next) : undefined,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}

function context(): AdapterContext {
  return {
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
  } as AdapterContext;
}

describe('tenant backup public asset ports', () => {
  it('captures settings assets and user avatars in separate encrypted snapshots', async () => {
    const source = bucket(
      new Map([
        ['public/tenant-a/login-ui/logo/logo.png', { bytes: PNG, contentType: 'image/png' }],
        ['avatars/tenant-a/users/user.png', { bytes: PNG, contentType: 'image/png' }],
        ['avatars/tenant-b/users/foreign.png', { bytes: PNG, contentType: 'image/png' }],
      ])
    );
    const staging = bucket();
    const ports = createTenantBackupPublicAssetPorts({
      PUBLIC_ASSETS: source as unknown as R2Bucket,
      EXPORT_ARTIFACTS: staging as unknown as R2Bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: '44'.repeat(32),
    });
    const input = context();

    await ports.publicAssets.start(input, 'settings-snapshot', async () => {});
    await ports.userAvatars.start(input, 'users-snapshot', async () => {});
    const settings = await ports.publicAssets.readNext(
      input,
      'settings-snapshot',
      null,
      input.context.signal
    );
    const users = await ports.userAvatars.readNext(
      input,
      'users-snapshot',
      null,
      input.context.signal
    );

    await expect(
      decodePortablePublicAsset(new TextDecoder().decode(settings?.bytes).trim(), 'tenant-a')
    ).resolves.toMatchObject({ key: 'public/tenant-a/login-ui/logo/logo.png' });
    await expect(
      decodePortableUserAvatar(new TextDecoder().decode(users?.bytes).trim(), 'tenant-a')
    ).resolves.toMatchObject({ key: 'avatars/tenant-a/users/user.png' });
    await expect(
      ports.publicAssets.readNext(
        input,
        'settings-snapshot',
        settings?.nextCursor ?? null,
        input.context.signal
      )
    ).resolves.toBeNull();
  });

  it('imports idempotently, verifies bytes, and refuses to overwrite different target data', async () => {
    const target = bucket();
    const ports = createTenantBackupPublicAssetPorts({
      PUBLIC_ASSETS: target as unknown as R2Bucket,
      EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: '55'.repeat(32),
    });
    const asset: PortablePublicAsset = {
      tenantId: 'tenant-a',
      key: 'avatars/tenant-a/users/user.png',
      contentType: 'image/png',
      sha256: await crypto.subtle
        .digest('SHA-256', PNG)
        .then((value) =>
          [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        ),
      bytes: PNG,
    };

    await ports.importAsset({}, asset);
    await ports.importAsset({}, asset);
    await expect(ports.verifyAsset({}, asset)).resolves.toBe(true);

    target.values.set(asset.key, { bytes: new Uint8Array([...PNG, 2]), contentType: 'image/png' });
    await expect(ports.importAsset({}, asset)).rejects.toThrow('backup_public_assets_invalid');
    await expect(ports.verifyAsset({}, asset)).resolves.toBe(false);
  });
});

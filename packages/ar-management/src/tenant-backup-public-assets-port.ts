import type { Env } from '@authrim/ar-lib-core';
import {
  encodePortablePublicAsset,
  encodePortableUserAvatar,
  type PortablePublicAsset,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import { classifyPublicAssetKey } from '@authrim/ar-lib-core/services/tenant-portability/public-asset-contract';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { createEncryptedTenantBackupRecordSnapshotPort } from './tenant-backup-record-snapshot-port';

type AssetCategory = 'settings' | 'users';

function invalid(): never {
  throw new Error('backup_public_assets_invalid');
}

function sourcePrefix(tenantId: string, category: AssetCategory): string {
  return category === 'settings' ? `public/${tenantId}/login-ui/` : `avatars/${tenantId}/users/`;
}

async function listKeys(
  bucket: R2Bucket,
  tenantId: string,
  category: AssetCategory,
  signal: AbortSignal
): Promise<string[]> {
  const keys: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await bucket.list({
      prefix: sourcePrefix(tenantId, category),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      const classification = classifyPublicAssetKey(object.key, tenantId);
      if (
        classification.kind !== 'asset' ||
        classification.category !== category ||
        keys.includes(object.key)
      )
        invalid();
      keys.push(object.key);
      if (keys.length > 4096) invalid();
    }
    if (!page.truncated) cursor = undefined;
    else {
      if (!page.cursor || cursors.has(page.cursor)) invalid();
      cursors.add(page.cursor);
      cursor = page.cursor;
    }
  } while (cursor);
  return keys.sort();
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function loadAsset(bucket: R2Bucket, tenantId: string, key: string) {
  const object = await bucket.get(key);
  if (!object) invalid();
  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType;
  if (!contentType) invalid();
  return { tenantId, key, contentType, sha256: await sha256(bytes), bytes };
}

async function* capture(
  env: Pick<Env, 'PUBLIC_ASSETS'>,
  context: AdapterContext,
  category: AssetCategory
): AsyncIterable<Uint8Array> {
  const bucket = env.PUBLIC_ASSETS;
  if (!bucket) return;
  const tenantId = context.context.lease.tenantId;
  const keys = await listKeys(bucket, tenantId, category, context.context.signal);
  for (const key of keys) {
    context.context.signal.throwIfAborted();
    const asset = await loadAsset(bucket, tenantId, key);
    yield category === 'settings'
      ? await encodePortablePublicAsset(asset)
      : await encodePortableUserAvatar(asset);
  }
}

async function matches(bucket: R2Bucket, asset: PortablePublicAsset): Promise<boolean> {
  const existing = await bucket.get(asset.key);
  if (!existing || existing.httpMetadata?.contentType !== asset.contentType) return false;
  const bytes = new Uint8Array(await existing.arrayBuffer());
  return bytes.length === asset.bytes.length && (await sha256(bytes)) === asset.sha256;
}

/** Production R2 ports for login assets and user avatars, kept as separately selectable datasets. */
export function createTenantBackupPublicAssetPorts(
  env: Pick<
    Env,
    | 'PUBLIC_ASSETS'
    | 'EXPORT_ARTIFACTS'
    | 'OBJECT_ENCRYPTION_ROOT_KEY'
    | 'OBJECT_ENCRYPTION_KEY_VERSION'
  >
) {
  const snapshot = (category: AssetCategory) =>
    createEncryptedTenantBackupRecordSnapshotPort({
      env,
      resourceId: `public-assets:${category}`,
      assertSource: async () => {},
      capture: (context) => capture(env, context, category),
    });
  return {
    publicAssets: snapshot('settings'),
    userAvatars: snapshot('users'),
    async importAsset(_context: unknown, asset: PortablePublicAsset): Promise<void> {
      const bucket = env.PUBLIC_ASSETS ?? invalid();
      const classification = classifyPublicAssetKey(asset.key, asset.tenantId);
      if (classification.kind !== 'asset') invalid();
      const existing = await bucket.head(asset.key);
      if (existing) {
        if (!(await matches(bucket, asset))) invalid();
        return;
      }
      await bucket.put(asset.key, asset.bytes, {
        httpMetadata: { contentType: asset.contentType },
      });
      if (!(await matches(bucket, asset))) invalid();
    },
    async verifyAsset(_context: unknown, asset: PortablePublicAsset): Promise<boolean> {
      const bucket = env.PUBLIC_ASSETS;
      return bucket ? matches(bucket, asset) : false;
    },
  };
}

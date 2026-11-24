import type {
  MigrationReleasePin,
  ReleaseArtifactObject,
  ReleaseArtifactStore,
} from '../release-artifact.js';

export const encoder = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface StoredObject extends ReleaseArtifactObject {
  bytes: Uint8Array;
}

export function storedObject(bytes: Uint8Array, size: number = bytes.byteLength): StoredObject {
  return {
    bytes,
    size,
    arrayBuffer: () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return Promise.resolve(copy.buffer);
    },
  };
}

export class MemoryArtifactStore implements ReleaseArtifactStore {
  readonly objects = new Map<string, ReleaseArtifactObject>();
  readonly requested: string[] = [];

  async get(key: string): Promise<ReleaseArtifactObject | null> {
    this.requested.push(key);
    return this.objects.get(key) ?? null;
  }
}

export interface ManifestFileJson {
  path: string;
  checksum: string;
  supersedes?: unknown;
}

export async function fileEntry(path: string, sql: string): Promise<ManifestFileJson> {
  return { path, checksum: await sha256Hex(sql) };
}

export interface StreamJson {
  id: string;
  schemaFamily: string;
  dialect: string;
  targetKind: string;
  logicalRoles: string[];
  files: unknown[];
}

export function coreStream(files: unknown[], overrides: Partial<StreamJson> = {}): StreamJson {
  return {
    id: 'core-d1',
    schemaFamily: 'core',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['core', 'tenant_core'],
    files,
    ...overrides,
  };
}

export function pluginStream(id: string, files: unknown[] = []): StreamJson {
  return {
    id,
    schemaFamily: 'plugin_runner',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['plugin_runner'],
    files,
  };
}

export function manifestJson(
  streams: unknown,
  extra: Record<string, unknown> = {},
  productVersion = '1.2.3'
): Record<string, unknown> {
  return { formatVersion: 2, productVersion, streams, ...extra };
}

export interface BuiltRelease {
  store: MemoryArtifactStore;
  pin: MigrationReleasePin;
  digest: string;
  base: string;
}

/** Publishes `manifest` (object or raw bytes) and the given SQL objects into a fresh store. */
export async function publish(
  manifest: unknown,
  sqlObjects: Record<string, string | Uint8Array> = {},
  options: { releaseId?: string; pin?: Partial<MigrationReleasePin> } = {}
): Promise<BuiltRelease> {
  const bytes =
    manifest instanceof Uint8Array ? manifest : encoder.encode(JSON.stringify(manifest));
  const digest = await sha256Hex(bytes);
  const productVersion =
    manifest && typeof manifest === 'object' && 'productVersion' in manifest
      ? String(manifest.productVersion)
      : '1.2.3';
  const releaseId = options.releaseId ?? productVersion;
  const base = `releases/${releaseId}/${digest}/`;
  const store = new MemoryArtifactStore();
  store.objects.set(`${base}manifest.json`, storedObject(bytes));
  for (const [key, value] of Object.entries(sqlObjects)) {
    const sqlBytes = typeof value === 'string' ? encoder.encode(value) : value;
    store.objects.set(`${base}${key}`, storedObject(sqlBytes));
  }
  const pin: MigrationReleasePin = {
    environmentId: 'env-1',
    streamId: 'core-d1',
    releaseId,
    manifestDigest: digest,
    manifestObjectKey: `${base}manifest.json`,
    ...options.pin,
  };
  return { store, pin, digest, base };
}

import type {
  TenantDatabaseRegistryRepository,
  TenantRuntimeCacheNamespace,
} from '../repositories/admin/tenant-database-registry';

export const DEFAULT_TENANT_RUNTIME_CONFIG_SNAPSHOT_TTL_SECONDS = 5 * 60;
export const DEFAULT_TENANT_RUNTIME_CONFIG_GENERATION_TTL_SECONDS = 60;

export type TenantRuntimeConfigSnapshotNamespace = Extract<
  TenantRuntimeCacheNamespace,
  'settings' | 'policy'
>;

export interface TenantRuntimeConfigSnapshotStore {
  get?(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

export interface TenantRuntimeConfigSnapshot {
  version: 1;
  tenantId: string;
  namespace: TenantRuntimeConfigSnapshotNamespace;
  generation: number;
  publishedAt: string;
  expiresAt: string;
  payload: Record<string, unknown>;
  metadata: {
    payloadKeys: string[];
    source: 'control_db' | 'tenant_durable_store';
  };
}

export interface PublishTenantRuntimeConfigSnapshotOptions {
  tenantId: string;
  namespace: TenantRuntimeConfigSnapshotNamespace;
  generation: number;
  payload: Record<string, unknown>;
  source: 'control_db' | 'tenant_durable_store';
  snapshotStore?: TenantRuntimeConfigSnapshotStore | null;
  repository?: TenantDatabaseRegistryRepository | null;
  snapshotTtlSeconds?: number;
  generationTtlSeconds?: number;
  now?: Date;
  actorId?: string | null;
}

export interface PublishTenantRuntimeConfigSnapshotResult {
  snapshot: TenantRuntimeConfigSnapshot;
  snapshotKey: string;
  generationKey: string;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function buildTenantRuntimeConfigSnapshotKey(
  tenantId: string,
  namespace: TenantRuntimeConfigSnapshotNamespace
): string {
  return `tenant:${tenantId}:runtime-config:${namespace}:snapshot`;
}

export function buildTenantRuntimeConfigGenerationKey(
  tenantId: string,
  namespace: TenantRuntimeConfigSnapshotNamespace
): string {
  return `tenant:${tenantId}:runtime-config:${namespace}:generation`;
}

export async function publishTenantRuntimeConfigSnapshot(
  options: PublishTenantRuntimeConfigSnapshotOptions
): Promise<PublishTenantRuntimeConfigSnapshotResult> {
  const now = options.now ?? new Date();
  const publishedAt = now.toISOString();
  const snapshotTtlSeconds =
    options.snapshotTtlSeconds ?? DEFAULT_TENANT_RUNTIME_CONFIG_SNAPSHOT_TTL_SECONDS;
  const generationTtlSeconds =
    options.generationTtlSeconds ?? DEFAULT_TENANT_RUNTIME_CONFIG_GENERATION_TTL_SECONDS;
  const expiresAt = addSeconds(now, snapshotTtlSeconds).toISOString();
  const snapshotKey = buildTenantRuntimeConfigSnapshotKey(options.tenantId, options.namespace);
  const generationKey = buildTenantRuntimeConfigGenerationKey(options.tenantId, options.namespace);
  const snapshot: TenantRuntimeConfigSnapshot = {
    version: 1,
    tenantId: options.tenantId,
    namespace: options.namespace,
    generation: options.generation,
    publishedAt,
    expiresAt,
    payload: options.payload,
    metadata: {
      payloadKeys: Object.keys(options.payload).sort(),
      source: options.source,
    },
  };

  if (options.snapshotStore) {
    await options.snapshotStore.put(snapshotKey, JSON.stringify(snapshot), {
      expirationTtl: snapshotTtlSeconds,
    });
    await options.snapshotStore.put(
      generationKey,
      JSON.stringify({
        generation: options.generation,
        publishedAt,
        expiresAt,
      }),
      { expirationTtl: generationTtlSeconds }
    );
  }

  if (options.repository) {
    await options.repository.upsertRuntimeCacheGeneration({
      tenant_id: options.tenantId,
      cache_namespace: options.namespace,
      generation: options.generation,
      updated_by: options.actorId ?? null,
      metadata_json: JSON.stringify({
        snapshot_key: snapshotKey,
        generation_key: generationKey,
        source: options.source,
        payload_keys: snapshot.metadata.payloadKeys,
      }),
    });
  }

  return { snapshot, snapshotKey, generationKey };
}

export function parseTenantRuntimeConfigSnapshot(
  value: string | null,
  expected: {
    tenantId: string;
    namespace: TenantRuntimeConfigSnapshotNamespace;
    minimumGeneration?: number;
    now?: Date;
  }
): TenantRuntimeConfigSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as TenantRuntimeConfigSnapshot;
    if (
      parsed.version !== 1 ||
      parsed.tenantId !== expected.tenantId ||
      parsed.namespace !== expected.namespace ||
      typeof parsed.generation !== 'number' ||
      !parsed.payload ||
      typeof parsed.payload !== 'object' ||
      Array.isArray(parsed.payload)
    ) {
      return null;
    }
    if (
      expected.minimumGeneration !== undefined &&
      parsed.generation < expected.minimumGeneration
    ) {
      return null;
    }
    const expiresAt = new Date(parsed.expiresAt).getTime();
    const now = expected.now?.getTime() ?? Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

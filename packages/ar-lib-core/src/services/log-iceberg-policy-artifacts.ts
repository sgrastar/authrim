import {
  buildRuntimeLoggingPolicySnapshotObjectKey,
  createRuntimeLoggingPolicySnapshot,
  loadPublishedRuntimeLoggingPolicySnapshot,
  type RuntimePolicySnapshotObjectStore,
} from '@authrim/ar-lib-logging/policies';
import type { LogIcebergRuntimeEnv } from './log-iceberg-runtime';

export const LOG_ICEBERG_POLICY_PREFIX = '__authrim_log_archive_private__/policy-snapshots/v1';
export interface LogIcebergPolicyArtifactRequest {
  scopeType: 'tenant' | 'platform';
  scopeId: string;
  objectKey: string;
}

/** Read only the currently published, hash-verified policy artifact. This is
 * configuration state, never a JSON log/archive or an arbitrary R2 read API. */
export async function readLogIcebergPolicyArtifact(
  env: LogIcebergRuntimeEnv,
  input: LogIcebergPolicyArtifactRequest
): Promise<string | null> {
  input = { ...input };
  if (
    !['tenant', 'platform'].includes(input.scopeType) ||
    typeof input.scopeId !== 'string' ||
    !input.scopeId ||
    input.scopeId.length > 256 ||
    typeof input.objectKey !== 'string' ||
    input.objectKey.length > 1024
  )
    throw new Error('log_iceberg_policy_scope_invalid');
  if (!env.AUTHRIM_CONFIG || !env.LOG_ARCHIVE)
    throw new Error('log_iceberg_policy_store_unavailable');
  const kv = env.AUTHRIM_CONFIG,
    bucket = env.LOG_ARCHIVE;
  const snapshot = await loadPublishedRuntimeLoggingPolicySnapshot<unknown>({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    kv,
    objectStore: {
      put: async () => {
        throw new Error('log_iceberg_policy_store_read_only');
      },
      get: (key) => {
        if (key !== input.objectKey) throw new Error('log_iceberg_policy_artifact_changed');
        return bucket.get(key);
      },
    },
    prefix: LOG_ICEBERG_POLICY_PREFIX,
    strict: true,
  });
  if (!snapshot) return null;
  if (
    snapshot.scopeId !== input.scopeId ||
    snapshot.scopeType !== input.scopeType ||
    buildRuntimeLoggingPolicySnapshotObjectKey({ snapshot, prefix: LOG_ICEBERG_POLICY_PREFIX }) !==
      input.objectKey
  )
    throw new Error('log_iceberg_policy_artifact_changed');
  const verified = await createRuntimeLoggingPolicySnapshot({ ...snapshot });
  if (verified.policyHash !== snapshot.policyHash)
    throw new Error('log_iceberg_policy_artifact_digest_invalid');
  const text = JSON.stringify(snapshot);
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
    throw new Error('log_iceberg_policy_artifact_too_large');
  return text;
}

export function createLogIcebergPolicySnapshotObjectStore(
  env: LogIcebergRuntimeEnv
): RuntimePolicySnapshotObjectStore {
  return {
    put: async () => {
      throw new Error('log_iceberg_policy_store_read_only');
    },
    async get(objectKey) {
      if (!objectKey.startsWith(`${LOG_ICEBERG_POLICY_PREFIX}/snapshots/`))
        throw new Error('log_iceberg_policy_scope_invalid');
      const match = /^(tenant|platform)\/([^/]+)\/v[1-9][0-9]*-[A-Za-z0-9_-]+\.json$/.exec(
        objectKey.slice(`${LOG_ICEBERG_POLICY_PREFIX}/snapshots/`.length)
      );
      if (!match) throw new Error('log_iceberg_policy_scope_invalid');
      const scopeType = match[1] as 'tenant' | 'platform',
        scopeId = decodeURIComponent(match[2]);
      if (encodeURIComponent(scopeId) !== match[2])
        throw new Error('log_iceberg_policy_scope_invalid');
      const input = { scopeType, scopeId, objectKey };
      const text = env.LOG_ARCHIVE_WRITER
        ? await env.LOG_ARCHIVE_WRITER.readPolicyArtifact(input)
        : await readLogIcebergPolicyArtifact(env, input);
      return text === null
        ? null
        : { size: new TextEncoder().encode(text).byteLength, text: async () => text };
    },
  };
}

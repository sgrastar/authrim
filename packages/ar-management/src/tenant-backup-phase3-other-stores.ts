import type { Env } from '@authrim/ar-lib-core';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  restorePortableOauthClientSecret,
  verifyPortableOauthClientSecret,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-client-secret';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { SqliteRestoreTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-target';

type Purpose = 'restore' | 'verify';

interface Cursor {
  version: 1;
  datasetId: 'core.oauth_clients';
  purpose: Purpose;
  sourceCursor: string;
}

export interface Phase3OtherStoreSource {
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  target: SqliteRestoreTarget;
  readNextValidatedRow(input: {
    sourceCursor: string | null;
  }): Promise<{ rowJson: string; nextCursor: string } | null>;
}

export interface Phase3OtherStorePorts {
  load(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose
  ): Promise<Phase3OtherStoreSource>;
}

function invalid(): never {
  throw new Error('backup_phase3_other_store_invalid');
}

function parseCursor(value: string | null, purpose: Purpose): string | null {
  if (value === null) return null;
  try {
    const cursor = JSON.parse(value) as Record<string, unknown>;
    if (
      !cursor ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'datasetId,purpose,sourceCursor,version' ||
      cursor.version !== 1 ||
      cursor.datasetId !== 'core.oauth_clients' ||
      cursor.purpose !== purpose ||
      typeof cursor.sourceCursor !== 'string' ||
      !cursor.sourceCursor ||
      new TextEncoder().encode(cursor.sourceCursor).length > 3072
    )
      invalid();
    return cursor.sourceCursor;
  } catch {
    return invalid();
  }
}

function nextCursor(purpose: Purpose, sourceCursor: string): string {
  const cursor: Cursor = { version: 1, datasetId: 'core.oauth_clients', purpose, sourceCursor };
  const value = JSON.stringify(cursor);
  if (new TextEncoder().encode(value).length > 4096) invalid();
  return value;
}

function targetEncryption(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>
) {
  const rp = env.RP_TOKEN_ENCRYPTION_KEY;
  if (rp) return { key: rp, version: 1 };
  const rawVersion = env.PII_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/.test(rawVersion)) invalid();
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version)) invalid();
  return { key: env.PII_ENCRYPTION_KEY, version };
}

async function runPage(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>,
  ports: Phase3OtherStorePorts,
  context: TenantBackupStepContext,
  planDigest: string,
  cursor: string | null,
  purpose: Purpose
): Promise<{ cursor: string | null; done: boolean }> {
  context.signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(planDigest)) invalid();
  const sourceCursor = parseCursor(cursor, purpose);
  const source = await ports.load(context, planDigest, purpose);
  if (
    source.policy.dataset.id !== 'core.oauth_clients' ||
    !source.policy.verificationIgnoredColumns?.includes('logout_webhook_secret_encrypted')
  )
    invalid();
  const row = await source.readNextValidatedRow({ sourceCursor });
  context.signal.throwIfAborted();
  if (row === null) return { cursor: null, done: true };
  if (
    typeof row.rowJson !== 'string' ||
    !row.rowJson ||
    typeof row.nextCursor !== 'string' ||
    !row.nextCursor ||
    row.nextCursor === sourceCursor
  )
    invalid();
  const encryption = targetEncryption(env);
  const input = {
    target: source.target,
    policy: source.policy,
    manifest: source.manifest,
    rowJson: row.rowJson,
    targetEncryptionKey: encryption.key,
  };
  if (purpose === 'restore')
    await restorePortableOauthClientSecret({ ...input, targetKeyVersion: encryption.version });
  else await verifyPortableOauthClientSecret(input);
  context.signal.throwIfAborted();
  return { cursor: nextCursor(purpose, row.nextCursor), done: false };
}

/** Phase 3 non-SQL handlers plugged into the installed import adapter. */
export function createPhase3OtherStoreHandlers(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>,
  ports: Phase3OtherStorePorts
) {
  return {
    restoreOtherStores(
      context: TenantBackupStepContext,
      planDigest: string,
      cursor: string | null
    ) {
      return runPage(env, ports, context, planDigest, cursor, 'restore');
    },
    verifyOtherStores(context: TenantBackupStepContext, planDigest: string, cursor: string | null) {
      return runPage(env, ports, context, planDigest, cursor, 'verify');
    },
  };
}

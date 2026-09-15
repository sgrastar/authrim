import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { decodeKeyManagerTenantBackupRow } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset';
import {
  decodeDirectoryConnectorSecretBackupRow,
  decodeSamlLocalSigningBackupRow,
  DIRECTORY_CONNECTOR_SECRETS_DATASET,
  SAML_LOCAL_SIGNING_DATASET,
  type DirectoryConnectorSecretBackupRecord,
} from './tenant-backup-phase4-record-datasets';
import {
  restorePortableOauthClientSecret,
  verifyPortableOauthClientSecret,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-client-secret';
import {
  restorePortableUpstreamProviderSecrets,
  verifyPortableUpstreamProviderSecrets,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-upstream-provider-secrets';
import type { Phase3OtherStoreSource } from './tenant-backup-phase3-other-stores';

type Purpose = 'restore' | 'verify';
type DatasetId =
  | 'core.oauth_clients'
  | 'core.upstream_providers'
  | 'credentials.key_manager_tenant_state'
  | 'federation.saml_local_signing_state'
  | 'integrations.directory_connector_secrets';
type SqliteSecretDatasetId = Extract<DatasetId, 'core.oauth_clients' | 'core.upstream_providers'>;
type RecordDatasetId = Extract<
  DatasetId,
  'federation.saml_local_signing_state' | 'integrations.directory_connector_secrets'
>;
const DATASETS: readonly DatasetId[] = [
  'core.oauth_clients',
  'core.upstream_providers',
  'credentials.key_manager_tenant_state',
  'federation.saml_local_signing_state',
  'integrations.directory_connector_secrets',
];

interface Cursor {
  version: 1;
  datasetId: DatasetId;
  purpose: Purpose;
  sourceCursor: string | null;
}

export interface Phase4OtherStorePorts {
  load(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose,
    datasetId: SqliteSecretDatasetId
  ): Promise<Phase3OtherStoreSource>;
  loadKeyManager(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose
  ): Promise<Omit<Phase3OtherStoreSource, 'target'>>;
  importKeyManager(
    context: TenantBackupStepContext,
    snapshot: Awaited<ReturnType<typeof decodeKeyManagerTenantBackupRow>>
  ): Promise<void>;
  verifyKeyManager(
    context: TenantBackupStepContext,
    snapshot: Awaited<ReturnType<typeof decodeKeyManagerTenantBackupRow>>
  ): Promise<boolean>;
  loadRecord(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose,
    datasetId: RecordDatasetId
  ): Promise<Omit<Phase3OtherStoreSource, 'target'>>;
  validateSamlBundle(bundle: unknown, tenantId: string): Promise<void>;
  importSamlBundle(context: TenantBackupStepContext, bundle: unknown): Promise<void>;
  verifySamlBundle(context: TenantBackupStepContext, bundle: unknown): Promise<boolean>;
  importDirectorySecret(
    context: TenantBackupStepContext,
    connectorId: string,
    secret: DirectoryConnectorSecretBackupRecord
  ): Promise<void>;
  verifyDirectorySecret(
    context: TenantBackupStepContext,
    connectorId: string,
    secret: DirectoryConnectorSecretBackupRecord
  ): Promise<boolean>;
}

function invalid(): never {
  throw new Error('backup_phase4_other_store_invalid');
}

function isRecordDatasetId(value: DatasetId): value is RecordDatasetId {
  return (
    value === 'federation.saml_local_signing_state' ||
    value === 'integrations.directory_connector_secrets'
  );
}

function parseCursor(value: string | null, purpose: Purpose): Cursor {
  if (value === null) return { version: 1, datasetId: DATASETS[0], purpose, sourceCursor: null };
  try {
    const cursor = JSON.parse(value) as Record<string, unknown>;
    if (
      !cursor ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'datasetId,purpose,sourceCursor,version' ||
      cursor.version !== 1 ||
      !DATASETS.includes(cursor.datasetId as DatasetId) ||
      cursor.purpose !== purpose ||
      (cursor.sourceCursor !== null &&
        (typeof cursor.sourceCursor !== 'string' ||
          !cursor.sourceCursor ||
          new TextEncoder().encode(cursor.sourceCursor).length > 3072))
    )
      invalid();
    return cursor as unknown as Cursor;
  } catch {
    return invalid();
  }
}

function encodedCursor(cursor: Cursor): string {
  const value = JSON.stringify(cursor);
  if (new TextEncoder().encode(value).length > 4096) invalid();
  return value;
}

function oauthTargetEncryption(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>
) {
  if (env.RP_TOKEN_ENCRYPTION_KEY) return { key: env.RP_TOKEN_ENCRYPTION_KEY, version: 1 };
  const rawVersion = env.PII_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/.test(rawVersion)) invalid();
  return { key: env.PII_ENCRYPTION_KEY, version: Number(rawVersion) };
}

async function applyRow(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>,
  source: Phase3OtherStoreSource,
  rowJson: string,
  purpose: Purpose,
  datasetId: DatasetId
) {
  if (datasetId === 'credentials.key_manager_tenant_state') invalid();
  const common = {
    target: source.target,
    policy: source.policy,
    manifest: source.manifest,
    rowJson,
  };
  if (datasetId === 'core.oauth_clients') {
    const encryption = oauthTargetEncryption(env);
    if (purpose === 'restore')
      await restorePortableOauthClientSecret({
        ...common,
        targetEncryptionKey: encryption.key,
        targetKeyVersion: encryption.version,
      });
    else
      await verifyPortableOauthClientSecret({
        ...common,
        targetEncryptionKey: encryption.key,
      });
    return;
  }
  const upstreamCommon = {
    ...common,
    target: source.target as unknown as Parameters<
      typeof restorePortableUpstreamProviderSecrets
    >[0]['target'],
  };
  if (purpose === 'restore')
    await restorePortableUpstreamProviderSecrets({
      ...upstreamCommon,
      targetEncryptionKey: env.RP_TOKEN_ENCRYPTION_KEY,
    });
  else
    await verifyPortableUpstreamProviderSecrets({
      ...upstreamCommon,
      targetEncryptionKey: env.RP_TOKEN_ENCRYPTION_KEY,
    });
}

async function runPage(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>,
  ports: Phase4OtherStorePorts,
  context: TenantBackupStepContext,
  planDigest: string,
  cursorValue: string | null,
  purpose: Purpose
): Promise<{ cursor: string | null; done: boolean }> {
  context.signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(planDigest)) invalid();
  const cursor = parseCursor(cursorValue, purpose);
  if (cursor.datasetId === 'credentials.key_manager_tenant_state') {
    const source = await ports.loadKeyManager(context, planDigest, purpose);
    if (source.policy.dataset.id !== cursor.datasetId) invalid();
    const row = await source.readNextValidatedRow({ sourceCursor: cursor.sourceCursor });
    context.signal.throwIfAborted();
    if (row === null) {
      const nextIndex = DATASETS.indexOf(cursor.datasetId) + 1;
      return {
        cursor: encodedCursor({
          version: 1,
          datasetId: DATASETS[nextIndex],
          purpose,
          sourceCursor: null,
        }),
        done: false,
      };
    }
    if (
      typeof row.rowJson !== 'string' ||
      !row.rowJson ||
      typeof row.nextCursor !== 'string' ||
      !row.nextCursor ||
      row.nextCursor === cursor.sourceCursor
    )
      invalid();
    const snapshot = await decodeKeyManagerTenantBackupRow(row.rowJson, context.lease.tenantId);
    if (purpose === 'restore') await ports.importKeyManager(context, snapshot);
    else if (!(await ports.verifyKeyManager(context, snapshot))) invalid();
    context.signal.throwIfAborted();
    return { cursor: encodedCursor({ ...cursor, sourceCursor: row.nextCursor }), done: false };
  }
  if (isRecordDatasetId(cursor.datasetId)) {
    const source = await ports.loadRecord(context, planDigest, purpose, cursor.datasetId);
    if (source.policy.dataset.id !== cursor.datasetId) invalid();
    const row = await source.readNextValidatedRow({ sourceCursor: cursor.sourceCursor });
    context.signal.throwIfAborted();
    if (row === null) {
      const nextIndex = DATASETS.indexOf(cursor.datasetId) + 1;
      return nextIndex >= DATASETS.length
        ? { cursor: null, done: true }
        : {
            cursor: encodedCursor({
              version: 1,
              datasetId: DATASETS[nextIndex],
              purpose,
              sourceCursor: null,
            }),
            done: false,
          };
    }
    if (
      typeof row.rowJson !== 'string' ||
      !row.rowJson ||
      typeof row.nextCursor !== 'string' ||
      !row.nextCursor ||
      row.nextCursor === cursor.sourceCursor
    )
      invalid();
    if (cursor.datasetId === SAML_LOCAL_SIGNING_DATASET.id) {
      const bundle = await decodeSamlLocalSigningBackupRow(
        row.rowJson,
        context.lease.tenantId,
        ports.validateSamlBundle
      );
      if (purpose === 'restore') await ports.importSamlBundle(context, bundle);
      else if (!(await ports.verifySamlBundle(context, bundle))) invalid();
    } else {
      const { connectorId, secret } = decodeDirectoryConnectorSecretBackupRow(
        row.rowJson,
        context.lease.tenantId
      );
      if (purpose === 'restore') await ports.importDirectorySecret(context, connectorId, secret);
      else if (!(await ports.verifyDirectorySecret(context, connectorId, secret))) invalid();
    }
    context.signal.throwIfAborted();
    return { cursor: encodedCursor({ ...cursor, sourceCursor: row.nextCursor }), done: false };
  }
  const source = await ports.load(context, planDigest, purpose, cursor.datasetId);
  const ignored = source.policy.verificationIgnoredColumns ?? [];
  if (
    source.policy.dataset.id !== cursor.datasetId ||
    (cursor.datasetId === 'core.oauth_clients' &&
      !ignored.includes('logout_webhook_secret_encrypted')) ||
    (cursor.datasetId === 'core.upstream_providers' &&
      (!ignored.includes('client_secret_encrypted') ||
        !ignored.includes('private_key_jwk_encrypted')))
  )
    invalid();
  const row = await source.readNextValidatedRow({ sourceCursor: cursor.sourceCursor });
  context.signal.throwIfAborted();
  if (row === null) {
    const nextIndex = DATASETS.indexOf(cursor.datasetId) + 1;
    return nextIndex >= DATASETS.length
      ? { cursor: null, done: true }
      : {
          cursor: encodedCursor({
            version: 1,
            datasetId: DATASETS[nextIndex],
            purpose,
            sourceCursor: null,
          }),
          done: false,
        };
  }
  if (
    typeof row.rowJson !== 'string' ||
    !row.rowJson ||
    typeof row.nextCursor !== 'string' ||
    !row.nextCursor ||
    row.nextCursor === cursor.sourceCursor
  )
    invalid();
  await applyRow(env, source, row.rowJson, purpose, cursor.datasetId);
  context.signal.throwIfAborted();
  return {
    cursor: encodedCursor({ ...cursor, sourceCursor: row.nextCursor }),
    done: false,
  };
}

/** Cumulative Phase 3+4 non-SQL secret handlers. */
export function createPhase4OtherStoreHandlers(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>,
  ports: Phase4OtherStorePorts
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

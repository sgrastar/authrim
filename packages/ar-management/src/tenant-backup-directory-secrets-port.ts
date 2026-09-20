import type { Env } from '@authrim/ar-lib-core';
import { directoryConnectorSecretKeyOwnership } from '@authrim/ar-lib-core/services/tenant-portability/settings-key-ownership';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import {
  encodeDirectoryConnectorSecretBackupRow,
  normalizeDirectoryConnectorSecretBackupRecord,
  type DirectoryConnectorSecretBackupRecord,
} from './tenant-backup-phase4-record-datasets';
import { createEncryptedTenantBackupRecordSnapshotPort } from './tenant-backup-record-snapshot-port';

const CONNECTOR_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function invalid(): never {
  throw new Error('backup_directory_secrets_invalid');
}

function configKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:directory-connectors`;
}

function secretKey(tenantId: string, connectorId: string): string {
  return `settings:tenant:${tenantId}:directory-connector-secret:${connectorId}`;
}

async function referencedManagedConnectorIds(
  settings: KVNamespace | undefined,
  tenantId: string
): Promise<string[]> {
  if (!settings) return [];
  const raw = await settings.get(configKey(tenantId));
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const connectors = (value as Record<string, unknown>).connectors;
  if (!Array.isArray(connectors) || connectors.length > 20) invalid();
  const ids: string[] = [];
  for (const connector of connectors) {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector)) invalid();
    const record = connector as Record<string, unknown>;
    if (typeof record.id !== 'string' || !CONNECTOR_ID.test(record.id)) invalid();
    if (record.secret_ref === `managed:${record.id}`) ids.push(record.id);
    else if (typeof record.secret_ref !== 'string' || record.secret_ref.startsWith('managed:'))
      invalid();
  }
  if (new Set(ids).size !== ids.length) invalid();
  return ids.sort();
}

async function* capture(
  env: Pick<Env, 'SETTINGS'>,
  context: AdapterContext
): AsyncIterable<Uint8Array> {
  const tenantId = context.context.lease.tenantId;
  const connectorIds = await referencedManagedConnectorIds(env.SETTINGS, tenantId);
  if (connectorIds.length && !env.SETTINGS) invalid();
  for (const connectorId of connectorIds) {
    context.context.signal.throwIfAborted();
    const key = secretKey(tenantId, connectorId);
    const ownership = directoryConnectorSecretKeyOwnership(key, {
      tenantId,
      connectorIds: new Set(connectorIds),
    });
    if (ownership.kind !== 'tenant_secret') invalid();
    const raw = await env.SETTINGS!.get(key);
    if (raw === null) invalid();
    let secret: unknown;
    try {
      secret = JSON.parse(raw) as unknown;
    } catch {
      return invalid();
    }
    yield encodeDirectoryConnectorSecretBackupRow(
      tenantId,
      connectorId,
      normalizeDirectoryConnectorSecretBackupRecord(secret)
    );
  }
}

/** Production Settings KV port for the exact managed secrets referenced by connector settings. */
export function createTenantBackupDirectorySecretPorts(
  env: Pick<
    Env,
    'SETTINGS' | 'EXPORT_ARTIFACTS' | 'OBJECT_ENCRYPTION_ROOT_KEY' | 'OBJECT_ENCRYPTION_KEY_VERSION'
  >
) {
  const normalized = (secret: DirectoryConnectorSecretBackupRecord) =>
    JSON.stringify(normalizeDirectoryConnectorSecretBackupRecord(secret));
  const assertReferenced = async (tenantId: string, connectorId: string) => {
    if (!CONNECTOR_ID.test(connectorId)) invalid();
    const connectorIds = await referencedManagedConnectorIds(env.SETTINGS, tenantId);
    if (!connectorIds.includes(connectorId)) invalid();
  };
  return {
    directorySecrets: createEncryptedTenantBackupRecordSnapshotPort({
      env,
      resourceId: 'directory-secrets:settings',
      assertSource: async () => {},
      capture: (context) => capture(env, context),
    }),
    async importDirectorySecret(
      context: { lease: { tenantId: string } },
      connectorId: string,
      secret: DirectoryConnectorSecretBackupRecord
    ): Promise<void> {
      const settings = env.SETTINGS ?? invalid();
      const tenantId = context.lease.tenantId;
      await assertReferenced(tenantId, connectorId);
      const key = secretKey(tenantId, connectorId);
      const next = normalized(secret);
      const existing = await settings.get(key);
      if (existing !== null && existing !== next) invalid();
      if (existing === null) await settings.put(key, next);
    },
    async verifyDirectorySecret(
      context: { lease: { tenantId: string } },
      connectorId: string,
      secret: DirectoryConnectorSecretBackupRecord
    ): Promise<boolean> {
      const settings = env.SETTINGS;
      if (!settings) return false;
      const tenantId = context.lease.tenantId;
      await assertReferenced(tenantId, connectorId);
      return (await settings.get(secretKey(tenantId, connectorId))) === normalized(secret);
    },
  };
}

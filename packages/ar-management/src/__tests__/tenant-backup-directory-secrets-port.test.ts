import { describe, expect, it } from 'vitest';
import { decodeDirectoryConnectorSecretBackupRow } from '../tenant-backup-phase4-record-datasets';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { createTenantBackupDirectorySecretPorts } from '../tenant-backup-directory-secrets-port';

function kv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => void values.set(key, value),
  };
}

function bucket() {
  const values = new Map<string, string>();
  return {
    async put(key: string, value: string) {
      values.set(key, value);
      return {};
    },
    async get(key: string) {
      const value = values.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async list(input: { prefix: string }) {
      return {
        objects: [...values.keys()]
          .filter((key) => key.startsWith(input.prefix))
          .map((key) => ({ key })),
        truncated: false,
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

const secret = {
  active: { keyId: 'kid-active', secret: 'secret-active', createdAt: '2026-09-15T00:00:00Z' },
  previous: {
    keyId: 'kid-old',
    secret: 'secret-old',
    createdAt: '2026-09-14T00:00:00Z',
    retireAfter: '2026-09-16T00:00:00Z',
  },
};

describe('tenant backup directory secret ports', () => {
  it('captures only exact managed secret references without listing KV', async () => {
    const settings = kv({
      'settings:tenant:tenant-a:directory-connectors': JSON.stringify({
        connectors: [
          { id: 'managed', secret_ref: 'managed:managed' },
          { id: 'environment', secret_ref: 'env:WORDWARDEN_KEY' },
        ],
      }),
      'settings:tenant:tenant-a:directory-connector-secret:managed': JSON.stringify(secret),
      'settings:tenant:tenant-a:directory-connector-secret:orphan': JSON.stringify(secret),
    });
    const ports = createTenantBackupDirectorySecretPorts({
      SETTINGS: settings as unknown as KVNamespace,
      EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: '66'.repeat(32),
    });
    const input = context();

    await ports.directorySecrets.start(input, 'snapshot', async () => {});
    const row = await ports.directorySecrets.readNext(
      input,
      'snapshot',
      null,
      input.context.signal
    );

    expect(
      decodeDirectoryConnectorSecretBackupRow(
        new TextDecoder().decode(row?.bytes).trim(),
        'tenant-a'
      )
    ).toEqual({ connectorId: 'managed', secret });
    await expect(
      ports.directorySecrets.readNext(
        input,
        'snapshot',
        row?.nextCursor ?? null,
        input.context.signal
      )
    ).resolves.toBeNull();
  });

  it('restores only a referenced target connector and refuses conflicting data', async () => {
    const settings = kv({
      'settings:tenant:tenant-a:directory-connectors': JSON.stringify({
        connectors: [{ id: 'managed', secret_ref: 'managed:managed' }],
      }),
    });
    const ports = createTenantBackupDirectorySecretPorts({
      SETTINGS: settings as unknown as KVNamespace,
      EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: '77'.repeat(32),
    });
    const input = context().context;

    await ports.importDirectorySecret(input, 'managed', secret);
    await ports.importDirectorySecret(input, 'managed', secret);
    await expect(ports.verifyDirectorySecret(input, 'managed', secret)).resolves.toBe(true);

    settings.values.set(
      'settings:tenant:tenant-a:directory-connector-secret:managed',
      JSON.stringify({ ...secret, previous: undefined })
    );
    await expect(ports.importDirectorySecret(input, 'managed', secret)).rejects.toThrow(
      'backup_directory_secrets_invalid'
    );
    await expect(ports.importDirectorySecret(input, 'orphan', secret)).rejects.toThrow(
      'backup_directory_secrets_invalid'
    );
  });
});

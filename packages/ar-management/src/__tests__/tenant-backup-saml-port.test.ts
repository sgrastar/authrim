import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';

const saml = vi.hoisted(() => ({
  build: vi.fn(),
  restore: vi.fn(),
  validate: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('@authrim/ar-saml/src/admin/local-signing-dr-bundle', () => ({
  buildSAMLLocalSigningSecretDRBundle: saml.build,
  restoreSAMLLocalSigningSecretDRBundle: saml.restore,
  validateSAMLLocalSigningSecretDRBundle: saml.validate,
  verifySAMLLocalSigningSecretDRBundle: saml.verify,
}));

import { createTenantBackupSamlPorts } from '../tenant-backup-saml-port';
import { decodeSamlLocalSigningBackupRow } from '../tenant-backup-phase4-record-datasets';

function bucket() {
  const values = new Map<string, string>();
  return {
    values,
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

describe('tenant backup SAML port', () => {
  beforeEach(() => {
    saml.build.mockReset().mockResolvedValue({
      kind: 'authrim.saml_local_signing_secret_dr_bundle.v1',
      version: 1,
      tenantId: 'tenant-a',
      private: 'key-material',
    });
    saml.restore.mockReset().mockResolvedValue({ importedKeys: 1, restoredRoles: ['idp'] });
    saml.validate.mockReset();
    saml.verify.mockReset().mockResolvedValue(true);
  });

  it('captures the raw DR bundle only inside the encrypted backup staging area', async () => {
    const storage = bucket();
    const env = {
      EXPORT_ARTIFACTS: storage as unknown as R2Bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: '88'.repeat(32),
    } as never;
    const ports = createTenantBackupSamlPorts(env);
    const input = context();

    await ports.saml.start(input, 'snapshot', async () => {});
    const row = await ports.saml.readNext(input, 'snapshot', null, input.context.signal);
    const decoded = await decodeSamlLocalSigningBackupRow(
      new TextDecoder().decode(row?.bytes).trim(),
      'tenant-a',
      ports.validateSamlBundle
    );

    expect(decoded).toMatchObject({ tenantId: 'tenant-a', private: 'key-material' });
    expect(JSON.stringify([...storage.values.values()])).not.toContain('key-material');
    expect(saml.validate).toHaveBeenCalledOnce();
  });

  it('delegates restore and semantic verification to the existing SAML DR implementation', async () => {
    const ports = createTenantBackupSamlPorts({
      EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: '99'.repeat(32),
    } as never);
    const input = context().context;
    const bundle = { tenantId: 'tenant-a' };

    await ports.importSamlBundle(input, bundle);
    await expect(ports.verifySamlBundle(input, bundle)).resolves.toBe(true);

    expect(saml.restore).toHaveBeenCalledWith(expect.anything(), 'tenant-a', bundle);
    expect(saml.verify).toHaveBeenCalledWith(expect.anything(), 'tenant-a', bundle);
  });
});

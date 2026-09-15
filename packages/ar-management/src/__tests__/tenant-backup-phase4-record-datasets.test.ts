import { expect, it, vi } from 'vitest';
import {
  createPhase4RecordDatasetPolicies,
  decodeDirectoryConnectorSecretBackupRow,
  decodeSamlLocalSigningBackupRow,
  encodeDirectoryConnectorSecretBackupRow,
  encodeSamlLocalSigningBackupRow,
} from '../tenant-backup-phase4-record-datasets';

it('round-trips a tenant-bound SAML private signing bundle through a validator port', async () => {
  const bundle = { kind: 'authrim.saml_local_signing_secret_dr_bundle.v1', tenantId: 'tenant-a' };
  const row = new TextDecoder()
    .decode(encodeSamlLocalSigningBackupRow('tenant-a', bundle))
    .trimEnd();
  const validate = vi.fn(async (value, tenantId) => {
    expect(value).toEqual(bundle);
    expect(tenantId).toBe('tenant-a');
  });
  await expect(decodeSamlLocalSigningBackupRow(row, 'tenant-a', validate)).resolves.toEqual(bundle);
  await expect(decodeSamlLocalSigningBackupRow(row, 'tenant-b', validate)).rejects.toThrow(
    'backup_phase4_record_dataset_invalid'
  );
});

it('preserves active and retiring Directory connector secrets without exposing extra fields', () => {
  const record = {
    active: { keyId: 'kid-new', secret: 'wwsec_new', createdAt: '2026-09-15T00:00:00.000Z' },
    previous: {
      keyId: 'kid-old',
      secret: 'wwsec_old',
      createdAt: '2026-09-01T00:00:00.000Z',
      retireAfter: '2026-10-01T00:00:00.000Z',
    },
  };
  const row = new TextDecoder()
    .decode(encodeDirectoryConnectorSecretBackupRow('tenant-a', 'campus', record))
    .trimEnd();
  expect(decodeDirectoryConnectorSecretBackupRow(row, 'tenant-a')).toEqual({
    connectorId: 'campus',
    secret: record,
  });
  expect(() =>
    encodeDirectoryConnectorSecretBackupRow('tenant-a', 'campus', {
      ...record,
      active: { ...record.active, extra: 'hidden' } as never,
    })
  ).toThrow('backup_phase4_record_dataset_invalid');
});

it('installs both non-SQL policies and validates bundle contents before target writes', async () => {
  const validateSamlBundle = vi.fn(async () => {});
  const policies = createPhase4RecordDatasetPolicies({ validateSamlBundle });
  expect(policies.map(({ dataset }) => [dataset.id, dataset.store])).toEqual([
    ['federation.saml_local_signing_state', 'durable_object'],
    ['integrations.directory_connector_secrets', 'kv'],
  ]);
  const samlRow = JSON.parse(
    new TextDecoder()
      .decode(encodeSamlLocalSigningBackupRow('tenant-a', { tenantId: 'tenant-a' }))
      .trimEnd()
  );
  await policies[0].inspectRow(samlRow, {} as never);
  expect(validateSamlBundle).toHaveBeenCalledOnce();
});

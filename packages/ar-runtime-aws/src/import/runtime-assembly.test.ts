import { describe, expect, it } from 'vitest';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import { assertCompleteDatasetCoverage, assertSourceSAMLSigningPolicy } from './runtime-assembly';
import type { SAMLLocalSigningSecretDRBundle } from '../../../ar-saml/src/admin/local-signing-dr-bundle';

function backup(datasets: Array<TenantPortableDataset & { rows: number }>): VerifiedTenantBackupV2 {
  return {
    manifest: { datasets: datasets.map(({ rows: _rows, ...dataset }) => dataset) },
    dataset: (id: string) => ({ rows: datasets.find((dataset) => dataset.id === id)?.rows ?? 0 }),
  } as unknown as VerifiedTenantBackupV2;
}

describe('AWS SAML backup assembly coverage', () => {
  it('rejects a nonempty unknown non-SQL or Admin dataset', () => {
    const unknownKv: TenantPortableDataset & { rows: number } = {
      id: 'integrations.directory_connector_secrets',
      module: 'integrations',
      kind: 'settings',
      store: 'kv',
      schemaVersion: 1,
      disposition: 'include',
      rows: 1,
    };
    expect(() => assertCompleteDatasetCoverage({ backup: backup([unknownKv]) })).toThrow(
      'aws_runtime_assembly_invalid'
    );
    expect(() =>
      assertCompleteDatasetCoverage({
        backup: backup([{ ...unknownKv, id: 'admin.admin_policies', store: 'database' }]),
      })
    ).toThrow('aws_runtime_assembly_invalid');
    expect(() =>
      assertCompleteDatasetCoverage({
        backup: backup([{ ...unknownKv, id: 'control.unhandled', store: 'database' }]),
      })
    ).toThrow('aws_runtime_assembly_invalid');
    expect(() =>
      assertCompleteDatasetCoverage({
        backup: backup([{ ...unknownKv, disposition: 'rebuild' }]),
      })
    ).toThrow('aws_runtime_assembly_invalid');
  });

  it('accepts explicitly consumed datasets and empty unsupported inventory', () => {
    const datasets: Array<TenantPortableDataset & { rows: number }> = [
      {
        id: 'federation.saml_local_signing_state',
        module: 'federation',
        kind: 'settings',
        store: 'durable_object',
        schemaVersion: 1,
        disposition: 'include',
        rows: 1,
      },
      {
        id: 'admin.field_mapping_activations',
        module: 'mapping',
        kind: 'settings',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
        rows: 1,
      },
      {
        id: 'integrations.directory_connector_secrets',
        module: 'integrations',
        kind: 'settings',
        store: 'kv',
        schemaVersion: 1,
        disposition: 'include',
        rows: 0,
      },
    ];
    expect(() => assertCompleteDatasetCoverage({ backup: backup(datasets) })).not.toThrow();
  });
});

describe('source SAML signing and login topology', () => {
  const issuer = 'https://tenant-a.example.test';
  const source = {
    settings: { entityIdStyle: 'metadata_url', interactiveLoginUrlPolicy: 'tenant_host' },
    generated: {
      issuerUrl: issuer,
      idpEntityId: `${issuer}/saml/idp/metadata`,
    },
  } as Pick<SAMLLocalSigningSecretDRBundle, 'settings' | 'generated'>;

  it('accepts the original issuer and same-origin login policy', () => {
    expect(() => assertSourceSAMLSigningPolicy(source, issuer)).not.toThrow();
  });

  it('rejects a separate UI host or changed entity ID', () => {
    expect(() =>
      assertSourceSAMLSigningPolicy(
        {
          ...source,
          settings: { ...source.settings, interactiveLoginUrlPolicy: 'ui_base_url' },
        },
        issuer
      )
    ).toThrow('aws_runtime_assembly_invalid');
    expect(() =>
      assertSourceSAMLSigningPolicy(
        {
          ...source,
          generated: { ...source.generated, idpEntityId: `${issuer}/other` },
        },
        issuer
      )
    ).toThrow('aws_runtime_assembly_invalid');
  });
});

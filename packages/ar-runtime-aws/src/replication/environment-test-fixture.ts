/** Synthetic local test configuration; no credentials or deployed resource identifiers. */
import type { ReplicationConfiguration } from './plan';
import type { EnvironmentReplicationConfiguration } from './environment-plan';

export function environmentTestConfiguration(
  schemaPath: string,
  sha256: string
): EnvironmentReplicationConfiguration {
  const authority = {
    endpoint: 'https://authority.example.test/replication/v1/rpc',
    credentialId: 'controller-a',
    secretEnv: 'AUTHORITY_SECRET',
    databaseUrlEnv: 'AUTHORITY_DATABASE',
    bootstrap: {
      databaseUrlEnv: 'BOOTSTRAP_DATABASE',
      serviceRole: 'replication_service',
      journalRole: 'replication_journal',
    },
  };
  const pair = {
    pairId: 'pair-a',
    environmentId: 'env-a',
    deployments: [
      { deploymentId: 'cf-a', provider: 'cloudflare' },
      { deploymentId: 'aws-a', provider: 'aws' },
    ] as ReplicationConfiguration['pair']['deployments'],
    initialOwnerDeploymentId: 'cf-a',
    initialGenerationId: 'initial-generation',
  };
  const tenants = ['tenant-a', 'tenant-b'].map(
    (tenantId): ReplicationConfiguration => ({
      formatVersion: 1,
      pair: {
        pairId: pair.pairId,
        tenantId,
        deployments: structuredClone(pair.deployments),
        initialOwnerDeploymentId: pair.initialOwnerDeploymentId,
        initialGenerationId: pair.initialGenerationId,
      },
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      maxSnapshotAgeMs: 3600000,
      authority: structuredClone(authority),
      source: {
        kind: 'cloudflare',
        managementOrigin: 'https://management.example.test',
        grantId: `grant-${tenantId}`,
        credentialEnv: `EXPORT_${tenantId.toUpperCase().replaceAll('-', '_')}`,
        passphraseEnv: 'BACKUP_PASSPHRASE',
        identity: { tenantId, issuer: `https://${tenantId}.example.test`, productVersion: '0.4.2' },
      },
      destination: {
        kind: 'aws',
        sql: 'postgresql',
        environmentName: 'aws-env-a',
        masterUrlEnv: 'TARGET_MASTER',
        credentialSeedEnv: 'GENERATION_SEED',
        databasePrefix: 'replica',
        coreBindingRefs: ['core-a'],
        piiBindingRefs: ['pii-a'],
        spEntityIds: ['https://sp.example.test/entity'],
        allocationScope: 'tenant_exclusive',
        flowHmacSecretEnv: 'FLOW_SECRET',
        lookupReadKeys: [{ generation: 1, secretEnv: 'LOOKUP_SECRET' }],
        ui: {
          components: { loginUi: false, adminUi: false },
          ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
        },
        authState: { backend: 'postgresql' },
        writerCredentialId: 'aws-writer',
        writerSecretEnv: 'AWS_WRITER_SECRET',
        artifacts: {
          region: 'ap-northeast-1',
          bucket: 'replication-example',
          bucketOwner: '123456789012',
          keyPrefix: 'generations',
          kmsKeyArn:
            'arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
          secretNamePrefix: 'authrim-replication',
        },
        schemas: {
          core: [{ path: schemaPath, sha256 }],
          pii: [{ path: schemaPath, sha256 }],
          state: [{ path: schemaPath, sha256 }],
        },
      },
    })
  );
  return structuredClone({
    formatVersion: 2,
    pair,
    sourceDeploymentId: 'cf-a',
    destinationDeploymentId: 'aws-a',
    expectedEpoch: 1,
    maxSnapshotAgeMs: 3600000,
    authority,
    inventory: {
      managementOrigin: 'https://management.example.test',
      grantId: 'inventory-a',
      credentialEnv: 'INVENTORY_TOKEN',
      ownerTenantId: 'tenant-a',
    },
    tenants,
  });
}

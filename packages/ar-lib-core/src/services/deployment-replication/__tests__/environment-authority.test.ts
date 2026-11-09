import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_REPLICATION_MAX_TENANTS,
  assertEnvironmentDrainRequest,
  assertEnvironmentGenerationProof,
  assertEnvironmentGenerationRecord,
  assertEnvironmentInventory,
  assertEnvironmentOperationIdentity,
  assertEnvironmentPairDefinition,
  assertEnvironmentWritePermit,
  environmentGenerationDigest,
  verifyEnvironmentGenerationDigest,
  type EnvironmentGenerationRecord,
  type EnvironmentInventory,
} from '../environment-authority';

const hash = (byte: string) => byte.repeat(64);
const pair = {
  pairId: 'pair-1',
  environmentId: 'environment-1',
  deployments: [
    { deploymentId: 'cloudflare-1', provider: 'cloudflare' },
    { deploymentId: 'aws-1', provider: 'aws' },
  ],
  initialOwnerDeploymentId: 'cloudflare-1',
  initialGenerationId: 'generation-1',
};
const operation = {
  pairId: pair.pairId,
  environmentId: pair.environmentId,
  operationId: 'operation-1',
};
const drain = {
  ...operation,
  kind: 'planned',
  sourceDeploymentId: 'cloudflare-1',
  destinationDeploymentId: 'aws-1',
  expectedEpoch: 1,
  expectedRevision: 2,
};
const inventory: EnvironmentInventory = {
  formatVersion: 1,
  environmentId: pair.environmentId,
  sourceDeploymentId: 'cloudflare-1',
  sourceEpoch: 1,
  sourceFenceRevision: 2,
  capturedAtMs: 1000,
  sourceReceiptSha256: hash('a'),
  complete: true,
  tenants: [
    { tenantId: 'alpha', issuer: 'https://alpha.example.test', lifecycle: 'active' },
    { tenantId: 'beta', issuer: 'https://beta.example.test', lifecycle: 'active' },
  ],
};
const record: EnvironmentGenerationRecord = {
  formatVersion: 1,
  pairId: pair.pairId,
  environmentId: pair.environmentId,
  sourceDeploymentId: 'cloudflare-1',
  deploymentId: 'aws-1',
  generationId: 'generation-2',
  epoch: 2,
  sourceEpoch: 1,
  sourceFenceRevision: 2,
  sourceOperationId: 'operation-1',
  sourcePlanSha256: hash('b'),
  inventory,
  children: inventory.tenants.map((tenant, index) => ({
    tenantId: tenant.tenantId,
    restoreId: `restore-${index}`,
    sourceEpoch: 1,
    sourceFenceRevision: 2,
    capturedAtMs: 1000,
    verificationSha256: hash('c'),
    location: {
      region: 'ap-northeast-1',
      issuerOrigin: tenant.issuer,
      secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:replica',
      secretVersionId: 'version-1',
      bucket: 'replica-bucket',
      bucketOwner: '123456789012',
      manifestKey: `generations/${index}/manifest.json`,
      manifestVersionId: 'immutable-version',
      manifestSha256: hash('d'),
    },
  })),
  digestSha256: hash('e'),
};

function invalid(value: unknown, validate: (input: unknown) => void) {
  expect(() => validate(value)).toThrow('deployment_authority_environment_invalid');
}

describe('environment authority identity validation', () => {
  it('accepts an exact pair with two distinct deployment providers', () => {
    expect(() => assertEnvironmentPairDefinition(pair)).not.toThrow();
  });

  it.each([
    { ...pair, deployments: [pair.deployments[0]] },
    { ...pair, deployments: [pair.deployments[0], pair.deployments[0]] },
    { ...pair, initialOwnerDeploymentId: 'unknown' },
    {
      ...pair,
      deployments: [{ deploymentId: 'cloudflare-1', provider: 'unknown' }, pair.deployments[1]],
    },
    { ...pair, extra: 'forged' },
  ])('rejects ambiguous or extended pair membership: %#', (value) => {
    invalid(value, assertEnvironmentPairDefinition);
  });

  it('requires an exact operation identity and well-formed IDs', () => {
    expect(() => assertEnvironmentOperationIdentity(operation)).not.toThrow();
    invalid({ ...operation, operationId: '../other' }, assertEnvironmentOperationIdentity);
    invalid({ ...operation, tenantId: 'alpha' }, assertEnvironmentOperationIdentity);
  });

  it.each([
    { ...drain, sourceDeploymentId: 'aws-1', destinationDeploymentId: 'aws-1' },
    { ...drain, expectedEpoch: 0 },
    { ...drain, expectedRevision: -1 },
    { ...drain, kind: 'emergency' },
    { ...drain, tenantId: 'alpha' },
  ])('rejects a drain that cannot safely fence one source and destination: %#', (value) => {
    invalid(value, assertEnvironmentDrainRequest);
  });

  it('accepts both planned and failover drain requests', () => {
    expect(() => assertEnvironmentDrainRequest(drain)).not.toThrow();
    expect(() => assertEnvironmentDrainRequest({ ...drain, kind: 'failover' })).not.toThrow();
  });

  it('accepts aggregate and child permits but rejects partial child identities', () => {
    const permit = {
      pairId: pair.pairId,
      environmentId: pair.environmentId,
      deploymentId: 'cloudflare-1',
      epoch: 1,
      generationId: 'generation-1',
      permitId: 'permit-1',
      operationDigest: hash('a'),
    };
    expect(() => assertEnvironmentWritePermit(permit)).not.toThrow();
    expect(() =>
      assertEnvironmentWritePermit({ ...permit, tenantId: 'alpha', restoreId: 'restore-1' })
    ).not.toThrow();
    invalid({ ...permit, tenantId: 'alpha' }, assertEnvironmentWritePermit);
    invalid({ ...permit, operationDigest: hash('A') }, assertEnvironmentWritePermit);
    invalid({ ...permit, epoch: 0 }, assertEnvironmentWritePermit);
  });
});

describe('environment inventory validation', () => {
  it('accepts a complete, sorted active inventory at its maximum size', () => {
    const tenants = Array.from({ length: ENVIRONMENT_REPLICATION_MAX_TENANTS }, (_, index) => ({
      tenantId: `tenant-${String(index).padStart(2, '0')}`,
      issuer: `https://tenant-${index}.example.test`,
      lifecycle: 'active',
    }));
    expect(() => assertEnvironmentInventory({ ...inventory, tenants })).not.toThrow();
    invalid({ ...inventory, tenants: [...tenants, tenants[0]] }, assertEnvironmentInventory);
  });

  it.each([
    { ...inventory, complete: false },
    { ...inventory, tenants: [] },
    { ...inventory, tenants: [inventory.tenants[1], inventory.tenants[0]] },
    { ...inventory, tenants: [inventory.tenants[0], inventory.tenants[0]] },
    {
      ...inventory,
      tenants: [
        inventory.tenants[0],
        { ...inventory.tenants[1], issuer: inventory.tenants[0].issuer },
      ],
    },
    {
      ...inventory,
      tenants: [{ ...inventory.tenants[0], lifecycle: 'suspended' }, inventory.tenants[1]],
    },
    { ...inventory, sourceFenceRevision: -1 },
    { ...inventory, sourceReceiptSha256: hash('A') },
  ])('rejects an incomplete, unsorted, or contradictory inventory: %#', (value) => {
    invalid(value, assertEnvironmentInventory);
  });

  it.each([
    'http://alpha.example.test',
    'https://alpha.example.test/path',
    'https://user:pass@alpha.example.test',
    'https://alpha.example.test/',
  ])('rejects an issuer that is not its exact HTTPS origin: %s', (issuer) => {
    expect(() =>
      assertEnvironmentInventory({
        ...inventory,
        tenants: [{ ...inventory.tenants[0], issuer }, inventory.tenants[1]],
      })
    ).toThrow();
  });
});

describe('environment generation validation', () => {
  it('requires every inventory tenant to have its matching, unique restore proof', () => {
    expect(() => assertEnvironmentGenerationRecord(record)).not.toThrow();
    invalid({ ...record, children: [record.children[0]] }, assertEnvironmentGenerationRecord);
    invalid(
      { ...record, children: [record.children[1], record.children[0]] },
      assertEnvironmentGenerationRecord
    );
    invalid(
      {
        ...record,
        children: [record.children[0], { ...record.children[1], restoreId: 'restore-0' }],
      },
      assertEnvironmentGenerationRecord
    );
    invalid(
      {
        ...record,
        children: [
          record.children[0],
          {
            ...record.children[1],
            location: {
              ...record.children[1].location,
              issuerOrigin: 'https://other.example.test',
            },
          },
        ],
      },
      assertEnvironmentGenerationRecord
    );
  });

  it.each([
    { ...record, epoch: 3 },
    { ...record, sourceEpoch: 0 },
    { ...record, sourceDeploymentId: record.deploymentId },
    { ...record, sourceFenceRevision: 3 },
    { ...record, inventory: { ...inventory, environmentId: 'another-environment' } },
    { ...record, sourcePlanSha256: hash('A') },
  ])('rejects a generation that does not match its source or drain fence: %#', (value) => {
    invalid(value, assertEnvironmentGenerationRecord);
  });

  it('accepts a bounded data-loss acceptance with exact source sync evidence', () => {
    const proof = {
      generationId: 'generation-2',
      digestSha256: hash('a'),
      acceptedDataLoss: {
        sourceSyncOperationId: 'sync-1',
        sourceSyncPlanSha256: hash('b'),
        maximumSnapshotAgeMs: 30 * 86400_000,
        acceptedAtMs: 1000,
      },
    };
    expect(() => assertEnvironmentGenerationProof(proof)).not.toThrow();
    expect(() =>
      assertEnvironmentGenerationProof({ ...proof, acceptedDataLoss: null })
    ).not.toThrow();
    invalid(
      {
        ...proof,
        acceptedDataLoss: { ...proof.acceptedDataLoss, maximumSnapshotAgeMs: 30 * 86400_000 + 1 },
      },
      assertEnvironmentGenerationProof
    );
    invalid(
      { ...proof, acceptedDataLoss: { ...proof.acceptedDataLoss, acceptedAtMs: 0 } },
      assertEnvironmentGenerationProof
    );
    invalid(
      { ...proof, acceptedDataLoss: { acceptedAtMs: 1000 } },
      assertEnvironmentGenerationProof
    );
  });

  it('hashes canonical record content and rejects a valid-looking but stale digest', async () => {
    const { digestSha256: _digestSha256, ...body } = record;
    const digest = await environmentGenerationDigest(body);
    const reordered = Object.fromEntries(Object.entries(body).reverse()) as typeof body;
    expect(await environmentGenerationDigest(reordered)).toBe(digest);
    await expect(
      verifyEnvironmentGenerationDigest({ ...body, digestSha256: digest })
    ).resolves.toBeUndefined();
    await expect(
      verifyEnvironmentGenerationDigest({
        ...body,
        sourcePlanSha256: hash('f'),
        digestSha256: digest,
      })
    ).rejects.toThrow('deployment_authority_environment_invalid');
  });
});

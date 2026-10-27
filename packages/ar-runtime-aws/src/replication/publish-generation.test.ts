import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplicationConfiguration } from './plan';
import {
  publishReplicationGeneration,
  type PublishReplicationGenerationInput,
} from './publish-generation';

type PublicationCommand = { constructor: { name: string }; input: Record<string, unknown> };
const mocked = vi.hoisted(() => ({
  send: vi.fn<(command: PublicationCommand) => Promise<Record<string, unknown>>>(),
  destroyed: vi.fn(),
  configs: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => mocked.credentials,
}));
vi.mock('@aws-sdk/client-sts', async () => ({
  ...(await vi.importActual('@aws-sdk/client-sts')),
  STSClient: class {
    constructor(config: unknown) {
      mocked.configs(config);
    }
    send = mocked.send;
    destroy = mocked.destroyed;
  },
}));
vi.mock('@aws-sdk/client-s3', async () => ({
  ...(await vi.importActual('@aws-sdk/client-s3')),
  S3Client: class {
    constructor(config: unknown) {
      mocked.configs(config);
    }
    send = mocked.send;
    destroy = mocked.destroyed;
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', async () => ({
  ...(await vi.importActual('@aws-sdk/client-secrets-manager')),
  SecretsManagerClient: class {
    constructor(config: unknown) {
      mocked.configs(config);
    }
    send = mocked.send;
    destroy = mocked.destroyed;
  },
}));
const paths: string[] = [];
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const generationId = '11111111-1111-4111-8111-111111111111';
const artifacts = {
  region: 'ap-northeast-1',
  bucket: 'replication-example',
  bucketOwner: '123456789012',
  keyPrefix: 'generations',
  kmsKeyArn: 'arn:aws:kms:ap-northeast-1:123456789012:key/22222222-2222-4222-8222-222222222222',
  secretNamePrefix: 'authrim-replication',
};
const secretArn = `arn:aws:secretsmanager:${artifacts.region}:${artifacts.bucketOwner}:secret:${artifacts.secretNamePrefix}/${generationId}-AbCdEf`;

beforeEach(() => {
  mocked.send.mockReset();
  mocked.destroyed.mockReset();
  mocked.configs.mockReset();
  mocked.credentials.mockReset();
  mocked.credentials.mockResolvedValue({
    accessKeyId: 'synthetic-key',
    secretAccessKey: 'synthetic-secret',
    sessionToken: 'synthetic-token',
  });
  mocked.send.mockImplementation(async (command: PublicationCommand) => {
    if (command.constructor.name === 'GetCallerIdentityCommand')
      return { Account: artifacts.bucketOwner };
    if (command.constructor.name === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
    if (command.constructor.name === 'PutObjectCommand') return { VersionId: 'immutable-version' };
    if (command.constructor.name === 'CreateSecretCommand')
      return {
        ARN: secretArn,
        VersionId: generationId,
        Name: `${artifacts.secretNamePrefix}/${generationId}`,
      };
    throw new Error('unexpected call');
  });
});
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<PublishReplicationGenerationInput> {
  const folder = await mkdtemp(join(await realpath(tmpdir()), 'authrim-generation-publish-'));
  paths.push(folder);
  const part = new TextEncoder().encode('encrypted test bytes');
  const supplement = new TextEncoder().encode('synthetic supplemental data');
  const partPath = join(folder, 'part.authrim2');
  const supplementPath = join(folder, 'supplement.json');
  await writeFile(partPath, part, { mode: 0o600 });
  await writeFile(supplementPath, supplement, { mode: 0o600 });
  const source = {
    tenantId: 'tenant-a',
    issuer: 'https://issuer.example.test',
    productVersion: '0.4.2',
  };
  const receipt = {
    source,
    bundleId: 'a'.repeat(32),
    snapshotId: 'snapshot-a',
    inventoryDigestSha256: 'b'.repeat(64),
    parts: [{ size: part.length, sha256: hash(part) }],
  };
  return {
    configuration: {
      pair: { pairId: 'pair-a', tenantId: 'tenant-a' },
      destinationDeploymentId: 'aws-a',
      source: { identity: source },
      destination: { artifacts },
    } as ReplicationConfiguration,
    generationId,
    epoch: 2,
    manifest: {
      formatVersion: 1,
      evidence: {
        formatVersion: 1,
        restoreId: generationId,
        tenantId: 'tenant-a',
        issuer: source.issuer,
        bundleId: receipt.bundleId,
        snapshotId: receipt.snapshotId,
        inventoryDigestSha256: receipt.inventoryDigestSha256,
        boundaryUnixMs: 1000,
        activatedAtMs: 2000,
        maxSnapshotAgeMs: 3_600_000,
        backupReceiptSha256: 'c'.repeat(64),
        supplementFileSha256: hash(supplement),
        coreTargetId: '33333333-3333-4333-8333-333333333333',
        piiTargetId: '44444444-4444-4444-8444-444444444444',
        coreReceiptSha256: 'd'.repeat(64),
        piiReceiptSha256: 'e'.repeat(64),
        stateReceiptSha256: 'f'.repeat(64),
        configurationSha256: '1'.repeat(64),
      },
      backup: {
        receipt,
        selection: {
          settings: true,
          users: true,
          admin: false,
          artifacts: false,
          logs: { audit: false, other: false, sensitive: false, period: 7 },
        },
        datasets: [],
        maxSnapshotAgeMs: 3_600_000,
      },
      core: { targetId: '33333333-3333-4333-8333-333333333333', bindingRefs: ['core-a'] },
      pii: { targetId: '44444444-4444-4444-8444-444444444444', bindingRefs: ['pii-a'] },
      environmentName: 'aws-a',
      spEntityIds: ['https://sp.example.test/entity'],
      allocationScope: 'tenant_exclusive',
      replicationWriter: {
        version: 1,
        endpoint: 'https://authority.example.test/replication/v1/rpc',
        credentialId: 'writer-a',
        pairId: 'pair-a',
        tenantId: 'tenant-a',
        deploymentId: 'aws-a',
        epoch: 2,
        generationId,
      },
    },
    secrets: {
      formatVersion: 1,
      tenantId: 'tenant-a',
      backupPassphrase: 'synthetic-backup-passphrase',
      coreDatabaseUrl: 'postgresql://user:secret@db.example.test/core?sslmode=verify-full',
      piiDatabaseUrl: 'postgresql://user:secret@db.example.test/pii?sslmode=verify-full',
      stateDatabaseUrl: 'postgresql://user:secret@db.example.test/state?sslmode=verify-full',
      flowHmacSecret: 'f'.repeat(32),
      lookupReadKeys: [{ generation: 1, secret: 'l'.repeat(32) }],
      replicationWriterSecret: 'a'.repeat(64),
    },
    parts: [{ path: partPath, size: part.length, sha256: hash(part) }],
    supplement: { path: supplementPath, size: supplement.length, sha256: hash(supplement) },
  };
}

describe('immutable replication generation publication', () => {
  it.each(['999999999999', undefined, 'invalid'])(
    'rejects caller account %s before any storage request',
    async (account) => {
      const input = await fixture();
      mocked.send.mockResolvedValueOnce({ Account: account });
      await expect(publishReplicationGeneration(input)).rejects.toThrow(
        'replication_generation_publication_failed'
      );
      expect(mocked.send).toHaveBeenCalledTimes(1);
      expect(mocked.configs).toHaveBeenCalledTimes(1);
      expect(mocked.destroyed).toHaveBeenCalledTimes(1);
    }
  );

  it('redacts credential-resolution errors and never constructs a storage client', async () => {
    const input = await fixture();
    mocked.credentials.mockRejectedValueOnce(new Error('private-credential-diagnostic'));
    await expect(publishReplicationGeneration(input)).rejects.toThrow(
      'replication_generation_publication_failed'
    );
    expect(mocked.send).not.toHaveBeenCalled();
    expect(mocked.configs).not.toHaveBeenCalled();
  });

  it('pins every object and secret version, uses KMS and never changes serving authority', async () => {
    const input = await fixture();
    const published = await publishReplicationGeneration(input);
    expect(published.generationId).toBe(generationId);
    expect(published.epoch).toBe(2);
    expect(published.location.secretVersionId).toBe(generationId);
    const calls = mocked.send.mock.calls.map(
      ([command]) => command as { constructor: { name: string }; input: Record<string, unknown> }
    );
    const puts = calls.filter((call) => call.constructor.name === 'PutObjectCommand');
    expect(puts).toHaveLength(3);
    for (const put of puts) {
      expect(put.input).toMatchObject({
        Bucket: artifacts.bucket,
        ExpectedBucketOwner: artifacts.bucketOwner,
        IfNoneMatch: '*',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: artifacts.kmsKeyArn,
      });
      expect(put.input.Key).toContain(`/${generationId}/`);
    }
    const publicManifest = JSON.parse(
      new TextDecoder().decode(puts[2].input.Body as Uint8Array)
    ) as unknown;
    expect(JSON.stringify(publicManifest)).not.toContain(input.secrets.backupPassphrase);
    expect(published.location.manifestSha256).toBe(hash(puts[2].input.Body as Uint8Array));
    expect(calls.map((call) => call.constructor.name)).not.toContain(
      'UpdateFunctionConfigurationCommand'
    );
    expect(mocked.destroyed).toHaveBeenCalledTimes(3);
    expect(mocked.credentials).toHaveBeenCalledTimes(1);
    const configs = mocked.configs.mock.calls.map(([config]) => config as { credentials: unknown });
    expect(configs).toHaveLength(3);
    expect(configs[1].credentials).toBe(configs[0].credentials);
    expect(configs[2].credentials).toBe(configs[0].credentials);
    expect(calls[0].constructor.name).toBe('GetCallerIdentityCommand');
  });
  it('rejects missing bucket versioning before any object or secret write', async () => {
    const input = await fixture();
    mocked.send
      .mockResolvedValueOnce({ Account: artifacts.bucketOwner })
      .mockResolvedValueOnce({ Status: 'Suspended' });
    await expect(publishReplicationGeneration(input)).rejects.toThrow(
      'replication_generation_publication_failed'
    );
    expect(mocked.send).toHaveBeenCalledTimes(2);
  });
  it('refuses locally replaced ciphertext instead of publishing it', async () => {
    const input = await fixture();
    await writeFile(input.parts[0].path, 'changed private bytes');
    await expect(publishReplicationGeneration(input)).rejects.toThrow(
      'replication_generation_publication_failed'
    );
    expect(mocked.send).toHaveBeenCalledTimes(2);
  });
  it.each(['version', 'name', 'account', 'suffix'] as const)(
    'rejects a successful secret response with the wrong %s without publishing a manifest',
    async (variant) => {
      const input = await fixture();
      const standard = mocked.send.getMockImplementation();
      if (!standard) throw new Error('test sender missing');
      mocked.send.mockImplementation(async (command: PublicationCommand) => {
        if (command.constructor.name === 'CreateSecretCommand')
          return {
            ARN:
              variant === 'account'
                ? secretArn.replace(artifacts.bucketOwner, '999999999999')
                : variant === 'suffix'
                  ? `${secretArn}wrong`
                  : secretArn,
            Name:
              variant === 'name' ? 'different' : `${artifacts.secretNamePrefix}/${generationId}`,
            VersionId:
              variant === 'version' ? '22222222-2222-4222-8222-222222222222' : generationId,
          };
        return standard(command);
      });
      await expect(publishReplicationGeneration(input)).rejects.toThrow(
        'replication_generation_publication_failed'
      );
      const commands = mocked.send.mock.calls.map(
        ([command]) => command as { constructor: { name: string }; input: Record<string, unknown> }
      );
      expect(
        commands.filter((command) => command.constructor.name === 'PutObjectCommand')
      ).toHaveLength(2);
      expect(commands.some((command) => command.constructor.name === 'DescribeSecretCommand')).toBe(
        false
      );
    }
  );

  it.each(['different-key', 'default-key', 'alias', 'deleted', 'name', 'arn'] as const)(
    'rejects secret reconciliation metadata with %s before reading a secret value',
    async (variant) => {
      const input = await fixture();
      const standard = mocked.send.getMockImplementation();
      if (!standard) throw new Error('test sender missing');
      mocked.send.mockImplementation(async (command: PublicationCommand) => {
        if (command.constructor.name === 'CreateSecretCommand') throw new Error('lost response');
        if (command.constructor.name === 'DescribeSecretCommand')
          return {
            ARN:
              variant === 'arn'
                ? secretArn.replace(artifacts.bucketOwner, '999999999999')
                : secretArn,
            Name:
              variant === 'name' ? 'different' : `${artifacts.secretNamePrefix}/${generationId}`,
            KmsKeyId:
              variant === 'different-key'
                ? artifacts.kmsKeyArn.replace(/2/g, '3')
                : variant === 'default-key'
                  ? undefined
                  : variant === 'alias'
                    ? 'alias/example'
                    : artifacts.kmsKeyArn,
            ...(variant === 'deleted' ? { DeletedDate: new Date() } : {}),
          };
        return standard(command);
      });
      await expect(publishReplicationGeneration(input)).rejects.toThrow(
        'replication_generation_publication_failed'
      );
      expect(
        mocked.send.mock.calls.some(
          ([command]) =>
            (command as { constructor: { name: string } }).constructor.name ===
            'GetSecretValueCommand'
        )
      ).toBe(false);
    }
  );
  it.each([artifacts.kmsKeyArn, artifacts.kmsKeyArn.split('/').at(-1)])(
    'reconciles a lost create response only against identical bytes, pinned version and key %s',
    async (kmsKeyId) => {
      const input = await fixture();
      const objects = new Map<string, Uint8Array>();
      let savedSecret = '';
      mocked.send.mockImplementation(
        async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const data = command.input;
          if (command.constructor.name === 'GetCallerIdentityCommand')
            return { Account: artifacts.bucketOwner };
          if (command.constructor.name === 'GetBucketVersioningCommand')
            return { Status: 'Enabled' };
          if (command.constructor.name === 'PutObjectCommand') {
            objects.set(String(data.Key), data.Body as Uint8Array);
            throw new Error('response lost');
          }
          if (command.constructor.name === 'GetObjectCommand') {
            const bytes = objects.get(String(data.Key));
            if (!bytes) throw new Error('unexpected missing test object');
            return {
              ContentLength: bytes.length,
              ServerSideEncryption: 'aws:kms',
              SSEKMSKeyId: artifacts.kmsKeyArn,
              VersionId: 'version-reconciled',
              Body: { transformToByteArray: async () => bytes, destroy: vi.fn() },
            };
          }
          if (command.constructor.name === 'CreateSecretCommand') {
            savedSecret = String(data.SecretString);
            throw new Error('response lost');
          }
          if (command.constructor.name === 'DescribeSecretCommand')
            return {
              ARN: secretArn,
              Name: `${artifacts.secretNamePrefix}/${generationId}`,
              KmsKeyId: kmsKeyId,
            };
          if (command.constructor.name === 'GetSecretValueCommand')
            return { SecretString: savedSecret, VersionId: generationId, ARN: secretArn };
          throw new Error('unexpected');
        }
      );
      expect((await publishReplicationGeneration(input)).location.manifestVersionId).toBe(
        'version-reconciled'
      );
    }
  );
});

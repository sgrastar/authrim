/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- fakes and deliberately malformed inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { createAwsSdkAssetReader, loadAwsSamlDeployment, type AwsAssetReader } from './aws-assets';
import type { AwsSamlDeploymentManifest, AwsSamlDeploymentLocation } from './deployment-config';
import type { LoadActivatedAwsSamlTenantInput } from './load-activated-tenant';

const sdk = vi.hoisted(() => ({
  s3: [] as Array<{
    config: unknown;
    send: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  secrets: [] as Array<{
    config: unknown;
    send: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  commands: [] as Array<{ kind: string; input: unknown }>,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = vi.fn();
    destroy = vi.fn();
    constructor(public config: unknown) {
      sdk.s3.push(this);
    }
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {
      sdk.commands.push({ kind: 'object', input });
    }
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = vi.fn();
    destroy = vi.fn();
    constructor(public config: unknown) {
      sdk.secrets.push(this);
    }
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {
      sdk.commands.push({ kind: 'secret', input });
    }
  },
}));

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const TENANT = 'tenant-a';
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const part = new TextEncoder().encode('synthetic encrypted backup bytes');
const supplement = new TextEncoder().encode('synthetic source supplement');
const secret = {
  formatVersion: 1,
  tenantId: TENANT,
  backupPassphrase: 'synthetic-backup-passphrase',
  coreDatabaseUrl: 'postgres://user:test@core.example.test/core?sslmode=verify-full',
  piiDatabaseUrl: 'postgres://user:test@pii.example.test/pii?sslmode=verify-full',
  stateDatabaseUrl: 'postgres://user:test@state.example.test/state?sslmode=verify-full',
  flowHmacSecret: 'synthetic-flow-key-with-at-least-32-bytes',
  lookupReadKeys: [{ generation: 1, secret: 'synthetic-lookup-key-with-at-least-32-bytes' }],
};

function manifest(): AwsSamlDeploymentManifest {
  return {
    formatVersion: 1,
    evidence: {
      formatVersion: 1,
      restoreId: UUID_A,
      tenantId: TENANT,
      issuer: 'https://tenant-a.example.test',
      bundleId: 'a'.repeat(32),
      snapshotId: 'snapshot-a',
      inventoryDigestSha256: 'b'.repeat(64),
      boundaryUnixMs: 1000,
      activatedAtMs: 2000,
      maxSnapshotAgeMs: 3_600_000,
      backupReceiptSha256: 'c'.repeat(64),
      supplementFileSha256: sha(supplement),
      coreTargetId: UUID_A,
      piiTargetId: UUID_B,
      coreReceiptSha256: 'd'.repeat(64),
      piiReceiptSha256: 'e'.repeat(64),
      stateReceiptSha256: 'f'.repeat(64),
      configurationSha256: '1'.repeat(64),
    },
    backup: {
      receipt: {
        source: {
          tenantId: TENANT,
          issuer: 'https://tenant-a.example.test',
          productVersion: '0.4.2',
        },
        bundleId: 'a'.repeat(32),
        snapshotId: 'snapshot-a',
        inventoryDigestSha256: 'b'.repeat(64),
        parts: [{ size: part.length, sha256: sha(part) }],
      },
      selection: {
        settings: true,
        users: true,
        admin: false,
        artifacts: false,
        logs: { audit: false, other: false, sensitive: false, period: 7 },
      },
      datasets: [],
      maxSnapshotAgeMs: 3_600_000,
      parts: [
        {
          key: 'snapshots/part-0',
          versionId: 'part-version',
          size: part.length,
          sha256: sha(part),
        },
      ],
    },
    supplement: {
      key: 'snapshots/supplement',
      versionId: 'supplement-version',
      size: supplement.length,
      sha256: sha(supplement),
    },
    core: { targetId: UUID_A, bindingRefs: ['core-a'] },
    pii: { targetId: UUID_B, bindingRefs: ['pii-a'] },
    environmentName: 'aws-local-test',
    spEntityIds: ['https://sp.example.test/entity'],
    allocationScope: 'tenant_exclusive',
  };
}

function fixture(
  destinationUi?: AwsSamlDeploymentManifest['destinationUi'],
  authState?: AwsSamlDeploymentManifest['authState'],
  replicationWriter?: AwsSamlDeploymentManifest['replicationWriter']
) {
  const manifestBytes = new TextEncoder().encode(
    canonicalRestoreJson({
      ...manifest(),
      ...(destinationUi === undefined ? {} : { destinationUi }),
      ...(authState === undefined ? {} : { authState }),
      ...(replicationWriter === undefined ? {} : { replicationWriter }),
    })
  );
  const location: AwsSamlDeploymentLocation = {
    region: 'ap-northeast-1',
    issuerOrigin: 'https://tenant-a.example.test',
    bucket: 'authrim-test-assets',
    bucketOwner: '123456789012',
    secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test-abcdef',
    secretVersionId: UUID_A,
    manifestKey: 'manifest.json',
    manifestVersionId: 'manifest-version',
    manifestSha256: sha(manifestBytes),
  };
  const objects = new Map([
    [location.manifestKey, { versionId: location.manifestVersionId, bytes: manifestBytes }],
    ['snapshots/part-0', { versionId: 'part-version', bytes: part }],
    ['snapshots/supplement', { versionId: 'supplement-version', bytes: supplement }],
  ]);
  const closed: string[] = [];
  const getSecret = vi.fn(async () => ({
    arn: location.secretArn,
    versionId: location.secretVersionId,
    value: JSON.stringify(secret),
  }));
  const getObject = vi.fn(async (input: Parameters<AwsAssetReader['getObject']>[0]) => {
    expect(input.bucket).toBe(location.bucket);
    expect(input.owner).toBe(location.bucketOwner);
    const object = objects.get(input.key);
    if (!object) throw new Error('unexpected_object');
    expect(input.versionId).toBe(object.versionId);
    return {
      versionId: object.versionId,
      size: object.bytes.length,
      body: (async function* () {
        yield object.bytes.subarray(0, 4);
        yield object.bytes.subarray(4);
      })(),
      close: () => {
        closed.push(input.key);
      },
    };
  });
  return {
    location,
    objects,
    closed,
    getSecret,
    getObject,
    reader: { getSecret, getObject, close: () => undefined } satisfies AwsAssetReader,
  };
}

beforeEach(() => {
  sdk.s3.length = 0;
  sdk.secrets.length = 0;
  sdk.commands.length = 0;
});

describe('AWS SDK asset reader (mutation hardening)', () => {
  const clientConfig = (region: string | undefined) => ({
    region,
    maxAttempts: 2,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: 15_000,
      httpsAgent: { maxSockets: 4 },
    },
  });

  it('builds bounded, endpoint-pinned clients and closes both', () => {
    const reader = createAwsSdkAssetReader('ap-northeast-1');
    expect(sdk.s3).toHaveLength(1);
    expect(sdk.secrets).toHaveLength(1);
    expect(sdk.s3[0].config).toEqual(clientConfig('ap-northeast-1'));
    expect(sdk.secrets[0].config).toEqual(clientConfig('ap-northeast-1'));
    expect((sdk.s3[0].config as { requestHandler: unknown }).requestHandler).toStrictEqual({
      connectionTimeout: 3000,
      requestTimeout: 15000,
      httpsAgent: { maxSockets: 4 },
    });
    expect((createAwsSdkAssetReader(undefined), sdk.s3[1].config)).toEqual(clientConfig(undefined));
    reader.close();
    expect(sdk.s3[0].destroy).toHaveBeenCalledTimes(1);
    expect(sdk.secrets[0].destroy).toHaveBeenCalledTimes(1);
    expect(sdk.s3[1].destroy).not.toHaveBeenCalled();
  });

  it('reads a pinned secret version with the caller abort signal', async () => {
    const reader = createAwsSdkAssetReader('ap-northeast-1');
    sdk.secrets[0].send.mockResolvedValue({
      ARN: 'arn-1',
      VersionId: 'v-1',
      SecretString: 'value',
    });
    const signal = new AbortController().signal;
    expect(await reader.getSecret({ arn: 'arn-1', versionId: 'v-1', signal })).toStrictEqual({
      arn: 'arn-1',
      versionId: 'v-1',
      value: 'value',
    });
    expect(sdk.commands.at(-1)).toEqual({
      kind: 'secret',
      input: { SecretId: 'arn-1', VersionId: 'v-1' },
    });
    expect(sdk.secrets[0].send).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.anything() }),
      {
        abortSignal: signal,
      }
    );
    expect(sdk.s3[0].send).not.toHaveBeenCalled();
    sdk.secrets[0].send.mockResolvedValue({});
    expect(await reader.getSecret({ arn: 'a', versionId: 'v', signal })).toStrictEqual({
      arn: undefined,
      versionId: undefined,
      value: undefined,
    });
  });

  it('reads a pinned object version owned by the expected account', async () => {
    const reader = createAwsSdkAssetReader('ap-northeast-1');
    const body = Readable.from([new Uint8Array([1, 2, 3])]);
    sdk.s3[0].send.mockResolvedValue({ Body: body, VersionId: 'ver', ContentLength: 3 });
    const controller = new AbortController();
    const object = await reader.getObject({
      bucket: 'bucket-1',
      owner: '123456789012',
      key: 'key/1',
      versionId: 'ver',
      signal: controller.signal,
    });
    expect(sdk.commands.at(-1)).toEqual({
      kind: 'object',
      input: {
        Bucket: 'bucket-1',
        Key: 'key/1',
        VersionId: 'ver',
        ExpectedBucketOwner: '123456789012',
      },
    });
    expect(sdk.s3[0].send).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.anything() }),
      {
        abortSignal: controller.signal,
      }
    );
    expect(object.versionId).toBe('ver');
    expect(object.size).toBe(3);
    expect(object.body).toBe(body);
    expect(sdk.secrets[0].send).not.toHaveBeenCalled();
    object.close();
    expect(body.destroyed).toBe(true);
  });

  it.each([
    ['web stream with cancel', () => ({ cancel: vi.fn(async () => undefined) }), true],
    ['object without cancel', () => ({}), false],
    ['non-function cancel', () => ({ cancel: 'yes' }), false],
    ['null body', () => null, false],
    ['missing body', () => undefined, false],
  ])('refuses a non-Node-stream body: %s', async (_name, makeBody, cancels) => {
    const reader = createAwsSdkAssetReader('ap-northeast-1');
    const body = makeBody();
    sdk.s3[0].send.mockResolvedValue({ Body: body, VersionId: 'v', ContentLength: 1 });
    await expect(
      reader.getObject({
        bucket: 'b',
        owner: 'o',
        key: 'k',
        versionId: 'v',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(new Error('aws_deployment_assets_invalid'));
    if (body && typeof body === 'object' && 'cancel' in body && typeof body.cancel === 'function')
      expect(body.cancel).toHaveBeenCalledTimes(cancels ? 1 : 0);
  });

  it('destroys the stream with a fixed error when the signal aborts, and stops listening after close', async () => {
    const reader = createAwsSdkAssetReader('ap-northeast-1');
    const open = async (signal: AbortSignal) => {
      const body = new Readable({ read() {} });
      body.on('error', () => undefined);
      sdk.s3[0].send.mockResolvedValue({ Body: body, VersionId: 'v', ContentLength: 1 });
      const object = await reader.getObject({
        bucket: 'b',
        owner: 'o',
        key: 'k',
        versionId: 'v',
        signal,
      });
      return { body, object };
    };
    const first = new AbortController();
    const live = await open(first.signal);
    const destroy = vi.spyOn(live.body, 'destroy');
    expect(live.body.destroyed).toBe(false);
    first.abort();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect((destroy.mock.calls[0][0] as Error).message).toBe('aws_asset_read_aborted');
    expect(live.body.destroyed).toBe(true);

    const second = new AbortController();
    const closed = await open(second.signal);
    const destroyClosed = vi.spyOn(closed.body, 'destroy');
    closed.object.close();
    expect(destroyClosed).toHaveBeenCalledTimes(1);
    expect(destroyClosed.mock.calls[0]).toEqual([]);
    second.abort();
    expect(destroyClosed).toHaveBeenCalledTimes(1);

    const aborted = new AbortController();
    aborted.abort();
    const already = await open(aborted.signal);
    expect(already.body.destroyed).toBe(true);
  });
});

describe('startup loader cleanup (mutation hardening)', () => {
  let parent: string;
  let previous: string | undefined;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'authrim-assets-mutation-'));
    previous = process.env.TMPDIR;
    process.env.TMPDIR = parent;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(parent, { recursive: true, force: true });
  });
  const leftovers = async () =>
    (await readdir(parent)).filter((n) => n.startsWith('authrim-aws-startup-'));
  const tenantLoader = (over: Partial<{ fail: boolean }> = {}) =>
    vi.fn(async (input: LoadActivatedAwsSamlTenantInput) => {
      if (over.fail) throw new Error('private failure');
      return {
        authState: { config: { backend: 'postgresql' as const } },
        runtime: {
          tenantId: TENANT,
          origin: input.evidence.issuer,
          env: {} as Env,
          assertReady: async () => undefined,
        },
        close: vi.fn(async () => undefined),
      };
    });

  it('removes the working directory, with its downloaded files, after a failed tenant load', async () => {
    const value = fixture();
    const loadTenant = tenantLoader({ fail: true });
    await expect(loadAwsSamlDeployment({ ...value, loadTenant })).rejects.toThrow(
      new Error('aws_deployment_load_failed')
    );
    expect(loadTenant).toHaveBeenCalledTimes(1);
    expect(await leftovers()).toEqual([]);
  });

  it('removes the working directory after a download that fails verification', async () => {
    const value = fixture();
    value.objects.set('snapshots/supplement', {
      versionId: 'supplement-version',
      bytes: new TextEncoder().encode('tampered source supplement'.padEnd(supplement.length, '!')),
    });
    await expect(loadAwsSamlDeployment({ ...value, loadTenant: tenantLoader() })).rejects.toThrow(
      new Error('aws_deployment_load_failed')
    );
    expect(await leftovers()).toEqual([]);
  });

  it('removes the working directory after success and keeps the loaded tenant open', async () => {
    const value = fixture();
    const loadTenant = tenantLoader();
    const loaded = await loadAwsSamlDeployment({ ...value, loadTenant });
    expect(await leftovers()).toEqual([]);
    const tenant = await loadTenant.mock.results[0].value;
    expect(tenant.close).not.toHaveBeenCalled();
    expect(loaded).toBe(tenant);
    expect(value.closed).toEqual(['manifest.json', 'snapshots/part-0', 'snapshots/supplement']);
  });

  it('closes a loaded tenant exactly once when the deployment is aborted after the tenant load', async () => {
    const value = fixture();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const closes: Array<ReturnType<typeof vi.fn>> = [];
      const loadTenant = vi.fn(async (input: LoadActivatedAwsSamlTenantInput) => {
        const tenant = await tenantLoader()(input);
        closes.push(tenant.close);
        // abort only once the tenant is loaded, so the failure happens strictly after the load
        controller.abort();
        return tenant;
      });
      await expect(loadAwsSamlDeployment({ ...value, loadTenant })).rejects.toThrow(
        new Error('aws_deployment_load_failed')
      );
      expect(loadTenant).toHaveBeenCalledTimes(1);
      expect(closes).toHaveLength(1);
      expect(closes[0]).toHaveBeenCalledTimes(1);
      expect(await leftovers()).toEqual([]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('does not load a tenant when the pinned secret disagrees with the manifest', async () => {
    const value = fixture(undefined, undefined, undefined);
    // the pinned secret declares a replication writer the manifest does not
    value.getSecret.mockResolvedValue({
      arn: value.location.secretArn,
      versionId: value.location.secretVersionId,
      value: JSON.stringify({ ...secret, replicationWriterSecret: 'a'.repeat(64) }),
    });
    const loadTenant = tenantLoader();
    await expect(loadAwsSamlDeployment({ ...value, loadTenant })).rejects.toThrow(
      new Error('aws_deployment_load_failed')
    );
    expect(loadTenant).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  });

  it('reports a fixed code for asset validation failures', async () => {
    const value = fixture();
    value.getSecret.mockResolvedValue({
      arn: 'arn:other',
      versionId: value.location.secretVersionId,
      value: JSON.stringify(secret),
    });
    await expect(loadAwsSamlDeployment({ ...value, loadTenant: tenantLoader() })).rejects.toThrow(
      new Error('aws_deployment_load_failed')
    );
  });
});

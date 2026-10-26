import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { loadAwsSamlDeployment, type AwsAssetReader } from './aws-assets';
import {
  assertAwsDatabaseTlsUrl,
  parseAwsSamlDeploymentLocation,
  parseAwsSamlDeploymentManifest,
  parseAwsSamlDeploymentSecrets,
  type AwsSamlDeploymentManifest,
  type AwsSamlDeploymentLocation,
} from './deployment-config';
import type { LoadActivatedAwsSamlTenantInput } from './load-activated-tenant';

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
  authState?: AwsSamlDeploymentManifest['authState']
) {
  const manifestBytes = new TextEncoder().encode(
    canonicalRestoreJson({
      ...manifest(),
      ...(destinationUi === undefined ? {} : { destinationUi }),
      ...(authState === undefined ? {} : { authState }),
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

it('preserves independent UI omission through the pinned cold-start manifest', async () => {
  const destinationUi: NonNullable<AwsSamlDeploymentManifest['destinationUi']> = {
    components: { loginUi: false, adminUi: false },
    ui: {
      login: { mode: 'disabled' },
      admin: { mode: 'external', baseUrl: 'https://admin.example.test' },
    },
  };
  const value = fixture(destinationUi);
  const close = vi.fn(async () => undefined);
  const loadTenant = vi.fn(async (input: LoadActivatedAwsSamlTenantInput) => ({
    authState: { config: { backend: 'postgresql' as const } },
    runtime: {
      tenantId: TENANT,
      origin: input.evidence.issuer,
      ui: input.destinationUi,
      env: {} as Env,
      assertReady: async () => undefined,
    },
    close,
  }));
  const loaded = await loadAwsSamlDeployment({ ...value, loadTenant });
  expect(loadTenant).toHaveBeenCalledWith(expect.objectContaining({ destinationUi }));
  expect(loaded.runtime.ui).toEqual(destinationUi);
  await loaded.close();
  expect(() =>
    parseAwsSamlDeploymentManifest(
      JSON.stringify({
        ...manifest(),
        destinationUi: { ...destinationUi, components: { loginUi: true, adminUi: false } },
      })
    )
  ).toThrow('aws_deployment_config_invalid');
});

it('pins the selected auth-state backend through cold start and refuses wrong deployment targets', async () => {
  const authState = {
    backend: 'dynamodb' as const,
    region: 'ap-northeast-1',
    tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/authrim-state',
    namespace: UUID_A,
  };
  const value = fixture(undefined, authState);
  const loadTenant = vi.fn(async (input: LoadActivatedAwsSamlTenantInput) => ({
    // This seam inspects inputs; actual backend receipts are tested through restore/cold-start integration.
    authState: { config: { backend: 'postgresql' as const } },
    runtime: {
      tenantId: TENANT,
      origin: input.evidence.issuer,
      env: {} as Env,
      assertReady: async () => undefined,
    },
    close: async () => undefined,
  }));
  const loaded = await loadAwsSamlDeployment({ ...value, loadTenant });
  expect(loadTenant).toHaveBeenCalledWith(expect.objectContaining({ authState }));
  await loaded.close();
  for (const invalid of [
    { ...authState, namespace: UUID_B },
    { ...authState, tableArn: authState.tableArn.replace('123456789012', '999999999999') },
    {
      ...authState,
      region: 'us-east-1',
      tableArn: authState.tableArn.replace('ap-northeast-1', 'us-east-1'),
    },
  ]) {
    const mismatch = fixture(undefined, invalid);
    const rejectLoader = vi.fn();
    await expect(
      loadAwsSamlDeployment({ ...mismatch, loadTenant: rejectLoader })
    ).rejects.toThrow();
    expect(rejectLoader).not.toHaveBeenCalled();
    expect(mismatch.getSecret).not.toHaveBeenCalled();
  }
});

it('loads exact object and secret versions, verifies hashes, and removes private temporary files', async () => {
  const value = fixture();
  let loadedInput: LoadActivatedAwsSamlTenantInput | undefined;
  const close = vi.fn(async () => undefined);
  const loadTenant = vi.fn(async (input: LoadActivatedAwsSamlTenantInput) => {
    loadedInput = input;
    expect([...(await readFile(input.backup.partPaths[0]))]).toEqual([...part]);
    expect((await stat(input.supplement.path)).mode & 0o777).toBe(0o600);
    expect(input.core.connectionString).toBe(secret.coreDatabaseUrl);
    expect(input.evidence.tenantId).toBe(TENANT);
    return {
      authState: { config: { backend: 'postgresql' as const } },
      runtime: {
        tenantId: TENANT,
        origin: input.evidence.issuer,
        env: {} as Env,
        assertReady: async () => undefined,
      },
      close,
    };
  });
  const loaded = await loadAwsSamlDeployment({ ...value, loadTenant });
  expect(loadTenant).toHaveBeenCalledOnce();
  expect(value.closed).toEqual(['manifest.json', 'snapshots/part-0', 'snapshots/supplement']);
  if (!loadedInput) throw new Error('fixture_not_loaded');
  await expect(access(loadedInput.supplement.path)).rejects.toThrow();
  await expect(access(loadedInput.backup.partPaths[0])).rejects.toThrow();
  expect(close).not.toHaveBeenCalled();
  await loaded.close();
  expect(close).toHaveBeenCalledOnce();
});

it('refuses changed bytes, mismatched secret versions, and overlong responses before tenant load', async () => {
  const changed = fixture();
  changed.objects.set('snapshots/part-0', {
    versionId: 'part-version',
    bytes: new Uint8Array(part.length).fill(65),
  });
  const loadTenant = vi.fn(async () => {
    throw new Error('must_not_load');
  });
  await expect(loadAwsSamlDeployment({ ...changed, loadTenant })).rejects.toThrow(
    /^aws_deployment_load_failed$/u
  );
  expect(changed.closed).toContain('snapshots/part-0');
  expect(loadTenant).not.toHaveBeenCalled();
  const version = fixture();
  version.getSecret.mockResolvedValueOnce({
    arn: version.location.secretArn,
    versionId: UUID_B,
    value: 'sensitive-value-must-not-escape',
  });
  await expect(loadAwsSamlDeployment({ ...version, loadTenant })).rejects.toThrow(
    /^aws_deployment_load_failed$/u
  );
  expect(version.getObject).toHaveBeenCalledTimes(1);
  const oversized = fixture();
  oversized.getObject.mockResolvedValueOnce({
    versionId: oversized.location.manifestVersionId,
    size: 3 * 1024 * 1024,
    body: (async function* () {
      yield part;
    })(),
    close: () => {
      oversized.closed.push('oversized');
    },
  });
  await expect(loadAwsSamlDeployment({ ...oversized, loadTenant })).rejects.toThrow(
    'aws_deployment_load_failed'
  );
  expect(oversized.closed).toEqual(['oversized']);
});

it('rejects a manifest for another deployed issuer before reading secrets or backup data', async () => {
  const value = fixture();
  value.location.issuerOrigin = 'https://tenant-b.example.test';
  const loadTenant = vi.fn(async () => {
    throw new Error('must_not_load');
  });
  await expect(loadAwsSamlDeployment({ ...value, loadTenant })).rejects.toThrow(
    /^aws_deployment_load_failed$/u
  );
  expect(value.getObject).toHaveBeenCalledTimes(1);
  expect(value.getSecret).not.toHaveBeenCalled();
  expect(loadTenant).not.toHaveBeenCalled();
});

it('rejects unversioned assets, size/hash conflicts, foreign tenant secrets, and TLS downgrades', () => {
  const version = manifest();
  version.backup.parts = [{ ...version.backup.parts[0], versionId: 'null' }];
  expect(() => parseAwsSamlDeploymentManifest(JSON.stringify(version))).toThrow(
    'aws_deployment_config_invalid'
  );
  const count = manifest();
  count.backup.parts = [{ ...count.backup.parts[0], size: 1 }];
  expect(() => parseAwsSamlDeploymentManifest(JSON.stringify(count))).toThrow(
    'aws_deployment_config_invalid'
  );
  expect(() => parseAwsSamlDeploymentSecrets(JSON.stringify(secret), 'tenant-b')).toThrow(
    'aws_deployment_config_invalid'
  );
  for (const suffix of [
    '',
    '?sslmode=disable',
    '?sslmode=require',
    '?sslmode=verify-full&sslmode=disable',
    '?sslmode=verify-full&sslrootcert=/tmp/untrusted',
  ]) {
    expect(() =>
      assertAwsDatabaseTlsUrl(`postgres://user:test@db.example.test/core${suffix}`)
    ).toThrow('aws_deployment_config_invalid');
  }
  expect(() => assertAwsDatabaseTlsUrl(secret.coreDatabaseUrl)).not.toThrow();
});

it('binds secret account and region to deployment-owned environment', () => {
  const value = fixture().location;
  const environment = {
    AWS_REGION: value.region,
    AUTHRIM_AWS_ISSUER_ORIGIN: value.issuerOrigin,
    AUTHRIM_AWS_RUNTIME_SECRET_ARN: value.secretArn,
    AUTHRIM_AWS_RUNTIME_SECRET_VERSION_ID: value.secretVersionId,
    AUTHRIM_AWS_MANIFEST_BUCKET: value.bucket,
    AUTHRIM_AWS_BUCKET_OWNER: value.bucketOwner,
    AUTHRIM_AWS_MANIFEST_KEY: value.manifestKey,
    AUTHRIM_AWS_MANIFEST_VERSION_ID: value.manifestVersionId,
    AUTHRIM_AWS_MANIFEST_SHA256: value.manifestSha256,
  };
  expect(parseAwsSamlDeploymentLocation(environment)).toEqual(value);
  expect(() => parseAwsSamlDeploymentLocation({ ...environment, AWS_REGION: 'us-east-1' })).toThrow(
    'aws_deployment_config_invalid'
  );
  expect(() =>
    parseAwsSamlDeploymentLocation({ ...environment, AUTHRIM_AWS_BUCKET_OWNER: '999999999999' })
  ).toThrow('aws_deployment_config_invalid');
  for (const issuerOrigin of [
    'http://tenant-a.example.test',
    'https://tenant-a.example.test/path',
    'https://user:pass@tenant-a.example.test',
  ]) {
    expect(() =>
      parseAwsSamlDeploymentLocation({ ...environment, AUTHRIM_AWS_ISSUER_ORIGIN: issuerOrigin })
    ).toThrow('aws_deployment_config_invalid');
  }
});

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import { canonicalRestoreJson, readVerifiedAwsSamlSupplement } from './restore-evidence';
import {
  buildAwsSamlSupplementFromFrozenCapture,
  collectAwsSamlSupplementFromPinnedCapture,
  type AwsSamlFrozenSourceCapture,
} from './supplement-collector';

const TENANT = 'tenant-a';
const ORIGIN = 'https://tenant-a.example.test';
const NOW = 1_700_000_000_000;
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: TENANT, issuer: ORIGIN, productVersion: '0.4.2' },
  snapshotId: 'snapshot-a',
  boundaryUnixMs: NOW,
  inventoryDigestSha256: 'b'.repeat(64),
  selection: {
    settings: true,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 7 },
  },
  datasets: [
    {
      id: 'core.users_core',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
    {
      id: 'core.identity_accounts',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
    {
      id: 'core.passkeys',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
  ],
};

const textCell = (value: string): ['text', string] => ['text', value];
const integerCell = (value: number): ['integer', string] => ['integer', String(value)];
const nullCell = (): ['null', null] => ['null', null];

const sourceRows: Record<string, PortableSqliteRow[]> = {
  'core.users_core': [{ tenant_id: textCell(TENANT), id: textCell('user-1') }],
  'core.identity_accounts': [
    {
      tenant_id: textCell(TENANT),
      id: textCell('account:user-1'),
      account_type: textCell('user'),
      legacy_user_id: textCell('user-1'),
      lifecycle_state: textCell('active'),
      directory_publication_state: textCell('active'),
      account_route_generation: integerCell(1),
    },
  ],
  'core.passkeys': [
    {
      tenant_id: textCell(TENANT),
      id: textCell('passkey-1'),
      user_id: textCell('user-1'),
      credential_id: textCell('credential-1'),
      counter: integerCell(5),
    },
  ],
};

function backup(): VerifiedTenantBackupV2 {
  return {
    manifest,
    dataset(id) {
      const rows = sourceRows[id];
      if (!rows) throw new Error('unknown_dataset');
      return {
        id,
        rows: rows.length,
        bytes: 0,
        readNextRow: async (cursor) => {
          const index = cursor === null ? 0 : Number(cursor);
          return index < rows.length
            ? { rowJson: JSON.stringify(rows[index]), nextCursor: String(index + 1) }
            : null;
        },
      };
    },
    close: async () => undefined,
  };
}

function capture(): AwsSamlFrozenSourceCapture {
  return {
    formatVersion: 1,
    source: {
      source: manifest.source,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      boundaryUnixMs: manifest.boundaryUnixMs,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
    },
    completeness: {
      accountAuthStates: true,
      passkeyCounters: true,
      persistentNameIds: true,
      sourceLoginUi: true,
      platformDestinationProfiles: true,
      accountRoutes: true,
      platformSettings: true,
      sourceRuntimeSettings: true,
    },
    payload: {
      sourceLoginUi: {
        client: {
          tenant_id: textCell(TENANT),
          client_id: textCell('login-ui'),
          application_type: textCell('web'),
          client_secret_hash: nullCell(),
          logout_webhook_secret_encrypted: nullCell(),
          allowed_channels: textCell('["browser"]'),
        },
        origins: [
          {
            tenant_id: textCell(TENANT),
            client_id: textCell('login-ui'),
            origin: textCell(ORIGIN),
            handoff_allowed: integerCell(1),
            is_active: integerCell(1),
          },
        ],
      },
      platformDestinationProfiles: { profiles: [], versions: [] },
      state: {
        accountAuthStates: [
          {
            tenantId: TENANT,
            userId: 'user-1',
            accountId: 'account:user-1',
            lifecycle: 'active',
            lifecycleVersionMs: NOW - 2000,
            lifecycleOperationId: null,
            revokedAfterMs: null,
            lastLoginAtMs: NOW - 1000,
          },
        ],
        passkeyCounters: [
          {
            tenantId: TENANT,
            passkeyId: 'passkey-1',
            userId: 'user-1',
            credentialId: 'credential-1',
            counter: '5',
            updatedAtMs: NOW - 1000,
          },
        ],
        persistentNameIdsComplete: true,
        persistentNameIds: [],
      },
      accountRoutes: {
        'account:user-1': {
          schemaVersion: 1,
          accountRouteGeneration: 1,
          residencyPolicyId: 'default',
          targets: [
            {
              dataRole: 'tenant_core/users',
              residencyPartition: 'global',
              shardId: 'core-1',
              bindingRef: 'TEST_CORE',
              requiredBindingRouteGeneration: 1,
            },
            {
              dataRole: 'tenant_pii',
              residencyPartition: 'global',
              shardId: 'pii-1',
              bindingRef: 'TEST_PII',
              requiredBindingRouteGeneration: 1,
            },
          ],
        },
      },
      platformSettings: {},
      sourceFlowRuntimeEnabled: true,
      consentIpSalt: 'synthetic-salt-long-enough-for-collector-test',
    },
  };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('offline AWS supplement collector', () => {
  it('builds the pinned supplement envelope from a complete frozen capture', async () => {
    const result = await buildAwsSamlSupplementFromFrozenCapture({
      backup: backup(),
      capture: capture(),
    });
    expect(result.receipt).toMatchObject({
      tenantId: TENANT,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
    });
    expect(result.payload.state.receipt.supplementSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.supplementSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('writes a non-overwriting 0600 file accepted by the import reader', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'authrim-collector-')));
    directories.push(directory);
    const sourcePath = join(directory, 'source.json');
    const outputPath = join(directory, 'supplement.json');
    const source = canonicalRestoreJson(capture());
    await writeFile(sourcePath, source);
    await chmod(sourcePath, 0o600);
    const receipt = await collectAwsSamlSupplementFromPinnedCapture({
      backup: backup(),
      capturePath: sourcePath,
      expectedCaptureSha256: createHash('sha256').update(source).digest('hex'),
      outputPath,
    });
    expect(receipt).toMatchObject({
      tenantId: TENANT,
      accountAuthStates: 1,
      passkeyCounters: 1,
      persistentNameIds: 0,
    });
    expect((await readFile(outputPath, 'utf8')).length).toBeGreaterThan(0);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(
      await readVerifiedAwsSamlSupplement({
        path: outputPath,
        expectedSha256: receipt.outputSha256,
        manifest,
      })
    ).toMatchObject({ receipt: { supplementSha256: receipt.supplementSha256 } });
    await expect(
      collectAwsSamlSupplementFromPinnedCapture({
        backup: backup(),
        capturePath: sourcePath,
        expectedCaptureSha256: createHash('sha256').update(source).digest('hex'),
        outputPath,
      })
    ).rejects.toThrow('aws_supplement_collector_invalid');
    expect(
      createHash('sha256')
        .update(await readFile(outputPath))
        .digest('hex')
    ).toBe(receipt.outputSha256);
  });

  it('rejects missing capture coverage, changed snapshot and rolled-back passkey counter', async () => {
    const missing = capture();
    missing.completeness.persistentNameIds = false as never;
    await expect(
      buildAwsSamlSupplementFromFrozenCapture({ backup: backup(), capture: missing })
    ).rejects.toThrow('aws_supplement_collector_invalid');
    const otherSnapshot = capture();
    otherSnapshot.source.snapshotId = 'snapshot-b';
    await expect(
      buildAwsSamlSupplementFromFrozenCapture({ backup: backup(), capture: otherSnapshot })
    ).rejects.toThrow('aws_supplement_collector_invalid');
    const rollback = capture();
    rollback.payload.state.passkeyCounters[0].counter = '4';
    await expect(
      buildAwsSamlSupplementFromFrozenCapture({ backup: backup(), capture: rollback })
    ).rejects.toThrow('aws_supplement_collector_invalid');
  });

  it('refuses a plaintext source capture readable by another local user', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'authrim-collector-')));
    directories.push(directory);
    const sourcePath = join(directory, 'source.json');
    const source = canonicalRestoreJson(capture());
    await writeFile(sourcePath, source);
    await chmod(sourcePath, 0o644);
    await expect(
      collectAwsSamlSupplementFromPinnedCapture({
        backup: backup(),
        capturePath: sourcePath,
        expectedCaptureSha256: createHash('sha256').update(source).digest('hex'),
        outputPath: join(directory, 'supplement.json'),
      })
    ).rejects.toThrow('aws_supplement_collector_invalid');
  });
});

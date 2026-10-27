/** Full encrypted synthetic snapshot -> fresh TLS PostgreSQL generation -> pinned cold startup. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import { encodeTenantBackupContainerV2 } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import {
  SAML_DR_RUNTIME_STATE_DATASET,
  type SamlDrFrozenSourceCapture,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import { openVerifiedTenantBackupV2 } from '../import/backup-reader';
import { AWS_RUNTIME_SCHEMA_FILES } from '../import/aws-schema-bootstrap';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import type { AwsSamlCollectedSupplement } from '../import/supplement-collector';
import { generateSyntheticAwsBackup } from '../rehearsal/generate-synthetic-backup';
import type { buildBackupFiles } from '../rehearsal/synthetic-fixture';
import { loadAwsSamlDeployment, type AwsAssetReader } from '../startup/aws-assets';
import type { AwsSamlDeploymentSecrets } from '../startup/deployment-config';
import { createAwsSamlRuntime } from '../http-runtime';
import { restoreReplicationGeneration } from './restore-generation';
import type { ReplicationConfiguration, ReplicationSqlFile } from './plan';
import type { DownloadedReplicationExport } from './export-client';

const mock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({
    accessKeyId: 'synthetic-key',
    secretAccessKey: 'synthetic-secret',
  }),
}));
vi.mock('@aws-sdk/client-sts', async () => ({
  ...(await vi.importActual('@aws-sdk/client-sts')),
  STSClient: class {
    send = mock.send;
    destroy() {}
  },
}));
vi.mock('@aws-sdk/client-s3', async () => ({
  ...(await vi.importActual('@aws-sdk/client-s3')),
  S3Client: class {
    send = mock.send;
    destroy() {}
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', async () => ({
  ...(await vi.importActual('@aws-sdk/client-secrets-manager')),
  SecretsManagerClient: class {
    send = mock.send;
    destroy() {}
  },
}));
const masterUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const enabled = masterUrl && new URL(masterUrl).searchParams.get('sslmode') === 'verify-full';
const postgresIt = enabled ? it : it.skip;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Backup = Awaited<ReturnType<typeof buildBackupFiles>>['backup'];
interface Descriptor {
  backup: Omit<Backup, 'partPaths' | 'passphrase'> & { parts: { path: string }[] };
  core: { bindingRefs: string[] };
  pii: { bindingRefs: string[] };
  environmentName: string;
  spEntityIds: string[];
}
interface FixtureSecrets {
  backupPassphrase: string;
  awsFlowRuntimeHmacSecret: string;
  awsLookupReadKeys: { generation: number; secret: string }[];
}

/** Add the real embedded logical-state dataset while re-encrypting every original SQL dataset. */
async function embeddedSnapshot(
  folder: string,
  descriptor: Descriptor,
  secrets: FixtureSecrets
): Promise<DownloadedReplicationExport> {
  const original = await openVerifiedTenantBackupV2({
    ...descriptor.backup,
    partPaths: descriptor.backup.parts.map((part) => join(folder, part.path)),
    passphrase: secrets.backupPassphrase,
  });
  try {
    const supplement = JSON.parse(
      await readFile(join(folder, 'supplement.json'), 'utf8')
    ) as AwsSamlCollectedSupplement;
    const { receipt: _oldReceipt, ...state } = supplement.payload.state;
    const session = await createTenantBundleKeyEnvelope(secrets.backupPassphrase);
    const bundleId = Array.from(session.envelope.subarray(1, 17), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const manifest = {
      ...original.manifest,
      bundleId,
      snapshotId: `embedded-${randomUUID()}`,
      datasets: [...original.manifest.datasets, SAML_DR_RUNTIME_STATE_DATASET],
    };
    const capture: SamlDrFrozenSourceCapture = {
      formatVersion: 1,
      source: {
        bundleId,
        snapshotId: manifest.snapshotId,
        source: manifest.source,
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
      payload: { ...supplement.payload, state },
    };
    const encoded = await encodeTenantBackupContainerV2({
      manifest,
      session,
      datasets: (async function* () {
        for (const dataset of manifest.datasets) {
          yield {
            datasetId: dataset.id,
            chunks: (async function* () {
              if (dataset.id === SAML_DR_RUNTIME_STATE_DATASET.id) {
                yield new TextEncoder().encode(
                  `${canonicalRestoreJson({ tenant_id: ['text', manifest.source.tenantId], capture_json: ['text', canonicalRestoreJson(capture)] })}\n`
                );
                return;
              }
              const source = original.dataset(dataset.id);
              let cursor: string | null = null;
              while (true) {
                const row = await source.readNextRow(cursor);
                if (!row) break;
                yield new TextEncoder().encode(`${row.rowJson}\n`);
                cursor = row.nextCursor;
              }
            })(),
          };
        }
      })(),
    });
    const partPaths: string[] = [];
    for (const [index, part] of encoded.parts.entries()) {
      const path = join(folder, `replication-${index}.authrim2`);
      await writeFile(path, part, { flag: 'wx', mode: 0o600 });
      partPaths.push(path);
    }
    const publication = {
      formatVersion: 1 as const,
      operationId: `export-${randomUUID()}`,
      expiresAt: Date.now() + 3_600_000,
      byteCount: encoded.parts.reduce((size, part) => size + part.length, 0),
      boundaryUnixMs: manifest.boundaryUnixMs,
      receipt: {
        source: manifest.source,
        bundleId,
        snapshotId: manifest.snapshotId,
        inventoryDigestSha256: manifest.inventoryDigestSha256,
        parts: encoded.parts.map((part) => ({ size: part.length, sha256: hash(part) })),
      },
      selection: manifest.selection,
      datasets: manifest.datasets,
    };
    const publicationPath = join(folder, 'publication.json');
    await writeFile(publicationPath, canonicalRestoreJson(publication), {
      flag: 'wx',
      mode: 0o600,
    });
    return {
      publication,
      partPaths,
      publicationPath,
      publicationSha256: restoreEvidenceDigest(publication),
    };
  } finally {
    await original.close();
  }
}

postgresIt(
  'restores two isolated generations with TLS, cold-loads pinned publication, and rejects corrupt input before allocation',
  { timeout: 180_000 },
  async () => {
    if (!masterUrl) throw new Error('local_test_database_required');
    const url = new URL(masterUrl);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('local_test_database_required');
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-replication-restore-'));
    const generated = join(directory, 'source');
    const prefix = `rtest_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const generations = [randomUUID(), randomUUID(), randomUUID()];
    const admin = new Client({ connectionString: masterUrl });
    const objects = new Map<string, Uint8Array>();
    const secretValues = new Map<string, string>();
    const secretArns = new Map<string, string>();
    const noExternal = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('external_network_forbidden');
    });
    let loaded: Awaited<ReturnType<typeof loadAwsSamlDeployment>> | undefined;
    await admin.connect();
    try {
      expect(
        (
          await admin.query<{ ssl: boolean }>(
            'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
          )
        ).rows
      ).toEqual([{ ssl: true }]);
      const summary = await generateSyntheticAwsBackup({
        databaseUrl: masterUrl,
        directory: generated,
        migrationDirectory: fileURLToPath(new URL('../../../../migrations/', import.meta.url)),
      });
      const descriptor = JSON.parse(
        await readFile(join(generated, 'fixture.json'), 'utf8')
      ) as Descriptor;
      const secrets = JSON.parse(
        await readFile(join(generated, 'secrets.json'), 'utf8')
      ) as FixtureSecrets;
      const snapshot = await embeddedSnapshot(generated, descriptor, secrets);
      const pins = async (
        directory: URL,
        names?: readonly string[]
      ): Promise<ReplicationSqlFile[]> =>
        Promise.all(
          (
            names ?? (await readdir(directory)).filter((name) => /^\d+.*\.sql$/u.test(name)).sort()
          ).map(async (name) => {
            const path = fileURLToPath(new URL(name, directory));
            return { path, sha256: hash(await readFile(path)) };
          })
        );
      const configuration: ReplicationConfiguration = {
        formatVersion: 1,
        pair: {
          pairId: 'pair-a',
          tenantId: summary.tenantId,
          deployments: [
            { deploymentId: 'cf-a', provider: 'cloudflare' },
            { deploymentId: 'aws-a', provider: 'aws' },
          ],
          initialOwnerDeploymentId: 'cf-a',
          initialGenerationId: 'initial-a',
        },
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'aws-a',
        expectedEpoch: 1,
        maxSnapshotAgeMs: 3_600_000,
        authority: {
          endpoint: 'https://authority.example.test/replication/v1/rpc',
          credentialId: 'controller-a',
          secretEnv: 'CONTROL_SECRET',
          databaseUrlEnv: 'CONTROL_DB',
        },
        source: {
          kind: 'cloudflare',
          managementOrigin: summary.issuer,
          grantId: 'grant-a',
          credentialEnv: 'EXPORT_SECRET',
          passphraseEnv: 'BACKUP_SECRET',
          identity: snapshot.publication.receipt.source,
        },
        destination: {
          kind: 'aws',
          sql: 'postgresql',
          environmentName: descriptor.environmentName,
          masterUrlEnv: 'MASTER_DB',
          credentialSeedEnv: 'GENERATION_SEED',
          databasePrefix: prefix,
          coreBindingRefs: descriptor.core.bindingRefs,
          piiBindingRefs: descriptor.pii.bindingRefs,
          spEntityIds: descriptor.spEntityIds,
          allocationScope: 'shared_pool',
          flowHmacSecretEnv: 'FLOW_SECRET',
          lookupReadKeys: [{ generation: 1, secretEnv: 'LOOKUP_SECRET' }],
          ui: {
            components: { loginUi: false, adminUi: false },
            ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
          },
          authState: { backend: 'postgresql' },
          writerCredentialId: 'aws-writer',
          writerSecretEnv: 'WRITER_SECRET',
          artifacts: {
            region: 'ap-northeast-1',
            bucket: 'replication-synthetic-test',
            bucketOwner: '123456789012',
            keyPrefix: 'generations',
            secretNamePrefix: 'replication-secrets',
            kmsKeyArn:
              'arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
          },
          schemas: {
            core: await pins(new URL('../../../../migrations/core/postgresql/', import.meta.url)),
            pii: await pins(new URL('../../../../migrations/pii/postgresql/', import.meta.url)),
            state: await pins(new URL('../storage/', import.meta.url), AWS_RUNTIME_SCHEMA_FILES),
          },
        },
      };
      const environment = {
        MASTER_DB: masterUrl,
        GENERATION_SEED: 's'.repeat(64),
        BACKUP_SECRET: secrets.backupPassphrase,
        FLOW_SECRET: secrets.awsFlowRuntimeHmacSecret,
        LOOKUP_SECRET: secrets.awsLookupReadKeys[0].secret,
        WRITER_SECRET: 'a'.repeat(64),
      };
      mock.send.mockImplementation(
        async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const input = command.input;
          switch (command.constructor.name) {
            case 'GetCallerIdentityCommand':
              return { Account: '123456789012' };
            case 'GetBucketVersioningCommand':
              return { Status: 'Enabled' };
            case 'PutObjectCommand': {
              if (
                typeof input.Key !== 'string' ||
                !(input.Body instanceof Uint8Array) ||
                objects.has(input.Key)
              )
                throw new Error('unexpected_object_write');
              expect(input.IfNoneMatch).toBe('*');
              objects.set(input.Key, Uint8Array.from(input.Body));
              return { VersionId: hash(input.Body) };
            }
            case 'CreateSecretCommand': {
              if (
                typeof input.ClientRequestToken !== 'string' ||
                typeof input.SecretString !== 'string' ||
                typeof input.Name !== 'string'
              )
                throw new Error('unexpected_secret_write');
              const arn = `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:${input.Name}-AbCdEf`;
              secretValues.set(input.ClientRequestToken, input.SecretString);
              secretArns.set(input.ClientRequestToken, arn);
              return { ARN: arn, VersionId: input.ClientRequestToken, Name: input.Name };
            }
            default:
              throw new Error('unexpected_aws_api');
          }
        }
      );
      const reader: AwsAssetReader = {
        async getObject(input) {
          const bytes = objects.get(input.key);
          if (!bytes || input.versionId !== hash(bytes)) throw new Error('object_pin_mismatch');
          return {
            versionId: input.versionId,
            size: bytes.length,
            body: (async function* () {
              yield bytes;
            })(),
            close() {},
          };
        },
        async getSecret(input) {
          return {
            arn: secretArns.get(input.versionId),
            versionId: input.versionId,
            value: secretValues.get(input.versionId),
          };
        },
        close() {},
      };
      const first = await restoreReplicationGeneration({
        configuration,
        environment,
        snapshot,
        generationId: generations[0],
        servingEpoch: 2,
      });
      loaded = await loadAwsSamlDeployment({ location: first.generation.location, reader });
      await loaded.runtime.assertReady();
      expect(loaded.runtime.env.AUTHRIM_REPLICATION_WRITER_SECRET).toBe(environment.WRITER_SECRET);
      expect(JSON.parse(loaded.runtime.env.AUTHRIM_REPLICATION_WRITER ?? '')).toMatchObject({
        epoch: 2,
        generationId: generations[0],
        tenantId: summary.tenantId,
      });
      const runtime = createAwsSamlRuntime({ tenants: [loaded.runtime] });
      expect((await runtime.app.request(`${summary.issuer}/health/ready`)).status).toBe(200);
      await loaded.close();
      loaded = undefined;
      const firstSecrets = JSON.parse(
        secretValues.get(generations[0]) ?? ''
      ) as AwsSamlDeploymentSecrets;
      for (const [connectionString, table] of [
        [firstSecrets.piiDatabaseUrl, 'users_pii'],
        [firstSecrets.stateDatabaseUrl, 'authrim_aws_passkey_counters'],
        [firstSecrets.stateDatabaseUrl, 'authrim_aws_restore_activations'],
      ]) {
        const database = new Client({ connectionString });
        await database.connect();
        try {
          expect(
            (
              await database.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id=$1`,
                [summary.tenantId]
              )
            ).rows
          ).toEqual([{ count: '1' }]);
        } finally {
          await database.end();
        }
      }
      const firstCore = new Client({ connectionString: firstSecrets.coreDatabaseUrl });
      await firstCore.connect();
      try {
        const originalUsers = (
          await firstCore.query('SELECT id,tenant_id FROM users_core ORDER BY id')
        ).rows;
        expect(originalUsers).toHaveLength(1);
        const firstManifest = new TextDecoder().decode(
          objects.get(first.generation.location.manifestKey)
        );
        const environmentWriter = {
          version: 2 as const,
          endpoint: configuration.authority.endpoint,
          credentialId: configuration.destination.writerCredentialId,
          pairId: configuration.pair.pairId,
          environmentId: 'logical-source-environment',
          deploymentId: configuration.destinationDeploymentId,
          generationId: 'aggregate-generation-independent',
          epoch: 2,
          tenantId: summary.tenantId,
          restoreId: generations[1],
        };
        const second = await restoreReplicationGeneration({
          configuration,
          environment,
          snapshot,
          generationId: generations[1],
          servingEpoch: 2,
          environmentWriter,
        });
        loaded = await loadAwsSamlDeployment({ location: second.generation.location, reader });
        await loaded.runtime.assertReady();
        expect(JSON.parse(loaded.runtime.env.AUTHRIM_REPLICATION_WRITER ?? '')).toEqual(
          environmentWriter
        );
        expect(environmentWriter.generationId).not.toBe(environmentWriter.restoreId);
        expect(loaded.runtime.env.AUTHRIM_ENVIRONMENT_NAME).toBe(
          configuration.destination.environmentName
        );
        expect(loaded.runtime.env.AUTHRIM_REPLICATION_WRITER_SECRET).toBe(
          environment.WRITER_SECRET
        );
        await loaded.close();
        loaded = undefined;
        expect(second.generation.generationId).not.toBe(first.generation.generationId);
        expect(
          (await firstCore.query('SELECT id,tenant_id FROM users_core ORDER BY id')).rows
        ).toEqual(originalUsers);
        expect(new TextDecoder().decode(objects.get(first.generation.location.manifestKey))).toBe(
          firstManifest
        );
        const secondSecrets = JSON.parse(
          secretValues.get(generations[1]) ?? ''
        ) as AwsSamlDeploymentSecrets;
        expect(secondSecrets.coreDatabaseUrl).not.toBe(firstSecrets.coreDatabaseUrl);
        const beforeRepeat = mock.send.mock.calls.length;
        await expect(
          restoreReplicationGeneration({
            configuration,
            environment,
            snapshot,
            generationId: generations[0],
            servingEpoch: 2,
          })
        ).rejects.toThrow('aws_supplement_collector_invalid');
        expect(mock.send.mock.calls).toHaveLength(beforeRepeat);
        expect(
          (await firstCore.query('SELECT id,tenant_id FROM users_core ORDER BY id')).rows
        ).toEqual(originalUsers);
        const beforeBad = mock.send.mock.calls.length;
        const corrupt = {
          ...snapshot,
          publication: {
            ...snapshot.publication,
            receipt: {
              ...snapshot.publication.receipt,
              parts: snapshot.publication.receipt.parts.map((part) => ({
                ...part,
                sha256: 'f'.repeat(64),
              })),
            },
          },
        };
        await expect(
          restoreReplicationGeneration({
            configuration,
            environment,
            snapshot: corrupt,
            generationId: generations[2],
            servingEpoch: 2,
          })
        ).rejects.toThrow();
        expect(mock.send.mock.calls).toHaveLength(beforeBad);
        expect(
          (
            await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [
              ['core', 'pii', 'state'].map(
                (family) => `${prefix}_${generations[2].replaceAll('-', '')}_${family}`
              ),
            ])
          ).rows
        ).toEqual([]);
      } finally {
        await firstCore.end();
      }
      expect(noExternal).not.toHaveBeenCalled();
    } finally {
      await loaded?.close();
      for (const generation of generations)
        for (const family of ['core', 'pii', 'state']) {
          const name = `${prefix}_${generation.replaceAll('-', '')}_${family}`;
          await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          await admin.query(`DROP ROLE IF EXISTS "${name}"`);
        }
      await admin.end();
      noExternal.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

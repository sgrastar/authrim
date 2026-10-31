import { createHmac } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { renderPortableMigrationSql } from '../../../ar-lib-core/src/migrations/sql-portability';
import { openVerifiedTenantBackupV2 } from '../import/backup-reader';
import { assertPostgresBackupProjectionSupported } from '../import/postgres-restore';
import { collectAwsSamlSupplementFromBackup } from '../import/supplement-collector';
import { restoreOfflineAwsSamlTenant } from '../import/restore-offline';
import { readPinnedRestoreFile, restoreEvidenceDigest } from '../import/restore-evidence';
import {
  initializeMaintenanceDatabases,
  withMaintenanceLock,
  type DatabaseFamily,
  type MaintenanceDatabase,
} from '../maintenance/database';
import {
  assertAwsDatabaseTlsUrl,
  type AwsSamlDeploymentSecrets,
} from '../startup/deployment-config';
import type { ReplicationConfiguration } from './plan';
import { replicationSecret } from './plan';
import type { DownloadedReplicationExport } from './export-client';
import { publishReplicationGeneration } from './publish-generation';
import {
  parseReplicationWriterConfiguration,
  type EnvironmentReplicationWriterConfiguration,
} from '@authrim/ar-lib-core/services/deployment-replication/writer';

/** Allocate and verify a new generation. No source, prior generation or serving database is altered. */
export async function restoreReplicationGeneration(input: {
  configuration: ReplicationConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
  snapshot: DownloadedReplicationExport;
  generationId: string;
  servingEpoch: number;
  environmentWriter?: EnvironmentReplicationWriterConfiguration;
}) {
  const config = input.configuration;
  const target = config.destination;
  const secret = (name: string) => replicationSecret(input.environment, name);
  const generationId = input.generationId;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(generationId))
    throw new Error('replication_generation_invalid');
  const writer = input.environmentWriter
    ? parseReplicationWriterConfiguration(JSON.stringify(input.environmentWriter))
    : {
        version: 1 as const,
        endpoint: config.authority.endpoint,
        credentialId: target.writerCredentialId,
        pairId: config.pair.pairId,
        tenantId: config.pair.tenantId,
        deploymentId: config.destinationDeploymentId,
        generationId,
        epoch: input.servingEpoch,
      };
  if (
    writer.pairId !== config.pair.pairId ||
    writer.endpoint !== config.authority.endpoint ||
    writer.credentialId !== target.writerCredentialId ||
    writer.deploymentId !== config.destinationDeploymentId ||
    writer.tenantId !== config.pair.tenantId ||
    writer.epoch !== input.servingEpoch ||
    (input.environmentWriter && (writer.version !== 2 || writer.restoreId !== generationId))
  )
    throw new Error('replication_generation_invalid');
  const masterUrl = secret(target.masterUrlEnv);
  assertAwsDatabaseTlsUrl(masterUrl);
  const seed = secret(target.credentialSeedEnv);
  if (seed.length < 32 || seed.length > 4096)
    throw new Error('replication_generation_credentials_invalid');
  const databases = {} as Record<DatabaseFamily, MaintenanceDatabase>;
  for (const family of ['core', 'pii', 'state'] as const) {
    const name = `${target.databasePrefix}_${generationId.replaceAll('-', '')}_${family}`;
    const password = createHmac('sha256', seed)
      .update(`authrim-replication-db-v1:${config.pair.pairId}:${generationId}:${family}`)
      .digest('base64url');
    const url = new URL(masterUrl);
    url.pathname = `/${name}`;
    url.username = name;
    url.password = password;
    databases[family] = { name, user: name, password, connectionString: url.toString() };
  }
  const migrations = {} as Parameters<typeof initializeMaintenanceDatabases>[0]['migrations'];
  for (const family of ['core', 'pii', 'state'] as const) {
    const files = target.schemas[family];
    const sources = await Promise.all(
      files.map(async (file) => {
        const bytes = await readPinnedRestoreFile(file.path, file.sha256, 16 * 1024 * 1024);
        const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
        return family === 'state' ? sql : renderPortableMigrationSql(sql, 'postgres');
      })
    );
    migrations[family] = {
      digest: restoreEvidenceDigest(files),
      files: files.map((file) => file.path),
      sql: `${sources.map((sql) => `SET search_path TO public;\n${sql}`).join('\n')}\nSET search_path TO public;`,
    };
  }
  const publication = input.snapshot.publication;
  const backupInput = {
    partPaths: input.snapshot.partPaths,
    receipt: publication.receipt,
    selection: publication.selection,
    datasets: publication.datasets,
    maxSnapshotAgeMs: config.maxSnapshotAgeMs,
    passphrase: secret(config.source.passphraseEnv),
  };
  // Validate the complete artifact before creating a single target resource.
  const backup = await openVerifiedTenantBackupV2(backupInput);
  let supplement;
  try {
    assertPostgresBackupProjectionSupported(backup);
    supplement = await collectAwsSamlSupplementFromBackup({
      backup,
      outputPath: join(dirname(input.snapshot.publicationPath), `supplement-${generationId}.json`),
    });
  } finally {
    await backup.close();
  }
  await withMaintenanceLock(masterUrl, generationId, (master) =>
    initializeMaintenanceDatabases({
      master,
      initializationId: generationId,
      databases,
      migrations,
    })
  );
  const authState =
    target.authState.backend === 'dynamodb'
      ? { ...target.authState, namespace: generationId }
      : target.authState;
  const coreTargetId = createHmac('sha256', generationId).update('core').digest('hex').slice(0, 32);
  const piiTargetId = createHmac('sha256', generationId).update('pii').digest('hex').slice(0, 32);
  const uuid = (hex: string) =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const restoreInput = {
    backup: backupInput,
    supplement: { path: supplement.outputPath, expectedSha256: supplement.outputSha256 },
    restoreId: generationId,
    core: {
      connectionString: databases.core.connectionString,
      targetId: uuid(coreTargetId),
      bindingRefs: target.coreBindingRefs,
    },
    pii: {
      connectionString: databases.pii.connectionString,
      targetId: uuid(piiTargetId),
      bindingRefs: target.piiBindingRefs,
    },
    state: { connectionString: databases.state.connectionString, initializeEmptySchema: false },
    authState,
    environmentName: target.environmentName,
    destinationUi: target.ui,
    spEntityIds: target.spEntityIds,
    allocationScope: target.allocationScope,
    awsFlowRuntimeHmacSecret: secret(target.flowHmacSecretEnv),
    awsLookupReadKeys: target.lookupReadKeys.map((key) => ({
      generation: key.generation,
      secret: secret(key.secretEnv),
    })),
  };
  const restored = await restoreOfflineAwsSamlTenant(restoreInput);
  try {
    await restored.runtime.assertReady();
    const runtimeSecrets: AwsSamlDeploymentSecrets = {
      formatVersion: 1,
      tenantId: config.pair.tenantId,
      backupPassphrase: backupInput.passphrase,
      coreDatabaseUrl: databases.core.connectionString,
      piiDatabaseUrl: databases.pii.connectionString,
      stateDatabaseUrl: databases.state.connectionString,
      flowHmacSecret: restoreInput.awsFlowRuntimeHmacSecret,
      lookupReadKeys: restoreInput.awsLookupReadKeys,
      replicationWriterSecret: secret(target.writerSecretEnv),
    };
    const generation = await publishReplicationGeneration({
      configuration: config,
      generationId,
      epoch: input.servingEpoch,
      manifest: {
        formatVersion: 1,
        evidence: restored.evidence,
        backup: {
          receipt: publication.receipt,
          selection: publication.selection,
          datasets: publication.datasets,
          maxSnapshotAgeMs: config.maxSnapshotAgeMs,
        },
        core: { targetId: restoreInput.core.targetId, bindingRefs: target.coreBindingRefs },
        pii: { targetId: restoreInput.pii.targetId, bindingRefs: target.piiBindingRefs },
        environmentName: target.environmentName,
        destinationUi: target.ui,
        authState,
        spEntityIds: target.spEntityIds,
        allocationScope: target.allocationScope,
        replicationWriter: writer,
      },
      secrets: runtimeSecrets,
      parts: input.snapshot.partPaths.map((path, index) => ({
        path,
        ...publication.receipt.parts[index],
      })),
      supplement: {
        path: supplement.outputPath,
        sha256: supplement.outputSha256,
        size: (await stat(supplement.outputPath)).size,
      },
    });
    return { generation, verificationSha256: restoreEvidenceDigest(restored.evidence) };
  } finally {
    await restored.close();
  }
}

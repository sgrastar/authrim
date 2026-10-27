import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { TenantPortableSourceIdentity } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import {
  assertDeploymentPairDefinition,
  type DeploymentPairDefinition,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import {
  assertReplicationIdentifier,
  replicationEndpoint,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { normalizeAwsRuntimeUiConfig, type AwsRuntimeUiConfig } from '../ui/runtime-ui-config';
import { normalizeAwsAuthStateConfig } from '../storage/auth-state-config';
import {
  canonicalRestoreJson,
  readPinnedRestoreFile,
  restoreEvidenceDigest,
} from '../import/restore-evidence';
import {
  readReplicationAuthoritySchema,
  assertReplicationAuthorityBootstrapRoles,
} from './initialize';

export interface ReplicationSqlFile {
  path: string;
  sha256: string;
}
export interface ReplicationConfiguration {
  formatVersion: 1;
  /** Separate, explicit approval of a previously verified standby and its maximum data-loss age. */
  failover?: { standbyStatePath: string; standbyStateSha256: string; maximumSnapshotAgeMs: number };
  pair: DeploymentPairDefinition;
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  expectedEpoch: number;
  maxSnapshotAgeMs: number;
  authority: {
    endpoint: string;
    credentialId: string;
    secretEnv: string;
    databaseUrlEnv: string;
    bootstrap?: { databaseUrlEnv: string; serviceRole: string; journalRole: string };
  };
  source: {
    kind: 'cloudflare';
    managementOrigin: string;
    grantId: string;
    credentialEnv: string;
    passphraseEnv: string;
    identity: TenantPortableSourceIdentity;
  };
  destination: {
    kind: 'aws';
    sql: 'postgresql';
    environmentName: string;
    masterUrlEnv: string;
    credentialSeedEnv: string;
    databasePrefix: string;
    coreBindingRefs: string[];
    piiBindingRefs: string[];
    spEntityIds: string[];
    allocationScope: 'shared_pool' | 'tenant_exclusive';
    flowHmacSecretEnv: string;
    lookupReadKeys: { generation: number; secretEnv: string }[];
    ui: AwsRuntimeUiConfig;
    authState:
      | { backend: 'postgresql' }
      | { backend: 'dynamodb'; region: string; tableArn: string };
    writerCredentialId: string;
    writerSecretEnv: string;
    artifacts: {
      region: string;
      bucket: string;
      bucketOwner: string;
      keyPrefix: string;
      kmsKeyArn: string;
      secretNamePrefix: string;
    };
    /** Exact fresh-install SQL files in execution order, supplied by the setup release plan. */
    schemas: Record<'core' | 'pii' | 'state', ReplicationSqlFile[]>;
  };
}
export interface ReplicationPlan {
  formatVersion: 1;
  planId: string;
  createdAtMs: number;
  executorSha256: string;
  authoritySchemaSha256: string;
  configuration: ReplicationConfiguration;
}

function invalid(): never {
  throw new Error('replication_plan_invalid');
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    invalid();
}
function secretName(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) invalid();
}
function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) invalid();
}
function strings(values: unknown, max: number): asserts values is string[] {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > max ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        value.length > 2048 ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    )
  )
    invalid();
}

export function parseReplicationConfiguration(raw: unknown): ReplicationConfiguration {
  try {
    exact(raw, [
      'formatVersion',
      ...(raw && typeof raw === 'object' && Object.hasOwn(raw, 'failover') ? ['failover'] : []),
      'pair',
      'sourceDeploymentId',
      'destinationDeploymentId',
      'expectedEpoch',
      'maxSnapshotAgeMs',
      'authority',
      'source',
      'destination',
    ]);
    const value = raw as unknown as ReplicationConfiguration;
    if (value.failover !== undefined) {
      exact(value.failover, ['standbyStatePath', 'standbyStateSha256', 'maximumSnapshotAgeMs']);
      if (
        !isAbsolute(value.failover.standbyStatePath) ||
        !/^[a-f0-9]{64}$/u.test(value.failover.standbyStateSha256) ||
        !Number.isSafeInteger(value.failover.maximumSnapshotAgeMs) ||
        value.failover.maximumSnapshotAgeMs < 1000 ||
        value.failover.maximumSnapshotAgeMs > 30 * 86400_000
      )
        invalid();
    }
    if (
      value.formatVersion !== 1 ||
      !Number.isSafeInteger(value.expectedEpoch) ||
      value.expectedEpoch < 1 ||
      !Number.isSafeInteger(value.maxSnapshotAgeMs) ||
      value.maxSnapshotAgeMs < 1000 ||
      value.maxSnapshotAgeMs > 30 * 86400_000
    )
      invalid();
    assertDeploymentPairDefinition(value.pair);
    assertReplicationIdentifier(value.sourceDeploymentId);
    assertReplicationIdentifier(value.destinationDeploymentId);
    if (
      value.sourceDeploymentId === value.destinationDeploymentId ||
      !value.pair.deployments.some(
        (item) => item.deploymentId === value.sourceDeploymentId && item.provider === 'cloudflare'
      ) ||
      !value.pair.deployments.some(
        (item) => item.deploymentId === value.destinationDeploymentId && item.provider === 'aws'
      )
    )
      invalid();
    exact(value.authority, [
      'endpoint',
      'credentialId',
      'secretEnv',
      'databaseUrlEnv',
      ...(value.authority && Object.hasOwn(value.authority, 'bootstrap') ? ['bootstrap'] : []),
    ]);
    if (value.authority.bootstrap !== undefined) {
      exact(value.authority.bootstrap, ['databaseUrlEnv', 'serviceRole', 'journalRole']);
      const bootstrap = value.authority.bootstrap;
      secretName(bootstrap.databaseUrlEnv);
      assertReplicationAuthorityBootstrapRoles({
        serviceRole: bootstrap.serviceRole,
        journalRole: bootstrap.journalRole,
      });
      if (bootstrap.databaseUrlEnv === value.authority.databaseUrlEnv) invalid();
    }
    replicationEndpoint(value.authority.endpoint);
    assertReplicationIdentifier(value.authority.credentialId);
    secretName(value.authority.secretEnv);
    secretName(value.authority.databaseUrlEnv);
    exact(value.source, [
      'kind',
      'managementOrigin',
      'grantId',
      'credentialEnv',
      'passphraseEnv',
      'identity',
    ]);
    exact(value.source.identity, ['tenantId', 'issuer', 'productVersion']);
    if (
      value.source.kind !== 'cloudflare' ||
      value.source.identity.tenantId !== value.pair.tenantId ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value.source.identity.productVersion)
    )
      invalid();
    origin(value.source.managementOrigin);
    origin(value.source.identity.issuer);
    assertReplicationIdentifier(value.source.grantId);
    secretName(value.source.credentialEnv);
    secretName(value.source.passphraseEnv);
    const target = value.destination;
    exact(target, [
      'kind',
      'sql',
      'environmentName',
      'masterUrlEnv',
      'credentialSeedEnv',
      'databasePrefix',
      'coreBindingRefs',
      'piiBindingRefs',
      'spEntityIds',
      'allocationScope',
      'flowHmacSecretEnv',
      'lookupReadKeys',
      'ui',
      'authState',
      'writerCredentialId',
      'writerSecretEnv',
      'artifacts',
      'schemas',
    ]);
    if (
      target.kind !== 'aws' ||
      target.sql !== 'postgresql' ||
      !/^[a-z][a-z0-9_]{0,18}$/u.test(target.databasePrefix) ||
      !['shared_pool', 'tenant_exclusive'].includes(target.allocationScope)
    )
      invalid();
    assertReplicationIdentifier(target.environmentName);
    assertReplicationIdentifier(target.writerCredentialId);
    for (const name of [
      target.masterUrlEnv,
      target.credentialSeedEnv,
      target.flowHmacSecretEnv,
      target.writerSecretEnv,
    ])
      secretName(name);
    strings(target.coreBindingRefs, 1024);
    strings(target.piiBindingRefs, 1024);
    strings(target.spEntityIds, 1000);
    normalizeAwsRuntimeUiConfig(target.ui);
    if (
      !Array.isArray(target.lookupReadKeys) ||
      target.lookupReadKeys.length < 1 ||
      target.lookupReadKeys.length > 2
    )
      invalid();
    for (const key of target.lookupReadKeys) {
      exact(key, ['generation', 'secretEnv']);
      if (!Number.isSafeInteger(key.generation) || key.generation < 1) invalid();
      secretName(key.secretEnv);
    }
    if (
      new Set(target.lookupReadKeys.map((key) => key.generation)).size !==
      target.lookupReadKeys.length
    )
      invalid();
    exact(target.artifacts, [
      'region',
      'bucket',
      'bucketOwner',
      'keyPrefix',
      'kmsKeyArn',
      'secretNamePrefix',
    ]);
    const artifacts = target.artifacts;
    if (
      !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(artifacts.region) ||
      !/^\d{12}$/u.test(artifacts.bucketOwner) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(artifacts.bucket) ||
      /\.\.|\.-|-\./u.test(artifacts.bucket) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/u.test(artifacts.keyPrefix) ||
      artifacts.keyPrefix.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/u.test(
        artifacts.secretNamePrefix
      ) ||
      artifacts.secretNamePrefix.length > 128 ||
      !new RegExp(
        `^arn:aws:kms:${artifacts.region}:${artifacts.bucketOwner}:key/[a-f0-9-]{36}$`,
        'u'
      ).test(artifacts.kmsKeyArn)
    )
      invalid();
    if (target.authState.backend === 'postgresql') exact(target.authState, ['backend']);
    else {
      exact(target.authState, ['backend', 'region', 'tableArn']);
      normalizeAwsAuthStateConfig(
        { ...target.authState, namespace: '11111111-1111-4111-8111-111111111111' },
        { accountId: artifacts.bucketOwner, region: artifacts.region }
      );
    }
    exact(target.schemas, ['core', 'pii', 'state']);
    for (const files of Object.values(target.schemas)) {
      if (!Array.isArray(files) || files.length < 1 || files.length > 1024) invalid();
      for (const file of files) {
        exact(file, ['path', 'sha256']);
        if (
          !isAbsolute(file.path) ||
          !file.path.endsWith('.sql') ||
          !/^[a-f0-9]{64}$/u.test(file.sha256)
        )
          invalid();
      }
      if (new Set(files.map((file) => file.path)).size !== files.length) invalid();
    }
    return structuredClone(value);
  } catch {
    return invalid();
  }
}

export async function createReplicationPlan(
  configuration: unknown,
  executorSha256: string,
  now = Date.now()
): Promise<ReplicationPlan> {
  const value = parseReplicationConfiguration(configuration);
  if (value.failover)
    await readPinnedRestoreFile(
      value.failover.standbyStatePath,
      value.failover.standbyStateSha256,
      8 * 1024 * 1024
    );
  // Planning is local-only. Pin all executable SQL before credentials or remote services are used.
  await Promise.all(
    Object.values(value.destination.schemas)
      .flat()
      .map((file) => readPinnedRestoreFile(file.path, file.sha256, 16 * 1024 * 1024))
  );
  if (!Number.isSafeInteger(now) || now < 1) invalid();
  if (!/^[a-f0-9]{64}$/u.test(executorSha256)) invalid();
  return {
    formatVersion: 1,
    planId: randomUUID(),
    createdAtMs: now,
    executorSha256,
    authoritySchemaSha256: (await readReplicationAuthoritySchema()).digest,
    configuration: value,
  };
}

export function parseReplicationPlan(
  raw: string,
  expectedExecutorSha256?: string
): ReplicationPlan {
  try {
    const value = JSON.parse(raw) as ReplicationPlan;
    exact(value, [
      'formatVersion',
      'planId',
      'createdAtMs',
      'executorSha256',
      'authoritySchemaSha256',
      'configuration',
    ]);
    if (
      value.formatVersion !== 1 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.planId) ||
      !Number.isSafeInteger(value.createdAtMs) ||
      value.createdAtMs < 1 ||
      !/^[a-f0-9]{64}$/u.test(value.executorSha256) ||
      !/^[a-f0-9]{64}$/u.test(value.authoritySchemaSha256) ||
      (expectedExecutorSha256 !== undefined && value.executorSha256 !== expectedExecutorSha256) ||
      canonicalRestoreJson(value) !== raw
    )
      invalid();
    value.configuration = parseReplicationConfiguration(value.configuration);
    return value;
  } catch {
    return invalid();
  }
}

export function replicationPlanDigest(plan: ReplicationPlan): string {
  return restoreEvidenceDigest(plan);
}
export function replicationSecret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  secretName(name);
  const value = environment[name];
  if (!value) throw new Error('replication_credentials_missing');
  return value;
}

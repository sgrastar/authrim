import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { assertDeploymentPairDefinition } from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { assertReplicationIdentifier } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import {
  createReplicationPlan,
  parseReplicationConfiguration,
  type ReplicationConfiguration,
} from './plan';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';

/** A complete environment is the unit of promotion; child configurations never promote alone. */
export interface EnvironmentReplicationConfiguration {
  formatVersion: 2;
  pair: {
    pairId: string;
    environmentId: string;
    deployments: ReplicationConfiguration['pair']['deployments'];
    initialOwnerDeploymentId: string;
    initialGenerationId: string;
  };
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  expectedEpoch: number;
  maxSnapshotAgeMs: number;
  authority: ReplicationConfiguration['authority'];
  inventory: {
    managementOrigin: string;
    grantId: string;
    credentialEnv: string;
    ownerTenantId: string;
  };
  /** Every non-deleted source tenant must appear exactly once. Unknown tenants stop the run. */
  tenants: ReplicationConfiguration[];
  failover?: NonNullable<ReplicationConfiguration['failover']>;
}

export interface EnvironmentReplicationPlan {
  formatVersion: 2;
  planId: string;
  createdAtMs: number;
  executorSha256: string;
  authoritySchemaSha256: string;
  configuration: EnvironmentReplicationConfiguration;
}

function invalid(): never {
  throw new Error('environment_replication_plan_invalid');
}

function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    invalid();
}

export function parseEnvironmentReplicationConfiguration(
  raw: unknown
): EnvironmentReplicationConfiguration {
  try {
    const optional = raw && typeof raw === 'object' && Object.hasOwn(raw, 'failover');
    exact(raw, [
      'formatVersion',
      'pair',
      'sourceDeploymentId',
      'destinationDeploymentId',
      'expectedEpoch',
      'maxSnapshotAgeMs',
      'authority',
      'inventory',
      'tenants',
      ...(optional ? ['failover'] : []),
    ]);
    const value = raw as unknown as EnvironmentReplicationConfiguration;
    if (value.formatVersion !== 2) invalid();
    exact(value.pair, [
      'pairId',
      'environmentId',
      'deployments',
      'initialOwnerDeploymentId',
      'initialGenerationId',
    ]);
    assertReplicationIdentifier(value.pair.environmentId);
    // Reuse identifier/provider validation only. The stored/wire scope remains environmentId.
    const { environmentId, ...definition } = value.pair;
    assertDeploymentPairDefinition({ ...definition, tenantId: environmentId });
    exact(value.inventory, ['managementOrigin', 'grantId', 'credentialEnv', 'ownerTenantId']);
    const origin = new URL(value.inventory.managementOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== value.inventory.managementOrigin)
      invalid();
    assertReplicationIdentifier(value.inventory.grantId);
    assertReplicationIdentifier(value.inventory.ownerTenantId);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(value.inventory.credentialEnv)) invalid();
    if (!Array.isArray(value.tenants) || value.tenants.length < 1 || value.tenants.length > 16)
      invalid();
    const ids = new Set<string>();
    const issuers = new Set<string>();
    let storage: string | undefined;
    let writer: string | undefined;
    const tenants = value.tenants.map((input) => {
      const child = parseReplicationConfiguration(input);
      const { tenantId, ...childDefinition } = child.pair;
      if (
        child.failover ||
        ids.has(tenantId) ||
        issuers.has(child.source.identity.issuer) ||
        canonicalRestoreJson(childDefinition) !== canonicalRestoreJson(definition) ||
        child.sourceDeploymentId !== value.sourceDeploymentId ||
        child.destinationDeploymentId !== value.destinationDeploymentId ||
        child.expectedEpoch !== value.expectedEpoch ||
        child.maxSnapshotAgeMs !== value.maxSnapshotAgeMs ||
        canonicalRestoreJson(child.authority) !== canonicalRestoreJson(value.authority)
      )
        invalid();
      ids.add(tenantId);
      issuers.add(child.source.identity.issuer);
      const location = canonicalRestoreJson({
        region: child.destination.artifacts.region,
        bucket: child.destination.artifacts.bucket,
        bucketOwner: child.destination.artifacts.bucketOwner,
        kmsKeyArn: child.destination.artifacts.kmsKeyArn,
        masterUrlEnv: child.destination.masterUrlEnv,
      });
      const credential = canonicalRestoreJson({
        credentialId: child.destination.writerCredentialId,
        secretEnv: child.destination.writerSecretEnv,
      });
      if (
        (storage !== undefined && storage !== location) ||
        (writer !== undefined && writer !== credential)
      )
        invalid();
      storage = location;
      writer = credential;
      return child;
    });
    if (value.failover) {
      exact(value.failover, ['standbyStatePath', 'standbyStateSha256', 'maximumSnapshotAgeMs']);
      if (
        !isAbsolute(value.failover.standbyStatePath) ||
        resolve(value.failover.standbyStatePath) !== value.failover.standbyStatePath ||
        !/^[a-f0-9]{64}$/u.test(value.failover.standbyStateSha256) ||
        !Number.isSafeInteger(value.failover.maximumSnapshotAgeMs) ||
        value.failover.maximumSnapshotAgeMs < 1000 ||
        value.failover.maximumSnapshotAgeMs > 30 * 86400_000
      )
        invalid();
    }
    if (tenants.map((tenant) => tenant.pair.tenantId).join('\0') !== [...ids].sort().join('\0'))
      invalid();
    return structuredClone({ ...value, tenants });
  } catch {
    return invalid();
  }
}

export async function createEnvironmentReplicationPlan(
  raw: unknown,
  executorSha256: string,
  now = Date.now()
): Promise<EnvironmentReplicationPlan> {
  const configuration = parseEnvironmentReplicationConfiguration(raw);
  if (!/^[a-f0-9]{64}$/u.test(executorSha256) || !Number.isSafeInteger(now) || now < 0) invalid();
  // Reuse the exact per-child SQL pin check; no DB/provider calls or child operations are started.
  const checked = await Promise.all(
    configuration.tenants.map((child) => createReplicationPlan(child, executorSha256, now))
  );
  if (new Set(checked.map((child) => child.authoritySchemaSha256)).size !== 1) invalid();
  return {
    formatVersion: 2,
    planId: randomUUID(),
    createdAtMs: now,
    executorSha256,
    authoritySchemaSha256: checked[0].authoritySchemaSha256,
    configuration,
  };
}

export function parseEnvironmentReplicationPlan(
  raw: string,
  expectedExecutorSha256?: string
): EnvironmentReplicationPlan {
  try {
    const value: unknown = JSON.parse(raw);
    exact(value, [
      'formatVersion',
      'planId',
      'createdAtMs',
      'executorSha256',
      'authoritySchemaSha256',
      'configuration',
    ]);
    const plan = value as unknown as EnvironmentReplicationPlan;
    if (
      plan.formatVersion !== 2 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(plan.planId) ||
      !Number.isSafeInteger(plan.createdAtMs) ||
      plan.createdAtMs < 0 ||
      !/^[a-f0-9]{64}$/u.test(plan.executorSha256) ||
      !/^[a-f0-9]{64}$/u.test(plan.authoritySchemaSha256) ||
      (expectedExecutorSha256 !== undefined && plan.executorSha256 !== expectedExecutorSha256)
    )
      invalid();
    const configuration = parseEnvironmentReplicationConfiguration(plan.configuration);
    const normalized = { ...plan, configuration };
    if (canonicalRestoreJson(normalized) !== raw) invalid();
    return normalized;
  } catch {
    return invalid();
  }
}

export const environmentReplicationPlanDigest = (plan: EnvironmentReplicationPlan): string =>
  restoreEvidenceDigest(plan);

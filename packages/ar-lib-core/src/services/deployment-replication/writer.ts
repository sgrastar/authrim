import type { DeploymentWritePermit } from './authority';
import type { EnvironmentWritePermit } from './environment-authority';
import { runWithReplicationWriteEffects } from './write-effects';
import {
  assertReplicationIdentifier,
  createReplicationRpcClient,
  replicationCanonicalJson,
  replicationEndpoint,
} from './transport';

export interface TenantReplicationWriterConfiguration {
  version: 1;
  endpoint: string;
  credentialId: string;
  pairId: string;
  tenantId: string;
  deploymentId: string;
  epoch: number;
  generationId: string;
}

export interface EnvironmentReplicationWriterConfiguration {
  version: 2;
  endpoint: string;
  credentialId: string;
  pairId: string;
  environmentId: string;
  deploymentId: string;
  epoch: number;
  generationId: string;
  /** Required together for restored serving children; omitted only by the original CF environment. */
  tenantId?: string;
  restoreId?: string;
}
export type ReplicationWriterConfiguration =
  | TenantReplicationWriterConfiguration
  | EnvironmentReplicationWriterConfiguration;

export interface ReplicationWriterEnv {
  /** Public, deployment-owned JSON. Absence preserves the standalone runtime. */
  AUTHRIM_REPLICATION_WRITER?: string;
  /** A separately provisioned 32-byte hex secret, scoped to this deployment by the authority. */
  AUTHRIM_REPLICATION_WRITER_SECRET?: string;
}

export function hasReplicationWriterConfiguration(env: ReplicationWriterEnv): boolean {
  return (
    env.AUTHRIM_REPLICATION_WRITER !== undefined ||
    env.AUTHRIM_REPLICATION_WRITER_SECRET !== undefined
  );
}

export function parseReplicationWriterConfiguration(raw: string): ReplicationWriterConfiguration {
  try {
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error();
    const value = JSON.parse(raw) as ReplicationWriterConfiguration;
    if (
      !value ||
      Object.keys(value).sort().join(',') !==
        (value.version === 1
          ? 'credentialId,deploymentId,endpoint,epoch,generationId,pairId,tenantId,version'
          : value.version === 2 && value.tenantId === undefined && value.restoreId === undefined
            ? 'credentialId,deploymentId,endpoint,environmentId,epoch,generationId,pairId,version'
            : 'credentialId,deploymentId,endpoint,environmentId,epoch,generationId,pairId,restoreId,tenantId,version') ||
      ![1, 2].includes(value.version) ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 1
    )
      throw new Error();
    for (const id of [
      value.credentialId,
      value.pairId,
      value.version === 1 ? value.tenantId : value.environmentId,
      value.deploymentId,
      value.generationId,
    ])
      assertReplicationIdentifier(id);
    if (value.version === 2 && (value.tenantId !== undefined || value.restoreId !== undefined)) {
      assertReplicationIdentifier(value.tenantId);
      assertReplicationIdentifier(value.restoreId);
    }
    replicationEndpoint(value.endpoint);
    return value;
  } catch {
    throw new Error('replication_writer_configuration_invalid');
  }
}

/**
 * The caller must await all request-owned storage effects inside `run`. If the process dies or
 * loses the completion response, the non-expiring permit remains and promotion stays blocked.
 * Neither wall-clock timeout nor an unreachable former primary can manufacture completion.
 */
export async function runReplicationWriterOperation<T>(
  env: ReplicationWriterEnv,
  run: () => Promise<T>
): Promise<T> {
  if (!hasReplicationWriterConfiguration(env)) return run();
  const config = parseReplicationWriterConfiguration(env.AUTHRIM_REPLICATION_WRITER ?? '');
  const rpc = createReplicationRpcClient({
    endpoint: config.endpoint,
    credentialId: config.credentialId,
    secret: env.AUTHRIM_REPLICATION_WRITER_SECRET ?? '',
  });
  const permitId = crypto.randomUUID();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(permitId));
  const permit: DeploymentWritePermit | EnvironmentWritePermit = {
    pairId: config.pairId,
    ...(config.version === 1
      ? { tenantId: config.tenantId }
      : {
          environmentId: config.environmentId,
          ...(config.tenantId === undefined
            ? {}
            : { tenantId: config.tenantId, restoreId: config.restoreId }),
        }),
    deploymentId: config.deploymentId,
    epoch: config.epoch,
    generationId: config.generationId,
    permitId,
    operationDigest: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  };
  // No write runs unless the authority returned exactly the requested pinned permit.
  const admitted = await rpc(config.version === 1 ? 'enter' : 'environmentEnter', permit);
  if (replicationCanonicalJson(admitted) !== replicationCanonicalJson(permit))
    throw new Error('replication_admission_invalid');
  const result = await runWithReplicationWriteEffects(run);
  // An exception can mean an unconfirmed remote commit. Keep its permit until recovery can
  // establish the result; a settled rejected promise is not evidence of a rolled-back write.
  if (result instanceof Response && result.status >= 500)
    throw new Error('replication_writer_outcome_unknown');
  await rpc(config.version === 1 ? 'complete' : 'environmentComplete', permit);
  return result;
}

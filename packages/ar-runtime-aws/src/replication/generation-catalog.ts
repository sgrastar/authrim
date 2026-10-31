import type { Pool } from 'pg';
import {
  assertReplicationIdentifier,
  replicationCanonicalJson,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import {
  parseAwsSamlDeploymentLocation,
  type AwsSamlDeploymentLocation,
} from '../startup/deployment-config';

export interface ReplicationGenerationLocation {
  pairId: string;
  tenantId: string;
  deploymentId: string;
  generationId: string;
  epoch: number;
  location: AwsSamlDeploymentLocation;
}

export interface ReplicationGenerationCatalog {
  register(input: ReplicationGenerationLocation): Promise<void>;
  get(
    input: Omit<ReplicationGenerationLocation, 'location'>
  ): Promise<ReplicationGenerationLocation>;
}

export function assertReplicationGenerationLocation(value: ReplicationGenerationLocation): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'deploymentId,epoch,generationId,location,pairId,tenantId'
  )
    throw new Error('replication_generation_invalid');
  for (const field of [value.pairId, value.tenantId, value.deploymentId, value.generationId])
    assertReplicationIdentifier(field);
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 1)
    throw new Error('replication_generation_invalid');
  const location = value.location;
  const normalized = parseAwsSamlDeploymentLocation({
    AWS_REGION: location.region,
    AUTHRIM_AWS_ISSUER_ORIGIN: location.issuerOrigin,
    AUTHRIM_AWS_RUNTIME_SECRET_ARN: location.secretArn,
    AUTHRIM_AWS_RUNTIME_SECRET_VERSION_ID: location.secretVersionId,
    AUTHRIM_AWS_MANIFEST_BUCKET: location.bucket,
    AUTHRIM_AWS_BUCKET_OWNER: location.bucketOwner,
    AUTHRIM_AWS_MANIFEST_KEY: location.manifestKey,
    AUTHRIM_AWS_MANIFEST_VERSION_ID: location.manifestVersionId,
    AUTHRIM_AWS_MANIFEST_SHA256: location.manifestSha256,
  });
  if (replicationCanonicalJson(normalized) !== replicationCanonicalJson(location))
    throw new Error('replication_generation_invalid');
}

/** Immutable location pins only. Actual database credentials stay in Secrets Manager. */
export class PostgresReplicationGenerationCatalog implements ReplicationGenerationCatalog {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async register(input: ReplicationGenerationLocation): Promise<void> {
    assertReplicationGenerationLocation(input);
    const pinned = structuredClone(input);
    const serialized = replicationCanonicalJson(pinned);
    const result = await this.pool.query<{ location_json: string }>(
      `INSERT INTO authrim_replication_generation_locations
       (pair_id,tenant_id,deployment_id,generation_id,epoch,location_json)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (pair_id,generation_id) DO UPDATE
       SET location_json=authrim_replication_generation_locations.location_json
       RETURNING location_json`,
      [
        pinned.pairId,
        pinned.tenantId,
        pinned.deploymentId,
        pinned.generationId,
        pinned.epoch,
        serialized,
      ]
    );
    if (result.rows.length !== 1 || result.rows[0].location_json !== serialized)
      throw new Error('replication_generation_conflict');
  }

  async get(
    input: Omit<ReplicationGenerationLocation, 'location'>
  ): Promise<ReplicationGenerationLocation> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'deploymentId,epoch,generationId,pairId,tenantId'
    )
      throw new Error('replication_generation_invalid');
    for (const id of [input.pairId, input.tenantId, input.deploymentId, input.generationId])
      assertReplicationIdentifier(id);
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 1)
      throw new Error('replication_generation_invalid');
    const result = await this.pool.query<{ location_json: string }>(
      `SELECT location_json FROM authrim_replication_generation_locations
       WHERE pair_id=$1 AND tenant_id=$2 AND deployment_id=$3 AND generation_id=$4 AND epoch=$5`,
      [input.pairId, input.tenantId, input.deploymentId, input.generationId, input.epoch]
    );
    if (result.rows.length !== 1) throw new Error('replication_generation_unavailable');
    const value = JSON.parse(result.rows[0].location_json) as ReplicationGenerationLocation;
    assertReplicationGenerationLocation(value);
    const { location: _location, ...identity } = value;
    if (replicationCanonicalJson(identity) !== replicationCanonicalJson(input))
      throw new Error('replication_generation_invalid');
    return value;
  }
}

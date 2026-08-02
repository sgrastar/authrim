import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  executeD1Batch,
  putR2Object,
  type D1BatchExecutionResult,
  type D1BatchStatement,
} from './cloudflare.js';
import {
  ReleaseMigrationManifestSchema,
  streamDirectory,
  type ReleaseMigrationManifest,
} from './release-migrations.js';
import { renderPortableMigrationSql } from './sql-portability.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SQL_OBJECT_BYTES = 1024 * 1024;
const MAX_STREAM_SQL_BYTES = 16 * 1024 * 1024;
const MAX_STREAMS = 32;
const MAX_FILES_PER_STREAM = 512;
const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_RELEASE_ID = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u;
const SAFE_STREAM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export interface MigrationReleaseArtifactObject {
  objectKey: string;
  bytes: Uint8Array;
  contentType: 'application/json' | 'application/sql';
}

export interface MigrationReleaseArtifactPlan {
  releaseId: string;
  manifestDigest: string;
  manifestObjectKey: string;
  streamIds: string[];
  objects: MigrationReleaseArtifactObject[];
}

export interface MigrationReleaseCatalogPlan {
  operationId: string;
  statements: D1BatchStatement[];
  streamIds: string[];
}

type D1BatchExecutor = (
  databaseId: string,
  batch: readonly D1BatchStatement[]
) => Promise<D1BatchExecutionResult[]>;

type R2ObjectUploader = typeof putR2Object;
type Sleep = (milliseconds: number) => Promise<void>;

const CATALOG_MAX_ATTEMPTS = 4;

function isRetryableCatalogError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/cloudflare_d1_batch_failed:(\d{3})$/u);
  if (!statusMatch) return true;
  const status = Number.parseInt(statusMatch[1]!, 10);
  return status === 408 || status === 429 || status >= 500;
}

async function executeCatalogWithRetry(input: {
  execute: D1BatchExecutor;
  databaseId: string;
  statements: readonly D1BatchStatement[];
  onProgress?: (message: string) => void;
  sleep: Sleep;
}): Promise<D1BatchExecutionResult[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CATALOG_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await input.execute(input.databaseId, input.statements);
    } catch (error) {
      lastError = error;
      if (attempt === CATALOG_MAX_ATTEMPTS || !isRetryableCatalogError(error)) throw error;
      const delayMs = 1_000 * 2 ** (attempt - 1);
      input.onProgress?.(
        `Retrying migration release catalog (${attempt + 1}/${CATALOG_MAX_ATTEMPTS})`
      );
      await input.sleep(delayMs);
    }
  }
  throw lastError;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeManifest(bytes: Uint8Array): ReleaseMigrationManifest {
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new Error('migration_release_manifest_invalid');
  }
  return ReleaseMigrationManifestSchema.parse(parsed);
}

function validateActor(actorId: string): void {
  if (
    actorId.length === 0 ||
    actorId.length > 200 ||
    Array.from(actorId).some((character) => character.charCodeAt(0) < 0x20)
  ) {
    throw new Error('migration_release_actor_invalid');
  }
}

export function buildMigrationReleaseArtifactPlan(input: {
  migrationsRoot: string;
  manifestPath: string;
}): MigrationReleaseArtifactPlan {
  const manifestBuffer = readFileSync(input.manifestPath);
  if (manifestBuffer.byteLength === 0 || manifestBuffer.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('migration_release_manifest_size_invalid');
  }
  const manifestBytes = new Uint8Array(manifestBuffer);
  const manifest = decodeManifest(manifestBytes);
  if (manifest.streams.length > MAX_STREAMS) {
    throw new Error('migration_release_stream_limit_exceeded');
  }
  const manifestDigest = sha256(manifestBytes);
  const releaseId =
    basename(input.manifestPath) === 'release-manifest.draft.json'
      ? `${manifest.productVersion}-draft.${manifestDigest.slice(0, 12)}`
      : manifest.productVersion;
  if (!SAFE_RELEASE_ID.test(releaseId)) throw new Error('migration_release_id_invalid');
  const objectRoot = `releases/${releaseId}/${manifestDigest}`;
  const manifestObjectKey = `${objectRoot}/manifest.json`;
  const objects: MigrationReleaseArtifactObject[] = [];
  const streamIds: string[] = [];

  for (const stream of manifest.streams) {
    if (stream.dialect !== 'sqlite' || stream.files.length === 0) continue;
    if (stream.files.length > MAX_FILES_PER_STREAM) {
      throw new Error(`migration_release_file_limit_exceeded:${stream.id}`);
    }
    const directory = streamDirectory(input.migrationsRoot, stream.id);
    if (!directory) throw new Error(`migration_release_stream_unknown:${stream.id}`);
    let streamBytes = 0;
    for (const file of stream.files) {
      const rendered = renderPortableMigrationSql(
        readFileSync(join(directory, file.path), 'utf8'),
        stream.dialect
      );
      const bytes = new TextEncoder().encode(rendered);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_SQL_OBJECT_BYTES) {
        throw new Error(`migration_release_sql_size_invalid:${stream.id}:${file.path}`);
      }
      streamBytes += bytes.byteLength;
      if (streamBytes > MAX_STREAM_SQL_BYTES) {
        throw new Error(`migration_release_stream_size_exceeded:${stream.id}`);
      }
      if (sha256(bytes) !== file.checksum) {
        throw new Error(`migration_release_sql_checksum_mismatch:${stream.id}:${file.path}`);
      }
      objects.push({
        objectKey: `${objectRoot}/streams/${stream.id}/${file.path}`,
        bytes,
        contentType: 'application/sql',
      });
    }
    streamIds.push(stream.id);
  }
  if (streamIds.length === 0) throw new Error('migration_release_sqlite_stream_required');
  objects.push({
    objectKey: manifestObjectKey,
    bytes: manifestBytes,
    contentType: 'application/json',
  });

  return {
    releaseId,
    manifestDigest,
    manifestObjectKey,
    streamIds,
    objects,
  };
}

export function buildMigrationReleaseCatalogPlan(input: {
  environmentId: string;
  artifact: MigrationReleaseArtifactPlan;
  actorId: string;
  now?: number;
}): MigrationReleaseCatalogPlan {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('migration_release_environment_invalid');
  }
  if (!SAFE_DIGEST.test(input.artifact.manifestDigest)) {
    throw new Error('migration_release_digest_invalid');
  }
  if (!SAFE_RELEASE_ID.test(input.artifact.releaseId)) {
    throw new Error('migration_release_id_invalid');
  }
  const expectedObjectKey = `releases/${input.artifact.releaseId}/${input.artifact.manifestDigest}/manifest.json`;
  if (input.artifact.manifestObjectKey !== expectedObjectKey) {
    throw new Error('migration_release_object_key_invalid');
  }
  validateActor(input.actorId);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('migration_release_time_invalid');
  const streamIds = [...new Set(input.artifact.streamIds)].sort();
  if (
    streamIds.length === 0 ||
    streamIds.length !== input.artifact.streamIds.length ||
    streamIds.some((streamId) => !SAFE_STREAM_ID.test(streamId))
  ) {
    throw new Error('migration_release_streams_invalid');
  }
  const operationDigest = sha256(
    `${input.environmentId}\0${input.artifact.releaseId}\0${input.artifact.manifestDigest}\0${input.artifact.manifestObjectKey}`
  );
  const operationId = `op_release_${operationDigest.slice(0, 32)}`;
  const statements: D1BatchStatement[] = [
    {
      sql: `INSERT OR IGNORE INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'creating', ?, ?)`,
      params: [
        input.environmentId,
        input.environmentId,
        `urn:authrim:control:${input.environmentId}`,
        now,
        now,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, created_at, completed_at, updated_at
      ) VALUES (?, ?, 'register_migration_release', ?, 'succeeded', 'setup', ?, 1, ?, ?, ?)`,
      params: [
        operationId,
        input.environmentId,
        `migration-release:${input.artifact.releaseId}:${input.artifact.manifestDigest}`,
        input.actorId,
        now,
        now,
        now,
      ],
    },
  ];

  for (const streamId of streamIds) {
    statements.push(
      {
        sql: `INSERT OR IGNORE INTO control_migration_release_catalog (
          environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
          state, active_stream_key, registered_by_operation_id, registered_by_actor_id,
          registered_at, activated_at
        ) VALUES (?, ?, ?, ?, ?, 'registered', 'release:' || ?, ?, ?, ?, NULL)`,
        params: [
          input.environmentId,
          streamId,
          input.artifact.releaseId,
          input.artifact.manifestDigest,
          input.artifact.manifestObjectKey,
          input.artifact.releaseId,
          operationId,
          input.actorId,
          now,
        ],
      },
      {
        sql: `UPDATE control_migration_release_catalog
          SET state = 'retired', active_stream_key = 'release:' || release_id
          WHERE environment_id = ? AND stream_id = ? AND state = 'active'
            AND NOT (
              release_id = ? AND manifest_digest = ? AND manifest_r2_object_key = ?
            )`,
        params: [
          input.environmentId,
          streamId,
          input.artifact.releaseId,
          input.artifact.manifestDigest,
          input.artifact.manifestObjectKey,
        ],
      },
      {
        sql: `UPDATE control_migration_release_catalog
          SET state = 'active', active_stream_key = 'active', activated_at = ?
          WHERE environment_id = ? AND stream_id = ? AND release_id = ?
            AND manifest_digest = ? AND manifest_r2_object_key = ?`,
        params: [
          now,
          input.environmentId,
          streamId,
          input.artifact.releaseId,
          input.artifact.manifestDigest,
          input.artifact.manifestObjectKey,
        ],
      }
    );
  }

  statements.push(
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
        event_id, environment_id, operation_id, event_type, actor_type, actor_id,
        resource_kind, resource_id, outcome, redacted_payload_json, created_at
      ) VALUES (?, ?, ?, 'control.migration_release.activated', 'setup', ?,
        'migration_release', ?, 'succeeded', ?, ?)`,
      params: [
        `audit:${operationId}`,
        input.environmentId,
        operationId,
        input.actorId,
        input.artifact.releaseId,
        JSON.stringify({
          manifest_digest: input.artifact.manifestDigest,
          manifest_object_key: input.artifact.manifestObjectKey,
          streams: streamIds,
        }),
        now,
      ],
    },
    {
      sql: `SELECT catalog.stream_id, catalog.release_id, catalog.manifest_digest,
                   catalog.manifest_r2_object_key, catalog.state,
                   environment.environment_id, environment.issuer
        FROM control_migration_release_catalog catalog
        JOIN control_environments environment
          ON environment.environment_id = catalog.environment_id
        WHERE catalog.environment_id = ?
          AND catalog.stream_id IN (${streamIds.map(() => '?').join(', ')})
          AND catalog.state = 'active'
        ORDER BY catalog.stream_id`,
      params: [input.environmentId, ...streamIds],
    }
  );
  return { operationId, statements, streamIds };
}

function verifyActiveCatalogRows(
  result: D1BatchExecutionResult | undefined,
  plan: MigrationReleaseCatalogPlan,
  artifact: MigrationReleaseArtifactPlan,
  environmentId: string
): void {
  if (
    !result ||
    !Array.isArray(result.results) ||
    result.results.length !== plan.streamIds.length
  ) {
    throw new Error('migration_release_catalog_verification_failed');
  }
  for (let index = 0; index < plan.streamIds.length; index += 1) {
    const row = result.results[index];
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      (row as Record<string, unknown>).stream_id !== plan.streamIds[index] ||
      (row as Record<string, unknown>).release_id !== artifact.releaseId ||
      (row as Record<string, unknown>).manifest_digest !== artifact.manifestDigest ||
      (row as Record<string, unknown>).manifest_r2_object_key !== artifact.manifestObjectKey ||
      (row as Record<string, unknown>).state !== 'active' ||
      (row as Record<string, unknown>).environment_id !== environmentId ||
      (row as Record<string, unknown>).issuer !== `urn:authrim:control:${environmentId}`
    ) {
      throw new Error('migration_release_catalog_verification_failed');
    }
  }
}

export async function publishAndActivateMigrationRelease(input: {
  migrationsRoot: string;
  manifestPath: string;
  bucketName: string;
  controlDatabaseId: string;
  environmentId: string;
  actorId: string;
  now?: number;
  upload?: R2ObjectUploader;
  executeBatch?: D1BatchExecutor;
  sleep?: Sleep;
  onProgress?: (message: string) => void;
}): Promise<{ artifact: MigrationReleaseArtifactPlan; operationId: string }> {
  const artifact = buildMigrationReleaseArtifactPlan(input);
  const upload = input.upload ?? putR2Object;
  for (const object of artifact.objects) {
    input.onProgress?.(`Uploading ${object.objectKey}`);
    await upload({
      bucketName: input.bucketName,
      objectKey: object.objectKey,
      bytes: object.bytes,
      contentType: object.contentType,
    });
  }
  const catalog = buildMigrationReleaseCatalogPlan({
    environmentId: input.environmentId,
    artifact,
    actorId: input.actorId,
    now: input.now,
  });
  const results = await executeCatalogWithRetry({
    execute: input.executeBatch ?? executeD1Batch,
    databaseId: input.controlDatabaseId,
    statements: catalog.statements,
    onProgress: input.onProgress,
    sleep:
      input.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  });
  verifyActiveCatalogRows(results.at(-1), catalog, artifact, input.environmentId);
  return { artifact, operationId: catalog.operationId };
}

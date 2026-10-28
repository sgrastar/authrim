import type { WorkerComponent } from './naming.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  LOG_ARCHIVE_IMPLEMENTED_MODES,
  LOG_ARCHIVE_PRODUCER_COMPONENTS as SHARED_LOG_ARCHIVE_PRODUCER_COMPONENTS,
  LOG_ARCHIVE_SCHEMA_VERSION,
} from '@authrim/ar-lib-logging/iceberg/capabilities';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
export const LOG_ARCHIVE_MAINTENANCE_POLICY_DIGEST = createHash('sha256')
  .update(
    JSON.stringify({
      owner: 'authrim',
      version: 2,
      providerCompaction: { state: 'enabled', targetSizeMb: 64 },
      providerSnapshotExpiration: 'disabled',
      authrimRetention: 'dataset-policy-with-pending-and-dr-pins',
    })
  )
  .digest('hex');
const shared = {
  storageGeneration: z.guid(),
  objectEncryptionKeyVersion: z.number().int().positive().default(1),
  activatedAt: z.iso
    .datetime()
    .refine(
      (value) => new Date(value).toISOString() === value,
      'Log archive activation must be a canonical ISO timestamp'
    ),
  schemaVersion: z.number().int().positive(),
  maintenancePolicyDigest: z
    .literal(LOG_ARCHIVE_MAINTENANCE_POLICY_DIGEST)
    .default(LOG_ARCHIVE_MAINTENANCE_POLICY_DIGEST),
  bucketName: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u),
  namespace: identifier,
  tableName: identifier,
};

export const LogArchiveProbeAttemptSchema = z
  .object({
    attemptId: z.guid(),
    startedAt: z.iso.datetime(),
    deploymentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type LogArchiveProbeAttempt = z.infer<typeof LogArchiveProbeAttemptSchema>;
export const LogArchiveRuntimeProofSchema = LogArchiveProbeAttemptSchema.extend({
  state: z.literal('ready'),
  mode: z.enum(['pipeline', 'scheduled']),
  generation: z.guid(),
  schemaVersion: z.number().int().positive(),
  keyVersion: z.number().int().positive(),
  tableUuid: z.guid(),
  physicalFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  eventId: z.string().max(128),
  snapshotId: z.string().regex(/^[0-9]+$/u),
  checkedAt: z.iso.datetime(),
}).strict();
export type LogArchiveRuntimeProof = z.infer<typeof LogArchiveRuntimeProofSchema>;

/** Missing selection is a wizard draft only; provisioning requires an explicit mode. */
export const LogArchiveConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('pipeline'), ...shared }).strict(),
  z
    .object({
      mode: z.literal('scheduled'),
      ...shared,
      dbRetentionDays: z.number().int().min(1).max(3650),
      exportIntervalMinutes: z.number().int().min(1).max(1440),
    })
    .strict(),
]);

export const LoggingConfigSchema = z.object({ archive: LogArchiveConfigSchema }).strict();
export type LogArchiveConfig = z.infer<typeof LogArchiveConfigSchema>;
export type LogArchiveMode = LogArchiveConfig['mode'];

export function implementedLogArchiveModes(): readonly LogArchiveMode[] {
  return LOG_ARCHIVE_IMPLEMENTED_MODES as readonly LogArchiveMode[];
}

export function assertLogArchiveImplemented(archive: LogArchiveConfig | undefined): void {
  if (!archive) throw new Error('log_archive_mode_required');
  if (archive.schemaVersion !== LOG_ARCHIVE_SCHEMA_VERSION) {
    throw new Error('log_archive_schema_version_not_supported');
  }
  if (!implementedLogArchiveModes().includes(archive.mode)) {
    throw new Error(`log_archive_mode_not_implemented:${archive.mode}`);
  }
}

export function createLogArchiveConfig(
  environment: string,
  mode: LogArchiveMode,
  options: { dbRetentionDays?: number; exportIntervalMinutes?: number } = {}
): LogArchiveConfig {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(environment)) {
    throw new Error('log_archive_environment_invalid');
  }
  const storageGeneration = randomUUID();
  return LogArchiveConfigSchema.parse({
    mode,
    storageGeneration,
    activatedAt: new Date().toISOString(),
    schemaVersion: LOG_ARCHIVE_SCHEMA_VERSION,
    bucketName: `${environment}-log-archive`,
    namespace: 'authrim',
    tableName: `logs_v${LOG_ARCHIVE_SCHEMA_VERSION}_${storageGeneration.replaceAll('-', '')}`,
    ...(mode === 'scheduled'
      ? {
          dbRetentionDays: options.dbRetentionDays ?? 7,
          exportIntervalMinutes: options.exportIntervalMinutes ?? 5,
        }
      : {}),
  });
}

export const LogArchiveResourceSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .strict();
export const LogArchiveLockSchema = z
  .object({
    mode: z.enum(['pipeline', 'scheduled']),
    storageGeneration: z.guid(),
    activatedAt: z.iso.datetime(),
    schemaVersion: z.number().int().positive(),
    schemaDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    accountId: z.string().regex(/^[a-f0-9]{32}$/u),
    bucketName: z.string().min(3),
    namespace: identifier,
    tableName: identifier,
    catalogUri: z.url(),
    warehouse: z.string().min(1),
    catalog: LogArchiveResourceSchema,
    activation: z
      .object({
        basis: z.literal('new_owned_empty_table'),
        tableUuid: z.guid(),
        schemaId: z.number().int().nonnegative(),
        specId: z.number().int().nonnegative(),
        schemaSpecFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        metadataLocation: z.string().min(1),
        checkedAt: z.iso.datetime(),
        runtimeProof: LogArchiveRuntimeProofSchema.optional(),
        pendingRuntimeProbe: LogArchiveProbeAttemptSchema.optional(),
      })
      .strict(),
    maintenance: z
      .object({
        policyDigest: z.literal(LOG_ARCHIVE_MAINTENANCE_POLICY_DIGEST),
        snapshotExpirationState: z.literal('disabled'),
        compactionState: z.literal('enabled'),
        compactionTargetSizeMb: z.literal(64),
        compactionNextEligibleAt: z.iso.datetime().nullable().optional(),
        nextEligibleAt: z.null(),
        inFlightJobs: z.enum(['unverified', 'verified_idle']),
      })
      .strict(),
    stream: LogArchiveResourceSchema.optional(),
    sink: LogArchiveResourceSchema.optional(),
    pipeline: LogArchiveResourceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.catalogUri !==
        `https://catalog.cloudflarestorage.com/${value.accountId}/${value.bucketName}` ||
      value.warehouse !== `${value.accountId}_${value.bucketName}` ||
      value.catalog.name !== value.warehouse
    ) {
      context.addIssue({ code: 'custom', message: 'log_archive_catalog_identity_mismatch' });
    }
    if (!value.bucketName.endsWith('-log-archive'))
      context.addIssue({ code: 'custom', message: 'log_archive_bucket_identity_invalid' });
    if (value.mode === 'pipeline') {
      const environment = value.bucketName.slice(0, -'-log-archive'.length);
      const stem = `${environment.replaceAll('-', '_')}_logs_${value.storageGeneration.replaceAll('-', '')}`;
      for (const kind of ['stream', 'sink', 'pipeline'] as const)
        if (value[kind]?.name !== `${stem}_${kind}`)
          context.addIssue({ code: 'custom', message: 'log_archive_resource_name_mismatch' });
    }
    const proof = value.activation.runtimeProof;
    if (
      proof &&
      (proof.mode !== value.mode ||
        proof.generation !== value.storageGeneration ||
        proof.schemaVersion !== value.schemaVersion ||
        proof.tableUuid !== value.activation.tableUuid ||
        proof.physicalFingerprint !== value.activation.schemaSpecFingerprint)
    )
      context.addIssue({ code: 'custom', message: 'log_archive_runtime_proof_identity_mismatch' });
    const resources = [value.stream, value.sink, value.pipeline];
    if (value.mode === 'scheduled' && resources.some(Boolean)) {
      context.addIssue({
        code: 'custom',
        message: 'scheduled_log_archive_cannot_have_pipeline_resources',
      });
    }
    if (value.mode === 'pipeline' && resources.some((resource) => !resource)) {
      context.addIssue({ code: 'custom', message: 'pipeline_log_archive_resources_incomplete' });
    }
  });
export type LogArchiveLock = z.infer<typeof LogArchiveLockSchema>;

/** Prevent accidental mode switches, copied locks, and credentials redirected to another catalog. */
export function assertLogArchiveLockMatches(
  archive: LogArchiveConfig,
  resource: LogArchiveLock | undefined,
  expectedAccountId?: string
): asserts resource is LogArchiveLock {
  if (
    !resource ||
    !LogArchiveLockSchema.safeParse(resource).success ||
    resource.mode !== archive.mode ||
    resource.storageGeneration !== archive.storageGeneration ||
    resource.activatedAt !== archive.activatedAt ||
    resource.schemaVersion !== archive.schemaVersion ||
    resource.bucketName !== archive.bucketName ||
    resource.namespace !== archive.namespace ||
    resource.tableName !== archive.tableName ||
    resource.maintenance.policyDigest !== archive.maintenancePolicyDigest ||
    (expectedAccountId && resource.accountId !== expectedAccountId)
  )
    throw new Error('log_archive_resource_configuration_mismatch');
}

export const LOG_ARCHIVE_PRODUCER_COMPONENTS: readonly WorkerComponent[] =
  SHARED_LOG_ARCHIVE_PRODUCER_COMPONENTS;

/** One identity projection is shared by generation, deploy gates and artifact validation. */
export function logArchiveRuntimeVars(
  archive: LogArchiveConfig,
  locked: LogArchiveLock
): Record<string, string> {
  assertLogArchiveLockMatches(archive, locked);
  return {
    OBJECT_ENCRYPTION_KEY_VERSION: String(archive.objectEncryptionKeyVersion),
    AUTHRIM_LOG_ARCHIVE_MODE: archive.mode,
    AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: archive.storageGeneration,
    AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: archive.activatedAt,
    AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: String(archive.schemaVersion),
    AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: locked.accountId,
    AUTHRIM_LOG_ARCHIVE_BUCKET: locked.bucketName,
    AUTHRIM_LOG_ARCHIVE_CATALOG_URI: locked.catalogUri,
    AUTHRIM_LOG_ARCHIVE_WAREHOUSE: locked.warehouse,
    AUTHRIM_LOG_ARCHIVE_NAMESPACE: archive.namespace,
    AUTHRIM_LOG_ARCHIVE_TABLE: archive.tableName,
    AUTHRIM_LOG_ARCHIVE_TABLE_UUID: locked.activation.tableUuid,
    AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: locked.activation.schemaSpecFingerprint,
    ...(archive.mode === 'scheduled'
      ? {
          AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: String(archive.dbRetentionDays),
          AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: String(archive.exportIntervalMinutes),
        }
      : {}),
  };
}

/** Local development has real encrypted scheduled staging, with no remote archive witness. */
export function localLogArchiveRuntimeVars(archive: LogArchiveConfig): Record<string, string> {
  if (archive.mode !== 'scheduled') throw new Error('local_log_archive_requires_scheduled');
  return {
    AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY: 'true',
    AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
    AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: archive.storageGeneration,
    AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: String(archive.schemaVersion),
    AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: archive.activatedAt,
    OBJECT_ENCRYPTION_KEY_VERSION: String(archive.objectEncryptionKeyVersion),
    AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: String(archive.dbRetentionDays),
    AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: String(archive.exportIntervalMinutes),
  };
}

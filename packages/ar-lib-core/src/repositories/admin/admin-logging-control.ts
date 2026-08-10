import { createLoggingId } from '@authrim/ar-lib-logging/contract';
import {
  buildLogChunkManifestObjectKey,
  detectLogCatalogRepairFindings,
  executeSafeLogCatalogRepairs,
  type LogCatalogRepairFinding,
  type LogCatalogRepairManifestRow,
  type LogCatalogRepairObjectRow,
} from '@authrim/ar-lib-logging/chunks';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';

export interface AdminLoggingCriticalDestinationRow {
  id: string;
  name: string;
  display_name: string;
  provider: string;
  lifecycle_status: string;
  health_status: string;
  critical_allowed: number;
  default_fallback_eligible: number;
  last_health_check_at: number | string | null;
  version: number | string;
}

export interface AdminLoggingDestinationOverrideViewRow {
  id: string;
  tenant_id: string | null;
  log_type: string;
  plane: string;
  destination_id: string;
  destination_name: string | null;
  destination_health_status: string | null;
  enabled: number | string;
  managed_by: string;
  change_protection: string;
  approval_policy_id: string | null;
  policy_hash: string | null;
  updated_at: number | string;
  version: number | string;
}

export type AdminLoggingPolicyAssignmentViewRow = AdminLoggingDestinationOverrideViewRow;

export interface AdminLoggingCriticalPolicyRow {
  id: string;
  policy_key: string;
  destination_id: string;
  destination_name: string | null;
  destination_health_status: string | null;
  critical_allowed: number | string;
  default_fallback_eligible: number | string;
  failure_mode: string;
  change_protection: string;
  approval_policy_id: string | null;
  status: string;
  updated_at: number | string;
  version: number | string;
}

export interface AdminLoggingSensitiveDetailPolicyRow {
  id: string;
  log_type: string;
  plane: string;
  destination_id: string;
  destination_name: string | null;
  destination_health_status: string | null;
  chunking_enabled: number | string;
  encryption_required: number | string;
  read_audit_required: number | string;
  status: string;
  updated_at: number | string;
  version: number | string;
}

export interface SensitiveDetailIndexSummaryRow {
  object_class: string;
  total: number | string;
  last_created_at: number | string | null;
}

export interface LoggingKeyVersionStatusRow {
  status: string;
  total: number | string;
}

export interface AdminAuditCoverageStatusRowInput {
  operation_id: string;
  surface: string;
  required_audit: string;
  criticality: string;
  status: string;
  first_seen_at: number;
  last_seen_at: number;
  updated_at: number;
}

export interface AdminLoggingCriticalPolicyState {
  summary: {
    critical_destination_count: number;
    failing_destination_count: number;
    critical_assignment_count: number;
    unprotected_assignment_count: number;
  };
  destinations: AdminLoggingCriticalDestinationRow[];
  policies: AdminLoggingCriticalPolicyRow[];
  assignments: AdminLoggingDestinationOverrideViewRow[];
}

export interface AdminLoggingSensitiveDetailPolicyState {
  summary: {
    chunked: boolean;
    encrypted: boolean;
    assignment_count: number;
    policy_count: number;
    indexed_object_class_count: number;
    stale_key_count: number;
  };
  policies: AdminLoggingSensitiveDetailPolicyRow[];
  assignments: AdminLoggingDestinationOverrideViewRow[];
  index_summary: SensitiveDetailIndexSummaryRow[];
  key_versions: LoggingKeyVersionStatusRow[];
}

interface LogCatalogRepairObjectDbRow {
  id: string;
  tenant_key: string;
  log_type: string;
  plane: string;
  object_key: string;
  status: 'pending' | 'committed' | 'orphan_candidate' | 'deleted';
  record_count: number | string;
  byte_count: number | string;
  checksum_sha256: string | null;
  created_at: number | string;
  committed_at: number | string | null;
}

interface LogCatalogRepairManifestDbRow {
  tenant_key: string;
  log_type: string;
  plane: string;
  bucket_start_at: number | string;
  shard: string;
  status: 'pending' | 'committed' | 'repair_needed';
}

function toInteger(value: unknown, defaultValue = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function mapRepairObjectRow(row: LogCatalogRepairObjectDbRow): LogCatalogRepairObjectRow {
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    logType: row.log_type as LogCatalogRepairObjectRow['logType'],
    plane: row.plane as LogCatalogRepairObjectRow['plane'],
    objectKey: row.object_key,
    status: row.status,
    recordCount: toInteger(row.record_count),
    byteCount: toInteger(row.byte_count),
    checksumSha256: row.checksum_sha256,
    createdAt: toInteger(row.created_at),
    committedAt: row.committed_at === null ? null : toInteger(row.committed_at),
  };
}

function mapRepairManifestRow(row: LogCatalogRepairManifestDbRow): LogCatalogRepairManifestRow {
  return {
    tenantKey: row.tenant_key,
    logType: row.log_type as LogCatalogRepairManifestRow['logType'],
    plane: row.plane as LogCatalogRepairManifestRow['plane'],
    bucketStartAt: toInteger(row.bucket_start_at),
    shard: row.shard,
    status: row.status,
  };
}

async function upsertCoverageStatus(
  tx: TransactionContext,
  row: AdminAuditCoverageStatusRowInput
): Promise<void> {
  const existing = await tx.queryOne<{ operation_id: string }>(
    'SELECT operation_id FROM admin_audit_coverage_status WHERE operation_id = ?',
    [row.operation_id]
  );
  if (existing) {
    await tx.execute(
      `UPDATE admin_audit_coverage_status
       SET route = ?,
           method = ?,
           required_audit = ?,
           criticality = ?,
           status = ?,
           last_seen_at = ?,
           updated_at = ?
       WHERE operation_id = ?`,
      [
        row.surface,
        '*',
        row.required_audit,
        row.criticality,
        row.status,
        row.last_seen_at,
        row.updated_at,
        row.operation_id,
      ]
    );
    return;
  }

  await tx.execute(
    `INSERT INTO admin_audit_coverage_status (
      operation_id, route, method, required_audit, criticality, status,
      first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.operation_id,
      row.surface,
      '*',
      row.required_audit,
      row.criticality,
      row.status,
      row.first_seen_at,
      row.last_seen_at,
      row.updated_at,
    ]
  );
}

export class AdminLoggingControlRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async loadCriticalPolicy(): Promise<AdminLoggingCriticalPolicyState> {
    const destinations = await this.adapter.query<AdminLoggingCriticalDestinationRow>(
      `SELECT id, name, display_name, provider, lifecycle_status, health_status,
              critical_allowed, default_fallback_eligible, last_health_check_at, version
       FROM admin_destinations
       WHERE deleted_at IS NULL AND critical_allowed = 1
       ORDER BY name ASC
       LIMIT 100`
    );
    const assignments = await this.adapter.query<AdminLoggingDestinationOverrideViewRow>(
      `SELECT lpa.id, lpa.tenant_id, lpa.log_type, lpa.plane, lpa.destination_id,
              ad.name AS destination_name, ad.health_status AS destination_health_status,
              lpa.enabled, lpa.managed_by, lpa.change_protection, lpa.approval_policy_id,
              lpa.policy_hash, lpa.updated_at, lpa.version
       FROM logging_destination_overrides lpa
       LEFT JOIN admin_destinations ad ON ad.id = lpa.destination_id
       WHERE lpa.enabled = 1
         AND (
           lpa.log_type IN ('audit', 'admin_audit', 'security', 'pii')
           OR lpa.plane = 'sensitive_detail'
         )
       ORDER BY lpa.log_type ASC, lpa.plane ASC, lpa.tenant_id ASC
       LIMIT 100`
    );
    const policies = await this.adapter.query<AdminLoggingCriticalPolicyRow>(
      `SELECT acp.id, acp.policy_key, acp.destination_id, ad.name AS destination_name,
              ad.health_status AS destination_health_status, acp.critical_allowed,
              acp.default_fallback_eligible, acp.failure_mode, acp.change_protection,
              acp.approval_policy_id, acp.status, acp.updated_at, acp.version
       FROM admin_logging_critical_policies acp
       LEFT JOIN admin_destinations ad ON ad.id = acp.destination_id
       WHERE acp.deleted_at IS NULL
       ORDER BY acp.updated_at DESC
       LIMIT 100`
    );
    const failingDestinationCount = destinations.filter((destination) =>
      ['degraded', 'failing', 'unreachable'].includes(destination.health_status)
    ).length;
    const unprotectedAssignmentCount = assignments.filter(
      (assignment) =>
        !destinations.some((destination) => destination.id === assignment.destination_id)
    ).length;

    return {
      summary: {
        critical_destination_count: destinations.length,
        failing_destination_count: failingDestinationCount,
        critical_assignment_count: assignments.length,
        unprotected_assignment_count: unprotectedAssignmentCount,
      },
      destinations,
      policies,
      assignments,
    };
  }

  async updateCriticalPolicy(input: {
    destinationId: string;
    criticalAllowed: boolean;
    defaultFallbackEligible: boolean;
    actorId?: string | null;
    now: number;
  }): Promise<{ version: number }> {
    return this.adapter.transaction(async (tx) => {
      const destination = await tx.queryOne<{ version: number | string }>(
        `SELECT version
         FROM admin_destinations
         WHERE id = ? AND deleted_at IS NULL`,
        [input.destinationId]
      );
      const currentVersion = toInteger(destination?.version, 1);

      await tx.execute(
        `UPDATE admin_destinations
         SET critical_allowed = ?, default_fallback_eligible = ?,
             updated_by = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND deleted_at IS NULL`,
        [
          input.criticalAllowed ? 1 : 0,
          input.defaultFallbackEligible ? 1 : 0,
          input.actorId ?? null,
          input.now,
          input.destinationId,
        ]
      );

      const policyKey = `destination:${input.destinationId}`;
      const existingPolicy = await tx.queryOne<{ id: string; version: number | string }>(
        'SELECT id, version FROM admin_logging_critical_policies WHERE policy_key = ?',
        [policyKey]
      );
      if (existingPolicy) {
        await tx.execute(
          `UPDATE admin_logging_critical_policies
           SET destination_id = ?,
               critical_allowed = ?,
               default_fallback_eligible = ?,
               change_protection = 'confirm',
               status = 'active',
               updated_by = ?,
               updated_at = ?,
               version = version + 1
           WHERE id = ?`,
          [
            input.destinationId,
            input.criticalAllowed ? 1 : 0,
            input.defaultFallbackEligible ? 1 : 0,
            input.actorId ?? null,
            input.now,
            existingPolicy.id,
          ]
        );
      } else {
        await tx.execute(
          `INSERT INTO admin_logging_critical_policies (
            id, policy_key, destination_id, critical_allowed, default_fallback_eligible,
            failure_mode, change_protection, status, created_by, updated_by, created_at,
            updated_at, version
          ) VALUES (?, ?, ?, ?, ?, 'platform_default', 'confirm', 'active', ?, ?, ?, ?, 1)`,
          [
            createLoggingId('pol', input.now),
            policyKey,
            input.destinationId,
            input.criticalAllowed ? 1 : 0,
            input.defaultFallbackEligible ? 1 : 0,
            input.actorId ?? null,
            input.actorId ?? null,
            input.now,
            input.now,
          ]
        );
      }

      return { version: currentVersion + 1 };
    });
  }

  async loadSensitiveDetailPolicy(): Promise<AdminLoggingSensitiveDetailPolicyState> {
    const assignments = await this.adapter.query<AdminLoggingDestinationOverrideViewRow>(
      `SELECT lpa.id, lpa.tenant_id, lpa.log_type, lpa.plane, lpa.destination_id,
              ad.name AS destination_name, ad.health_status AS destination_health_status,
              lpa.enabled, lpa.managed_by, lpa.change_protection, lpa.approval_policy_id,
              lpa.policy_hash, lpa.updated_at, lpa.version
       FROM logging_destination_overrides lpa
       LEFT JOIN admin_destinations ad ON ad.id = lpa.destination_id
       WHERE lpa.plane = 'sensitive_detail'
       ORDER BY lpa.log_type ASC, lpa.tenant_id ASC
       LIMIT 100`
    );
    const policies = await this.adapter.query<AdminLoggingSensitiveDetailPolicyRow>(
      `SELECT sdp.id, sdp.log_type, sdp.plane, sdp.destination_id,
              ad.name AS destination_name, ad.health_status AS destination_health_status,
              sdp.chunking_enabled, sdp.encryption_required, sdp.read_audit_required,
              sdp.status, sdp.updated_at, sdp.version
       FROM admin_logging_sensitive_detail_policies sdp
       LEFT JOIN admin_destinations ad ON ad.id = sdp.destination_id
       WHERE sdp.deleted_at IS NULL
       ORDER BY sdp.log_type ASC
       LIMIT 100`
    );
    const indexSummary = await this.adapter.query<SensitiveDetailIndexSummaryRow>(
      `SELECT object_class, COUNT(*) AS total, MAX(created_at) AS last_created_at
       FROM sensitive_detail_chunk_index
       GROUP BY object_class
       ORDER BY object_class ASC
       LIMIT 100`
    );
    const keyVersions = await this.adapter.query<LoggingKeyVersionStatusRow>(
      `SELECT kv.status, COUNT(*) AS total
       FROM logging_key_versions kv
       INNER JOIN logging_key_registry kr ON kr.id = kv.key_registry_id
       WHERE kr.plane = 'sensitive_detail'
       GROUP BY kv.status
       ORDER BY kv.status ASC`
    );
    const staleKeyCount = keyVersions
      .filter((row) => ['rewrap_required', 'compromised', 'retiring'].includes(row.status))
      .reduce((sum, row) => sum + toInteger(row.total), 0);

    return {
      summary: {
        chunked: true,
        encrypted: true,
        assignment_count: assignments.length,
        policy_count: policies.length,
        indexed_object_class_count: indexSummary.length,
        stale_key_count: staleKeyCount,
      },
      policies,
      assignments,
      index_summary: indexSummary,
      key_versions: keyVersions,
    };
  }

  async updateSensitiveDetailPolicy(input: {
    logType: string;
    destinationId: string;
    enabled: boolean;
    actorId?: string | null;
    now: number;
  }): Promise<{
    id: string;
    version: number;
    created: boolean;
    previous: {
      id: string;
      destination_id: string;
      enabled: number | string;
      version: number | string;
    } | null;
  }> {
    return this.adapter.transaction(async (tx) => {
      const current = await tx.queryOne<{
        id: string;
        tenant_id: string | null;
        log_type: string;
        plane: string;
        destination_id: string;
        fallback_policy_id: string | null;
        enabled: number | string;
        managed_by: string;
        change_protection: string;
        approval_policy_id: string | null;
        policy_hash: string | null;
        version: number | string;
      }>(
        `SELECT id, tenant_id, log_type, plane, destination_id, fallback_policy_id,
                enabled, managed_by, change_protection, approval_policy_id, policy_hash, version
         FROM logging_destination_overrides
         WHERE tenant_id IS NULL AND log_type = ? AND plane = 'sensitive_detail'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [input.logType]
      );
      const id = current?.id ?? createLoggingId('pol', input.now);
      const version = toInteger(current?.version, 0) + 1;

      if (current) {
        await tx.execute(
          `UPDATE logging_destination_overrides
           SET destination_id = ?, enabled = ?, managed_by = 'platform',
               change_protection = 'confirm', updated_by = ?, updated_at = ?,
               version = version + 1
           WHERE id = ?`,
          [input.destinationId, input.enabled ? 1 : 0, input.actorId ?? null, input.now, id]
        );
      } else {
        await tx.execute(
          `INSERT INTO logging_destination_overrides (
            id, tenant_id, log_type, plane, destination_id, enabled, managed_by,
            change_protection, created_by, updated_by, created_at, updated_at, version
          ) VALUES (?, NULL, ?, 'sensitive_detail', ?, ?, 'platform', 'confirm', ?, ?, ?, ?, 1)`,
          [
            id,
            input.logType,
            input.destinationId,
            input.enabled ? 1 : 0,
            input.actorId ?? null,
            input.actorId ?? null,
            input.now,
            input.now,
          ]
        );
      }
      await tx.execute(
        `INSERT INTO logging_destination_override_history (
          id, override_id, tenant_id, log_type, plane,
          previous_destination_id, next_destination_id,
          previous_fallback_policy_id, next_fallback_policy_id,
          previous_enabled, next_enabled,
          previous_change_protection, next_change_protection,
          previous_approval_policy_id, next_approval_policy_id,
          previous_policy_hash, next_policy_hash,
          previous_version, next_version,
          changed_by, changed_at, change_reason, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createLoggingId('loh', input.now),
          id,
          null,
          input.logType,
          'sensitive_detail',
          current?.destination_id ?? null,
          input.destinationId,
          current?.fallback_policy_id ?? null,
          null,
          current?.enabled ?? null,
          input.enabled ? 1 : 0,
          current?.change_protection ?? null,
          'confirm',
          current?.approval_policy_id ?? null,
          null,
          current?.policy_hash ?? null,
          null,
          current ? toInteger(current.version) : null,
          version,
          input.actorId ?? null,
          input.now,
          current ? 'update' : 'create',
          JSON.stringify({ surface: 'admin_logging_sensitive_detail_policy' }),
        ]
      );

      const existingPolicy = await tx.queryOne<{ id: string; version: number | string }>(
        `SELECT id, version
         FROM admin_logging_sensitive_detail_policies
         WHERE log_type = ? AND plane = 'sensitive_detail' AND deleted_at IS NULL`,
        [input.logType]
      );
      if (existingPolicy) {
        await tx.execute(
          `UPDATE admin_logging_sensitive_detail_policies
           SET destination_id = ?,
               status = ?,
               updated_by = ?,
               updated_at = ?,
               version = version + 1
           WHERE id = ?`,
          [
            input.destinationId,
            input.enabled ? 'active' : 'disabled',
            input.actorId ?? null,
            input.now,
            existingPolicy.id,
          ]
        );
      } else {
        await tx.execute(
          `INSERT INTO admin_logging_sensitive_detail_policies (
            id, log_type, plane, destination_id, chunking_enabled, encryption_required,
            read_audit_required, status, created_by, updated_by, created_at, updated_at, version
          ) VALUES (?, ?, 'sensitive_detail', ?, 1, 1, 1, ?, ?, ?, ?, ?, 1)`,
          [
            createLoggingId('pol', input.now),
            input.logType,
            input.destinationId,
            input.enabled ? 'active' : 'disabled',
            input.actorId ?? null,
            input.actorId ?? null,
            input.now,
            input.now,
          ]
        );
      }

      return { id, version, created: !current, previous: current ?? null };
    });
  }

  async upsertCoverageStatuses(rows: AdminAuditCoverageStatusRowInput[]): Promise<void> {
    await this.adapter.transaction(async (tx) => {
      for (const row of rows) {
        await upsertCoverageStatus(tx, row);
      }
    });
  }

  async detectCatalogRepairFindings(input: {
    now: number;
    limit: number;
    pendingTtlMs: number;
  }): Promise<LogCatalogRepairFinding[]> {
    const objectRows = await this.adapter.query<LogCatalogRepairObjectDbRow>(
      `SELECT id, tenant_key, log_type, plane, object_key, status, record_count, byte_count,
              checksum_sha256, created_at, committed_at
       FROM log_object_catalog
       WHERE status IN ('pending', 'orphan_candidate', 'committed')
       ORDER BY created_at DESC
       LIMIT ?`,
      [input.limit]
    );
    const manifestRows = await this.adapter.query<LogCatalogRepairManifestDbRow>(
      `SELECT tenant_key, log_type, plane, bucket_start_at, shard, status
       FROM log_chunk_manifests
       WHERE status IN ('committed', 'repair_needed')
       ORDER BY bucket_start_at DESC
       LIMIT ?`,
      [input.limit]
    );

    return detectLogCatalogRepairFindings({
      objects: objectRows.map(mapRepairObjectRow),
      manifests: manifestRows.map(mapRepairManifestRow),
      now: input.now,
      pendingTtlMs: input.pendingTtlMs,
    });
  }

  async applySafeCatalogRepairs(
    findings: readonly LogCatalogRepairFinding[],
    now: number
  ): Promise<Awaited<ReturnType<typeof executeSafeLogCatalogRepairs>>> {
    return executeSafeLogCatalogRepairs({
      findings,
      now,
      executor: {
        markObjectOrphanCandidate: async (objectCatalogId, repairedAt) => {
          await this.adapter.transaction(async (tx) => {
            await tx.execute(
              `UPDATE log_object_catalog
               SET status = 'orphan_candidate'
               WHERE id = ? AND status = 'pending'`,
              [objectCatalogId]
            );
            await tx.execute(
              `UPDATE log_chunk_record_index
               SET status = 'deleted'
               WHERE object_catalog_id = ? AND status = 'pending'`,
              [objectCatalogId]
            );
            await tx.execute(
              `INSERT INTO logging_delivery_events (
                id, tenant_key, destination_id, log_type, plane, lane, status, attempt_count,
                error_class, object_catalog_id, created_at, updated_at, metadata
              )
              SELECT ?, tenant_key, NULL, log_type, plane, 'default', 'delivered', 0,
                     NULL, id, ?, ?, ?
              FROM log_object_catalog
              WHERE id = ?`,
              [
                createLoggingId('lde', repairedAt),
                repairedAt,
                repairedAt,
                JSON.stringify({ action: 'catalog_repair.mark_orphan_candidate' }),
                objectCatalogId,
              ]
            );
          });
        },
        deleteRecordIndexesForObject: async (objectCatalogId, repairedAt) => {
          await this.adapter.transaction(async (tx) => {
            await tx.execute(
              `UPDATE log_chunk_record_index
               SET status = 'deleted'
               WHERE object_catalog_id = ? AND status <> 'deleted'`,
              [objectCatalogId]
            );
            await tx.execute(
              `INSERT INTO logging_delivery_events (
                id, tenant_key, destination_id, log_type, plane, lane, status, attempt_count,
                error_class, object_catalog_id, created_at, updated_at, metadata
              )
              SELECT ?, tenant_key, NULL, log_type, plane, 'default', 'delivered', 0,
                     NULL, id, ?, ?, ?
              FROM log_object_catalog
              WHERE id = ?`,
              [
                createLoggingId('lde', repairedAt),
                repairedAt,
                repairedAt,
                JSON.stringify({ action: 'catalog_repair.delete_orphan_indexes' }),
                objectCatalogId,
              ]
            );
          });
        },
        enqueueManifestRegeneration: async (finding, repairedAt) => {
          const bucketStartAt = finding.bucketStartAt ?? repairedAt;
          const shard = finding.shard ?? 'shard-00';
          const manifestObjectKey = buildLogChunkManifestObjectKey({
            tenantKey: finding.tenantKey,
            logType: finding.logType,
            plane: finding.plane,
            bucketStartAt,
            shard,
          });
          await this.adapter.transaction(async (tx) => {
            const existing = await tx.queryOne<{ id: string }>(
              `SELECT id
               FROM log_chunk_manifests
               WHERE tenant_key = ?
                 AND log_type = ?
                 AND plane = ?
                 AND bucket_start_at = ?
                 AND shard = ?`,
              [finding.tenantKey, finding.logType, finding.plane, bucketStartAt, shard]
            );
            if (existing) {
              await tx.execute(
                `UPDATE log_chunk_manifests
                 SET status = 'repair_needed',
                     updated_at = ?
                 WHERE id = ?`,
                [repairedAt, existing.id]
              );
              return;
            }

            await tx.execute(
              `INSERT INTO log_chunk_manifests (
                id, tenant_key, log_type, plane, bucket_start_at, bucket_end_at, shard,
                manifest_object_key, chunk_count, record_count, checksum_sha256, status,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'repair_needed', ?, ?)`,
              [
                createLoggingId('man', repairedAt),
                finding.tenantKey,
                finding.logType,
                finding.plane,
                bucketStartAt,
                bucketStartAt + 60 * 60 * 1000,
                shard,
                manifestObjectKey,
                'repair-needed',
                repairedAt,
                repairedAt,
              ]
            );
          });
        },
      },
    });
  }
}

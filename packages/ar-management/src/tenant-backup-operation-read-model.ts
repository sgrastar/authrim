import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  TenantBackupOperationStore,
  type TenantBackupOperation,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-store';
import {
  TenantBackupRequestStore,
  type TenantBackupRequestIntent,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import { decodeTenantBackupRestoreApprovalCursor } from '@authrim/ar-lib-core/services/tenant-portability/restore-preview';
import {
  TenantBackupAdminMappingStore,
  type TenantBackupAdminMappingStatus,
} from '@authrim/ar-lib-core/services/tenant-portability/admin-mapping-store';
import {
  TenantBackupRestoreHoldStore,
  type TenantBackupRestoreHoldSummary,
} from '@authrim/ar-lib-core/services/tenant-portability/restore-hold-store';
import { buildTenantBackupDatasetExecutionPlan } from '@authrim/ar-lib-core/services/tenant-portability/dataset-execution-plan';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';

interface PublicationRow {
  expires_at: number;
}
interface PlanRow {
  state: string;
  item_count: number;
  chain_digest: string;
}
interface DatasetRow {
  dataset_id: string;
  record_count: number;
}
interface ContainerInputRow {
  dataset_stats_json: string;
}
interface RestoreSequenceRow {
  payload_json: string;
}

export interface TenantBackupOperationProgress {
  registered: number;
  materialized: number;
  nonEmpty: number;
  executionBatches: number;
  bytes: number;
  rows: number;
}

export interface TenantBackupOperationSummary {
  id: string;
  kind: TenantBackupOperation['kind'];
  state: TenantBackupOperation['state'];
  phase: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastErrorCode: string | null;
}

export interface TenantBackupOperationView extends TenantBackupOperationSummary {
  selection: TenantBackupRequestIntent['selection'];
  publication: { expiresAt: number; downloadAvailable: boolean } | null;
  adminMapping: TenantBackupAdminMappingStatus | null;
  heldRecords: TenantBackupRestoreHoldSummary[];
  progress: TenantBackupOperationProgress | null;
  preview: {
    planDigest: string;
    datasetCount: number;
    recordCount: number;
    datasets: { datasetId: string; recordCount: number }[];
    prerequisites: ReturnType<
      typeof decodeTenantBackupRestoreApprovalCursor
    >['preview']['prerequisites'];
    deliverySafety: ReturnType<
      typeof decodeTenantBackupRestoreApprovalCursor
    >['preview']['deliverySafety'];
    blockers: ReturnType<typeof decodeTenantBackupRestoreApprovalCursor>['preview']['blockers'];
    canApprove: boolean;
  } | null;
}

function summary(operation: TenantBackupOperation): TenantBackupOperationSummary {
  return {
    id: operation.id,
    kind: operation.kind,
    state: operation.state,
    phase: operation.phase,
    revision: operation.revision,
    createdAt: operation.created_at,
    updatedAt: operation.updated_at,
    lastErrorCode: operation.last_error_code,
  };
}

export class TenantBackupOperationReadModel {
  private readonly operations: TenantBackupOperationStore;
  private readonly requests: TenantBackupRequestStore;

  constructor(private readonly database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>) {
    this.operations = new TenantBackupOperationStore(database);
    this.requests = new TenantBackupRequestStore(database);
  }

  async list(tenantId: string): Promise<TenantBackupOperationSummary[]> {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(tenantId))
      throw new Error('invalid_backup_operation_identifier');
    return (
      await this.database.query<TenantBackupOperation>(
        `SELECT * FROM tenant_backup_operations WHERE tenant_id=?
         ORDER BY created_at DESC,id DESC LIMIT 50`,
        [tenantId]
      )
    ).map(summary);
  }

  async get(
    tenantId: string,
    operationId: string,
    now: number
  ): Promise<{
    operation: TenantBackupOperation;
    intent: TenantBackupRequestIntent;
    view: TenantBackupOperationView;
  } | null> {
    const operation = await this.operations.get(tenantId, operationId);
    if (!operation) return null;
    const intent = await this.requests.load(tenantId, operationId);
    const [publication, plan, datasets, adminMapping, heldRecords, containerInputs, sequence] =
      await Promise.all([
        this.database.queryOne<PublicationRow>(
          'SELECT expires_at FROM tenant_backup_publications WHERE tenant_id=? AND operation_id=?',
          [tenantId, operationId]
        ),
        this.database.queryOne<PlanRow>(
          `SELECT state,item_count,chain_digest FROM tenant_backup_restore_plan_inventories
         WHERE tenant_id=? AND operation_id=?`,
          [tenantId, operationId]
        ),
        this.database.query<DatasetRow>(
          `SELECT i.dataset_id,sum(i.record_count) record_count
         FROM tenant_backup_dataset_inspections i
         JOIN tenant_backup_validation_sessions s ON s.id=i.session_id AND s.tenant_id=i.tenant_id
         WHERE s.tenant_id=? AND s.operation_id=?
         GROUP BY i.dataset_id ORDER BY i.dataset_id LIMIT 4096`,
          [tenantId, operationId]
        ),
        intent.kind === 'import' && intent.selection.admin
          ? new TenantBackupAdminMappingStore(this.database).status(tenantId, operationId)
          : null,
        intent.kind === 'import'
          ? new TenantBackupRestoreHoldStore(this.database).summaries(tenantId, operationId)
          : [],
        intent.kind === 'import'
          ? this.database.query<ContainerInputRow>(
              `SELECT dataset_stats_json FROM tenant_backup_container_inputs
             WHERE tenant_id=? AND operation_id=? ORDER BY bundle_id`,
              [tenantId, operationId]
            )
          : [],
        intent.kind === 'import'
          ? this.database.queryOne<RestoreSequenceRow>(
              `SELECT payload_json FROM tenant_backup_restore_plan_inventory_items
             WHERE tenant_id=? AND operation_id=? AND item_id='sqlite-restore-sequence'`,
              [tenantId, operationId]
            )
          : null,
      ]);
    if (
      datasets.some(
        ({ dataset_id, record_count }) =>
          typeof dataset_id !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(dataset_id) ||
          !Number.isSafeInteger(record_count) ||
          record_count < 0
      ) ||
      new Set(datasets.map(({ dataset_id }) => dataset_id)).size !== datasets.length
    )
      throw new Error('backup_restore_preview_invalid');
    let preview: TenantBackupOperationView['preview'] = null;
    let progress: TenantBackupOperationProgress | null = null;
    if (containerInputs.length) {
      try {
        const targets = new Map<string, string>();
        if (sequence) {
          const decoded = JSON.parse(sequence.payload_json) as {
            jobs?: { datasetId?: unknown; targetId?: unknown }[];
          };
          for (const job of decoded.jobs ?? [])
            if (typeof job.datasetId === 'string' && typeof job.targetId === 'string')
              targets.set(job.datasetId, job.targetId);
        }
        const registered = new Map<
          string,
          {
            dataset: TenantPortableDataset;
            targetId: string;
            rows: number;
            bytes: number;
          }
        >();
        for (const row of containerInputs) {
          const value = JSON.parse(row.dataset_stats_json) as {
            datasets?: { id?: unknown; rows?: unknown; bytes?: unknown }[];
            registeredDatasets?: TenantPortableDataset[];
          };
          const stats = new Map((value.datasets ?? []).map((entry) => [entry.id, entry]));
          for (const dataset of value.registeredDatasets ?? []) {
            const saved = stats.get(dataset.id);
            if (
              !saved ||
              typeof saved.rows !== 'number' ||
              typeof saved.bytes !== 'number' ||
              registered.has(dataset.id)
            )
              throw new Error('invalid');
            registered.set(dataset.id, {
              dataset,
              targetId:
                dataset.store === 'database'
                  ? (targets.get(dataset.id) ?? 'database:pending')
                  : `${dataset.store}:default`,
              rows: saved.rows,
              bytes: saved.bytes,
            });
          }
        }
        if (registered.size) {
          const execution = buildTenantBackupDatasetExecutionPlan([...registered.values()]);
          progress = {
            registered: execution.registeredDatasets.length,
            materialized: execution.materializedDatasets.length,
            nonEmpty: execution.nonEmptyDatasets.length,
            executionBatches: execution.executionBatches.length,
            bytes: execution.totalBytes,
            rows: execution.totalRows,
          };
        }
      } catch {
        progress = null;
      }
    }
    if (operation.state === 'waiting' && operation.phase === 'await_restore_approval') {
      const cursor = decodeTenantBackupRestoreApprovalCursor(operation.cursor_json);
      if (!plan || plan.state !== 'sealed' || plan.chain_digest !== cursor.planDigest)
        throw new Error('backup_restore_preview_stale');
      const recordCount = datasets.reduce((total, dataset) => total + dataset.record_count, 0);
      if (!Number.isSafeInteger(recordCount) || recordCount < 0)
        throw new Error('backup_restore_preview_invalid');
      preview = {
        planDigest: cursor.planDigest,
        datasetCount: datasets.length,
        recordCount,
        datasets: datasets.map((dataset) => ({
          datasetId: dataset.dataset_id,
          recordCount: dataset.record_count,
        })),
        prerequisites: cursor.preview.prerequisites,
        deliverySafety: cursor.preview.deliverySafety,
        blockers: cursor.preview.blockers,
        canApprove: cursor.preview.blockers.length === 0 && (adminMapping?.complete ?? true),
      };
    }
    return {
      operation,
      intent,
      view: {
        ...summary(operation),
        selection: intent.selection,
        adminMapping,
        heldRecords,
        progress,
        publication: publication
          ? { expiresAt: publication.expires_at, downloadAvailable: publication.expires_at > now }
          : null,
        preview,
      },
    };
  }
}

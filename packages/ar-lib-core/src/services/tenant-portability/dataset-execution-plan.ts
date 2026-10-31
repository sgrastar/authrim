import type { TenantPortableDataset } from './module-contract';

export interface RegisteredDatasetExecutionInput {
  dataset: TenantPortableDataset;
  targetId: string;
  rows: number;
  bytes: number;
  /** A zero-row state that must be applied even to a freshly provisioned target. */
  materializeEmpty?: boolean;
}

export interface TenantBackupExecutionBatch {
  id: string;
  store: TenantPortableDataset['store'];
  targetId: string;
  datasetIds: string[];
  rows: number;
  bytes: number;
}

export interface TenantBackupDatasetExecutionPlan {
  registeredDatasets: string[];
  materializedDatasets: string[];
  nonEmptyDatasets: string[];
  executionBatches: TenantBackupExecutionBatch[];
  totalRows: number;
  totalBytes: number;
}

const MAX_BATCH_ROWS = 250;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

function invalid(): never {
  throw new Error('backup_dataset_execution_plan_invalid');
}

/**
 * Keep the complete logical registry for compatibility and audit, but build physical work only for
 * content that must be written. Inputs are already in dependency order; batches preserve that order.
 */
export function buildTenantBackupDatasetExecutionPlan(
  inputs: readonly RegisteredDatasetExecutionInput[]
): TenantBackupDatasetExecutionPlan {
  if (
    !inputs.length ||
    inputs.length > 4096 ||
    new Set(inputs.map(({ dataset }) => dataset.id)).size !== inputs.length
  )
    invalid();
  for (const input of inputs) {
    if (
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.dataset.id) ||
      !['database', 'kv', 'durable_object', 'object'].includes(input.dataset.store) ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.targetId) ||
      !Number.isSafeInteger(input.rows) ||
      input.rows < 0 ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 0 ||
      (input.rows === 0) !== (input.bytes === 0)
    )
      invalid();
  }
  const materialized = inputs.filter(({ rows, materializeEmpty }) => rows > 0 || materializeEmpty);
  const batches: TenantBackupExecutionBatch[] = [];
  for (const input of materialized) {
    const partCount = Math.max(
      1,
      Math.ceil(input.rows / MAX_BATCH_ROWS),
      Math.ceil(input.bytes / MAX_BATCH_BYTES)
    );
    let remainingRows = input.rows;
    let remainingBytes = input.bytes;
    for (let part = 0; part < partCount; part++) {
      const partsLeft = partCount - part;
      const rows = Math.ceil(remainingRows / partsLeft);
      const bytes = Math.ceil(remainingBytes / partsLeft);
      const previous = batches.at(-1);
      const sharesTarget =
        partCount === 1 &&
        previous?.store === input.dataset.store &&
        previous.targetId === input.targetId;
      const fits =
        sharesTarget &&
        previous.rows + rows <= MAX_BATCH_ROWS &&
        previous.bytes + bytes <= MAX_BATCH_BYTES;
      if (fits) {
        previous.datasetIds.push(input.dataset.id);
        previous.rows += rows;
        previous.bytes += bytes;
      } else {
        batches.push({
          id: `${input.dataset.store}:${input.targetId}:${batches.length}`,
          store: input.dataset.store,
          targetId: input.targetId,
          datasetIds: [input.dataset.id],
          rows,
          bytes,
        });
      }
      remainingRows -= rows;
      remainingBytes -= bytes;
    }
  }
  return {
    registeredDatasets: inputs.map(({ dataset }) => dataset.id),
    materializedDatasets: materialized.map(({ dataset }) => dataset.id),
    nonEmptyDatasets: inputs.filter(({ rows }) => rows > 0).map(({ dataset }) => dataset.id),
    executionBatches: batches,
    totalRows: inputs.reduce((total, input) => total + input.rows, 0),
    totalBytes: inputs.reduce((total, input) => total + input.bytes, 0),
  };
}

export const TENANT_BACKUP_EXECUTION_BATCH_LIMITS = {
  rows: MAX_BATCH_ROWS,
  bytes: MAX_BATCH_BYTES,
} as const;

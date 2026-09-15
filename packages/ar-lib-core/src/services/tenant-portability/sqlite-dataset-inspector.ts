import type { TenantBundleInspectorFactory } from './bundle-validation';
import type { TenantPortableDataset } from './module-contract';
import type { TenantBackupStepContext } from './operation-executor';
import type { TenantPortableDependency, TenantPortableRecordIdentity } from './reference-contract';
import type { CaptureSchema } from './sqlite-snapshot';
import { sqliteSnapshotRowInsert } from './sqlite-row-codec';
import { assertEnvironmentTenantKey } from './portable-tenant-key.js';

export type PortableSqliteRow = Readonly<Record<string, readonly [string, string | null]>>;

/** Installed module policy, never metadata supplied by an uploaded bundle. */
export interface SqliteDatasetInspectionPolicy {
  dataset: TenantPortableDataset;
  schema: CaptureSchema;
  /** Installed dataset identities that must be restored before this dataset. */
  restoreAfter?: readonly string[];
  /** Nullable self-reference columns restored in a second pass after every row exists. */
  deferredColumns?: readonly string[];
  /** Installed target-only values that replace source transport columns during restore. */
  restoreOverrides?: Readonly<Record<string, readonly [string, string | null]>>;
  /** Installed target-only values for tenant-key primary-key columns. */
  restoreIdentityOverrides?: Readonly<Record<string, readonly ['text', string]>>;
  /** Columns verified by an installed secret sidecar instead of byte equality. */
  verificationIgnoredColumns?: readonly string[];
  /** Validate and inventory the source rows, but do not materialize them in the restore target. */
  restoreDisposition?: 'reference_only';
  /** Installed, versioned row rewrite applied after validation and before every target operation. */
  restoreTransform?: {
    id: string;
    transform(
      context: TenantBackupStepContext,
      rowJson: string,
      mode: 'write' | 'defer' | 'verify'
    ): Promise<string>;
  };
  /** Quarantine selected source work instead of inserting it into a live target queue. */
  restoreHold?: {
    id: string;
    shouldHold(context: TenantBackupStepContext, rowJson: string): Promise<boolean>;
    write(context: TenantBackupStepContext, rowJson: string): Promise<void>;
    verify(context: TenantBackupStepContext, rowJson: string): Promise<void>;
  };
  /** Required for parent-owned rows: identify the parent's installed dataset. */
  parentDataset?: Pick<TenantPortableDataset, 'id' | 'module'>;
  /** Authoritative tenant key, when storage ownership uses it instead of tenant ID. */
  tenantKey?: string;
  /** Target environment tenant key used to verify restored tenant-key-owned rows. */
  restoreTenantKey?: string;
  /** Exact row-partition values assigned to this logical dataset. */
  partitions?: readonly string[];
  /** Business fields, secrets and non-ownership references require module-specific validation. */
  inspectRow: (
    row: PortableSqliteRow,
    identity: TenantPortableRecordIdentity
  ) => Promise<readonly TenantPortableDependency[]>;
}

/** Clone an installed policy without attempting to structured-clone executable callbacks. */
export function cloneSqliteDatasetInspectionPolicy(
  policy: SqliteDatasetInspectionPolicy
): SqliteDatasetInspectionPolicy {
  const { inspectRow, restoreTransform, restoreHold, ...serializable } = policy;
  return {
    ...structuredClone(serializable),
    inspectRow,
    ...(restoreTransform
      ? {
          restoreTransform: {
            id: restoreTransform.id,
            transform: (context, rowJson, mode) =>
              restoreTransform.transform(context, rowJson, mode),
          },
        }
      : {}),
    ...(restoreHold
      ? {
          restoreHold: {
            id: restoreHold.id,
            shouldHold: (context: TenantBackupStepContext, rowJson: string) =>
              restoreHold.shouldHold(context, rowJson),
            write: (context: TenantBackupStepContext, rowJson: string) =>
              restoreHold.write(context, rowJson),
            verify: (context: TenantBackupStepContext, rowJson: string) =>
              restoreHold.verify(context, rowJson),
          },
        }
      : {}),
  };
}

/** Serializable policy contract pinned into validation and restore plan digests. */
export function sqliteDatasetInspectionPolicyDescriptor(policy: SqliteDatasetInspectionPolicy) {
  return {
    dataset: policy.dataset,
    schema: policy.schema,
    parentDataset: policy.parentDataset,
    tenantKey: policy.tenantKey,
    partitions: policy.partitions,
    restoreAfter: policy.restoreAfter,
    deferredColumns: policy.deferredColumns,
    restoreOverrides: policy.restoreOverrides,
    restoreIdentityOverrides: policy.restoreIdentityOverrides,
    verificationIgnoredColumns: policy.verificationIgnoredColumns,
    restoreDisposition: policy.restoreDisposition,
    restoreTransformId: policy.restoreTransform?.id,
    restoreHoldId: policy.restoreHold?.id,
    restoreTenantKey: policy.restoreTenantKey,
  };
}
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 4096;
function boundedDependencies(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_ITEMS;
}
function invalid(): never {
  throw new Error('backup_sqlite_dataset_invalid');
}
function key(row: PortableSqliteRow, columns: readonly string[]): string {
  const values = columns.map((column) => {
    const value = row[column];
    if (!value || value[0] === 'null') invalid();
    return value;
  });
  const result = JSON.stringify(values);
  if (!values.length || result.length > 4096) invalid();
  return result;
}

/** Bounded NDJSON row inspection for the actual SQL exporter, including rows split across frames. */
export function createSqliteDatasetInspectorFactory(
  policy: SqliteDatasetInspectionPolicy
): TenantBundleInspectorFactory {
  const { inspectRow } = policy;
  const pinned = structuredClone(sqliteDatasetInspectionPolicyDescriptor(policy));
  return async (dataset, manifest) => {
    if (
      Object.keys(pinned.dataset).some(
        (field) =>
          dataset[field as keyof TenantPortableDataset] !==
          pinned.dataset[field as keyof TenantPortableDataset]
      ) ||
      !['database', 'kv', 'durable_object', 'object'].includes(dataset.store) ||
      dataset.schemaVersion !== 1 ||
      dataset.disposition !== 'include'
    )
      invalid();
    const schema = pinned.schema;
    if (
      (pinned.restoreDisposition !== undefined && pinned.restoreDisposition !== 'reference_only') ||
      (pinned.restoreTransformId !== undefined &&
        !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(pinned.restoreTransformId)) ||
      (pinned.restoreHoldId !== undefined &&
        !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(pinned.restoreHoldId)) ||
      (pinned.restoreDisposition === 'reference_only' &&
        (pinned.deferredColumns !== undefined ||
          pinned.restoreOverrides !== undefined ||
          pinned.restoreIdentityOverrides !== undefined ||
          pinned.verificationIgnoredColumns !== undefined ||
          pinned.restoreTransformId !== undefined ||
          pinned.restoreHoldId !== undefined)) ||
      (pinned.restoreHoldId !== undefined && pinned.deferredColumns !== undefined)
    )
      invalid();
    if (
      pinned.deferredColumns !== undefined &&
      (!pinned.deferredColumns.length ||
        new Set(pinned.deferredColumns).size !== pinned.deferredColumns.length ||
        pinned.deferredColumns.some(
          (column) => !schema.columns.includes(column) || schema.primaryKey.includes(column)
        ))
    )
      invalid();
    if (pinned.restoreOverrides !== undefined) {
      const columns = Object.keys(pinned.restoreOverrides);
      if (
        !columns.length ||
        columns.some(
          (column) =>
            !schema.columns.includes(column) ||
            schema.primaryKey.includes(column) ||
            pinned.deferredColumns?.includes(column)
        )
      )
        invalid();
      sqliteSnapshotRowInsert(schema.table, columns, JSON.stringify(pinned.restoreOverrides));
    }
    if (pinned.restoreIdentityOverrides !== undefined) {
      const columns = Object.keys(pinned.restoreIdentityOverrides);
      const direct = 'parent' in schema ? undefined : schema;
      if (
        !direct ||
        direct.tenantIdentity !== 'tenantKey' ||
        columns.length !== 1 ||
        columns[0] !== direct.tenantColumn ||
        !direct.primaryKey.includes(direct.tenantColumn) ||
        pinned.tenantKey === undefined ||
        pinned.restoreTenantKey === undefined ||
        JSON.stringify(pinned.restoreIdentityOverrides[direct.tenantColumn]) !==
          JSON.stringify(['text', pinned.restoreTenantKey]) ||
        Object.hasOwn(pinned.restoreOverrides ?? {}, direct.tenantColumn)
      )
        invalid();
      assertEnvironmentTenantKey(pinned.restoreTenantKey);
      sqliteSnapshotRowInsert(
        schema.table,
        columns,
        JSON.stringify(pinned.restoreIdentityOverrides)
      );
    } else if (pinned.restoreTenantKey !== undefined) {
      const direct = 'parent' in schema ? undefined : schema;
      if (
        !direct ||
        direct.tenantIdentity !== 'tenantKey' ||
        pinned.restoreOverrides?.[direct.tenantColumn]?.[0] !== 'text' ||
        pinned.restoreOverrides[direct.tenantColumn]?.[1] !== pinned.restoreTenantKey
      )
        invalid();
      assertEnvironmentTenantKey(pinned.restoreTenantKey);
    }
    if (
      pinned.verificationIgnoredColumns !== undefined &&
      (!pinned.verificationIgnoredColumns.length ||
        new Set(pinned.verificationIgnoredColumns).size !==
          pinned.verificationIgnoredColumns.length ||
        pinned.verificationIgnoredColumns.some(
          (column) =>
            !schema.columns.includes(column) ||
            schema.primaryKey.includes(column) ||
            (!Object.hasOwn(pinned.restoreOverrides ?? {}, column) &&
              pinned.restoreTransformId === undefined)
        ))
    )
      invalid();
    if ('parent' in schema && !pinned.parentDataset) invalid();
    if (schema.rowPartition) {
      if (
        !pinned.partitions?.length ||
        new Set(pinned.partitions).size !== pinned.partitions.length ||
        pinned.partitions.some((value) => !schema.rowPartition?.values.includes(value))
      )
        invalid();
    } else if (pinned.partitions !== undefined) invalid();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let fragments: string[] = [],
      rowBytes = 0,
      nextOrdinal = 0,
      closed = false,
      failed = false;
    // Merge similarly sized fragments: even one-byte frames use logarithmic fragment storage.
    function appendFragment(text: string) {
      if (!text) return;
      while (fragments.length && fragments[fragments.length - 1].length <= text.length)
        text = fragments.pop() + text;
      fragments.push(text);
    }
    return {
      async chunk(bytes, ordinal) {
        if (closed || failed || ordinal !== nextOrdinal || bytes.length > MAX_CHUNK_BYTES)
          invalid();
        const records: TenantPortableRecordIdentity[] = [];
        const references: TenantPortableDependency[] = [];
        try {
          let start = 0;
          for (let offset = 0; offset <= bytes.length; offset++) {
            if (offset !== bytes.length && bytes[offset] !== 10) continue;
            const part = bytes.subarray(start, offset);
            rowBytes += part.length;
            if (rowBytes > MAX_ROW_BYTES) invalid();
            const decoded = decoder.decode(part, { stream: true });
            appendFragment(decoded);
            start = offset + 1;
            if (offset === bytes.length) break;
            appendFragment(decoder.decode());
            const json = fragments.join('');
            fragments = [];
            rowBytes = 0;
            // Validate every typed field against the installed column list before using values.
            sqliteSnapshotRowInsert(schema.table, schema.columns, json);
            const parsed: unknown = JSON.parse(json);
            const row = parsed as PortableSqliteRow;
            if (schema.rowPartition) {
              const partition = row[schema.rowPartition.column];
              if (
                partition?.[0] !== 'text' ||
                partition[1] === null ||
                !pinned.partitions?.includes(partition[1])
              )
                invalid();
            }
            const identity: TenantPortableRecordIdentity = {
              module: dataset.module,
              collection: dataset.id,
              id: key(row, schema.primaryKey),
              tenantId: manifest.source.tenantId,
            };
            if ('parent' in schema) {
              const parent = pinned.parentDataset;
              if (!parent) invalid();
              references.push({
                from: identity,
                to: {
                  module: parent.module,
                  collection: parent.id,
                  id: key(row, schema.parent.childColumns),
                  tenantId: manifest.source.tenantId,
                  meaning: 'resource',
                  requirement: 'required',
                },
              });
            } else {
              const owner = row[schema.tenantColumn];
              const expected =
                schema.tenantIdentity === 'tenantKey' ? pinned.tenantKey : manifest.source.tenantId;
              if (!expected || owner?.[0] !== 'text' || owner[1] !== expected) invalid();
              if (schema.scopeTypeColumn) {
                const scope = row[schema.scopeTypeColumn];
                if (scope?.[0] !== 'text' || scope[1] !== 'tenant') invalid();
              }
            }
            const dependencies = await inspectRow(row, identity);
            if (!boundedDependencies(dependencies)) invalid();
            references.push(...dependencies);
            records.push(identity);
            if (records.length > MAX_ITEMS || references.length > MAX_ITEMS) invalid();
          }
          nextOrdinal++;
          return { records, references };
        } catch {
          failed = true;
          fragments = [];
          rowBytes = 0;
          return invalid();
        }
      },
      async finish() {
        if (closed || failed || rowBytes !== 0) invalid();
        try {
          if (decoder.decode()) invalid();
        } catch {
          return invalid();
        }
        closed = true;
        fragments = [];
      },
      async dispose() {
        closed = true;
        fragments = [];
        rowBytes = 0;
      },
    };
  };
}

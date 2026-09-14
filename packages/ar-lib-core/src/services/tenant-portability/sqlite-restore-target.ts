import { backupOwnershipPredicate, type BackupRowOwnership } from './row-ownership';
import { readSqliteRestoreSeedFingerprint } from './sqlite-restore-seed';
import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBundleManifest } from './bundle-manifest';
import {
  createSqliteDatasetInspectorFactory,
  type SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector';
import { sqliteSnapshotRowInsert } from './sqlite-row-codec';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
export interface SqliteRestoreTargetIdentity {
  id: string;
  tenantId: string;
  operationId: string;
  resourceId: string;
  planDigest: string;
  seedFingerprint: string;
}
export interface SqliteRestoreTargetLease {
  owner: string;
  fencingToken: number;
  expiresAt: number;
}
const GUARD = `EXISTS (SELECT 1 FROM tenant_backup_restore_targets WHERE id=? AND tenant_id=?
  AND operation_id=? AND resource_id=? AND plan_digest=? AND seed_fingerprint=?
  AND owner=? AND fencing_token=? AND lease_expires_at>? AND state='loading')`;
const SEALED_GUARD = GUARD.replace("state='loading'", "state='sealed'");
const SEALABLE_GUARD = GUARD.replace("state='loading'", "state IN ('loading','sealed')");
export type SqliteRestoreTargetMode = 'write' | 'seal' | 'verify';
const error = () => new Error('backup_restore_target_rejected');

/**
 * Fence a recorded unpublished target before provider cleanup. A missing local receipt means the
 * provisioned database was never opened; the coordinator must still delete that physical resource.
 */
export async function invalidateSqliteRestoreTarget(input: {
  database: Database;
  identity: SqliteRestoreTargetIdentity;
  lease: SqliteRestoreTargetLease;
  now: () => number;
  authorize: () => Promise<void>;
}): Promise<{ found: boolean }> {
  const identity = { ...input.identity };
  const lease = { ...input.lease };
  const current = input.now();
  if (
    Object.values(identity).some(
      (value) => typeof value !== 'string' || !value || value.length > 4096
    ) ||
    !/^[a-f0-9]{64}$/.test(identity.planDigest) ||
    !/^[a-f0-9]{64}$/.test(identity.seedFingerprint) ||
    !lease.owner ||
    !Number.isSafeInteger(lease.fencingToken) ||
    lease.fencingToken < 1 ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= lease.expiresAt
  )
    throw error();
  const params = [
    identity.id,
    identity.tenantId,
    identity.operationId,
    identity.resourceId,
    identity.planDigest,
    identity.seedFingerprint,
  ];
  await input.authorize();
  const existing = await input.database.queryOne<{ id: string }>(
    `SELECT id FROM tenant_backup_restore_targets WHERE id=? AND tenant_id=? AND operation_id=?
    AND resource_id=? AND plan_digest=? AND seed_fingerprint=?`,
    params
  );
  if (!existing) {
    await input.authorize();
    return { found: false };
  }
  await input.authorize();
  const result = await input.database.execute(
    `UPDATE tenant_backup_restore_targets SET owner=?,fencing_token=?,lease_expires_at=?,state='invalid'
    WHERE id=? AND tenant_id=? AND operation_id=? AND resource_id=? AND plan_digest=?
    AND seed_fingerprint=? AND state IN ('loading','sealed','invalid')
    AND (fencing_token<? OR (fencing_token=? AND owner=? AND lease_expires_at<=?))`,
    [
      lease.owner,
      lease.fencingToken,
      lease.expiresAt,
      ...params,
      lease.fencingToken,
      lease.fencingToken,
      lease.owner,
      lease.expiresAt,
    ]
  );
  if (!result.success || result.rowsAffected !== 1) throw error();
  if (
    !(await input.database.queryOne(
      `SELECT 1 AS invalid FROM tenant_backup_restore_targets WHERE id=? AND tenant_id=?
      AND operation_id=? AND resource_id=? AND plan_digest=? AND seed_fingerprint=?
      AND owner=? AND fencing_token=? AND lease_expires_at=? AND state='invalid'`,
      [...params, lease.owner, lease.fencingToken, lease.expiresAt]
    ))
  )
    throw error();
  await input.authorize();
  return { found: true };
}

/** An isolated staging database. Activation and the whole import plan remain coordinator-owned. */
export class SqliteRestoreTarget {
  private constructor(
    private readonly database: Database,
    private readonly identity: SqliteRestoreTargetIdentity,
    private readonly lease: SqliteRestoreTargetLease,
    private readonly now: () => number,
    /** Must verify the complete validated input plan, live import lease and unpublished routing. */
    private readonly authorize: () => Promise<void>,
    private readonly mode: SqliteRestoreTargetMode
  ) {}

  /**
   * Coordinator supplies an exclusive target admission guard and authoritative seed verification.
   * Reopening the same target does not reclassify partially imported rows as pre-existing data.
   */
  static async open(input: {
    database: Database;
    identity: SqliteRestoreTargetIdentity;
    lease: SqliteRestoreTargetLease;
    now: () => number;
    authorize: () => Promise<void>;
    mode?: SqliteRestoreTargetMode;
  }): Promise<SqliteRestoreTarget> {
    const mode = input.mode ?? 'write';
    if (!['write', 'seal', 'verify'].includes(mode)) throw error();
    const identity = { ...input.identity },
      lease = { ...input.lease };
    if (
      Object.values(identity).some((v) => typeof v !== 'string' || !v || v.length > 4096) ||
      !/^[a-f0-9]{64}$/.test(identity.planDigest) ||
      !/^[a-f0-9]{64}$/.test(identity.seedFingerprint) ||
      !lease.owner ||
      !Number.isSafeInteger(lease.fencingToken) ||
      lease.fencingToken < 1 ||
      !Number.isSafeInteger(lease.expiresAt)
    )
      throw error();
    const target = new SqliteRestoreTarget(
      input.database,
      identity,
      lease,
      input.now,
      input.authorize,
      mode
    );
    target.guard();
    await input.authorize();
    const existing = await input.database.queryOne<{ id: string }>(
      'SELECT id FROM tenant_backup_restore_targets LIMIT 1'
    );
    if (!existing) {
      if (mode !== 'write') throw error();
      if (
        (await readSqliteRestoreSeedFingerprint(input.database, input.authorize)) !==
        identity.seedFingerprint
      )
        throw error();
      await input.authorize();
      target.guard();
      const result = await input.database.execute(
        `INSERT INTO tenant_backup_restore_targets
        (id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint,owner,fencing_token,lease_expires_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,'loading')`,
        [...target.identityParams(), lease.owner, lease.fencingToken, lease.expiresAt]
      );
      if (!result.success) throw error();
    } else {
      // Only the currently authorized coordinator can hand a target to a newer operation fence.
      const result = await input.database.execute(
        `UPDATE tenant_backup_restore_targets SET
        owner=?,fencing_token=?,lease_expires_at=? WHERE id=? AND tenant_id=? AND operation_id=?
        AND resource_id=? AND plan_digest=? AND seed_fingerprint=? AND ${mode === 'write' ? "state='loading'" : mode === 'verify' ? "state='sealed'" : "state IN ('loading','sealed')"}
        AND (fencing_token<? OR (fencing_token=? AND owner=? AND lease_expires_at<=?))`,
        [
          lease.owner,
          lease.fencingToken,
          lease.expiresAt,
          ...target.identityParams(),
          lease.fencingToken,
          lease.fencingToken,
          lease.owner,
          lease.expiresAt,
        ]
      );
      if (!result.success || result.rowsAffected !== 1) throw error();
    }
    await target.assertLive();
    return target;
  }
  private identityParams(): string[] {
    const i = this.identity;
    return [i.id, i.tenantId, i.operationId, i.resourceId, i.planDigest, i.seedFingerprint];
  }
  private guard(): unknown[] {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now >= this.lease.expiresAt) throw error();
    return [...this.identityParams(), this.lease.owner, this.lease.fencingToken, now];
  }
  private guardSql(): string {
    return this.mode === 'write' ? GUARD : this.mode === 'verify' ? SEALED_GUARD : SEALABLE_GUARD;
  }
  private async assertLive(): Promise<void> {
    await this.authorize();
    if (!(await this.database.queryOne(`SELECT 1 AS live WHERE ${this.guardSql()}`, this.guard())))
      throw error();
  }
  /** No replacement/upsert: exact retries succeed, conflicting pre-existing rows stop the restore. */
  async writeRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string
  ): Promise<void> {
    if (this.mode !== 'write') throw error();
    await this.checkRow(policy, manifest, rowJson, true);
  }
  /** Readback only: missing or changed rows fail without repairing them during verification. */
  async verifyRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string
  ): Promise<void> {
    await this.checkRow(policy, manifest, rowJson, false);
  }
  /** Complete nullable self references after every row in the same dataset exists. */
  async restoreDeferredRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string
  ): Promise<void> {
    if (this.mode !== 'write' || !policy.deferredColumns?.length) throw error();
    ({ policy, manifest } = await this.validateRow(policy, manifest, rowJson));
    const parsed = JSON.parse(rowJson) as Record<string, unknown>;
    const restoredRowJson = this.applyRestoreOverrides(policy, rowJson);
    const deferred = policy.deferredColumns;
    if (!deferred?.length) throw error();
    if (await this.rowMatches(policy, restoredRowJson)) return;
    const values = sqliteSnapshotRowInsert(
      policy.schema.table,
      deferred,
      JSON.stringify(Object.fromEntries(deferred.map((column) => [column, parsed[column]])))
    );
    const expressions = values.sql.slice(values.sql.indexOf(' VALUES (') + 9, -1).split(', ');
    const key = sqliteSnapshotRowInsert(
      policy.schema.table,
      policy.schema.primaryKey,
      JSON.stringify(
        Object.fromEntries(policy.schema.primaryKey.map((column) => [column, parsed[column]]))
      )
    );
    const keyExpressions = key.sql.slice(key.sql.indexOf(' VALUES (') + 9, -1).split(', ');
    const assignments = deferred.map((column, index) => `"${column}"=${expressions[index]}`);
    const predicate = policy.schema.primaryKey
      .map((column, index) => `"${column}" IS ${keyExpressions[index]}`)
      .join(' AND ');
    await this.assertLive();
    const result = await this.database.execute(
      `UPDATE "${policy.schema.table}" SET ${assignments.join(', ')} WHERE ${this.guardSql()} AND ${predicate}`,
      [...values.params, ...this.guard(), ...key.params]
    );
    if (!result.success || result.rowsAffected !== 1) throw error();
    if (!(await this.rowMatches(policy, restoredRowJson))) throw error();
  }

  private applyRestoreOverrides(policy: SqliteDatasetInspectionPolicy, rowJson: string): string {
    if (!policy.restoreOverrides) return rowJson;
    const row = JSON.parse(rowJson) as Record<string, unknown>;
    for (const [column, value] of Object.entries(policy.restoreOverrides)) row[column] = value;
    return JSON.stringify(row);
  }

  private async validateRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string
  ): Promise<{ policy: SqliteDatasetInspectionPolicy; manifest: TenantBundleManifest }> {
    policy = {
      ...structuredClone({ ...policy, inspectRow: undefined }),
      inspectRow: policy.inspectRow,
    };
    manifest = structuredClone(manifest);
    if (
      manifest.source.tenantId !== this.identity.tenantId ||
      !manifest.datasets.some(
        (dataset) =>
          dataset.id === policy.dataset.id &&
          dataset.module === policy.dataset.module &&
          dataset.schemaVersion === policy.dataset.schemaVersion &&
          dataset.store === 'database' &&
          dataset.disposition === 'include'
      )
    )
      throw error();
    await this.assertLive();
    const inspector = await createSqliteDatasetInspectorFactory(policy)(policy.dataset, manifest);
    try {
      const bytes = new TextEncoder().encode(rowJson + '\n');
      if (bytes.length > 256 * 1024) throw error();
      const inspected = await inspector.chunk(bytes, 0);
      if (inspected.records.length !== 1) throw error();
      await inspector.finish();
    } finally {
      await inspector.dispose();
    }
    return { policy, manifest };
  }

  private async checkRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    write: boolean
  ): Promise<void> {
    ({ policy, manifest } = await this.validateRow(policy, manifest, rowJson));
    let storedRowJson = this.applyRestoreOverrides(policy, rowJson);
    if (write && policy.deferredColumns?.length) {
      const row = JSON.parse(rowJson) as Record<string, unknown>;
      for (const column of policy.deferredColumns) row[column] = ['null', null];
      storedRowJson = JSON.stringify(row);
    }
    const insert = sqliteSnapshotRowInsert(
      policy.schema.table,
      policy.schema.columns,
      storedRowJson
    );
    if (write) {
      const keyInsert = sqliteSnapshotRowInsert(
        policy.schema.table,
        policy.schema.primaryKey,
        JSON.stringify(
          Object.fromEntries(
            policy.schema.primaryKey.map((column) => [
              column,
              (JSON.parse(storedRowJson) as Record<string, unknown>)[column],
            ])
          )
        )
      );
      const expressions = keyInsert.sql
        .slice(keyInsert.sql.indexOf(' VALUES (') + 9, -1)
        .split(', ');
      const predicate = policy.schema.primaryKey
        .map((column, i) => `"${column}" IS ${expressions[i]}`)
        .join(' AND ');
      const sql =
        insert.sql.replace(' VALUES (', ' SELECT ').slice(0, -1) +
        ` WHERE ${this.guardSql()} AND NOT EXISTS (SELECT 1 FROM "${policy.schema.table}" WHERE ${predicate})`;
      await this.assertLive();
      const result = await this.database.execute(sql, [
        ...insert.params,
        ...this.guard(),
        ...keyInsert.params,
      ]);
      if (!result.success) throw error();
    }
    if (!(await this.rowMatches(policy, storedRowJson))) throw error();
    await this.assertLive();
  }

  /** Compare stored values and storage types, including integer precision and blob bytes. */
  private async rowMatches(
    policy: SqliteDatasetInspectionPolicy,
    rowJson: string
  ): Promise<boolean> {
    const insert = sqliteSnapshotRowInsert(policy.schema.table, policy.schema.columns, rowJson);
    const values = insert.sql.slice(insert.sql.indexOf(' VALUES (') + 9, -1).split(', ');
    const parsed: unknown = JSON.parse(rowJson);
    const row = parsed as Record<string, readonly [string, unknown]>;
    const ignored = new Set(policy.verificationIgnoredColumns ?? []);
    const comparisons = policy.schema.columns.flatMap((column, i) =>
      ignored.has(column)
        ? []
        : [`typeof("${column}")=? AND "${column}" COLLATE BINARY IS ${values[i]}`]
    );
    if (!comparisons.length) throw error();
    const params: unknown[] = [];
    let position = 0;
    for (const column of policy.schema.columns) {
      const parameterized =
        !['Inf', '-Inf'].includes(String(row[column][1])) || row[column][0] !== 'real';
      const parameter = parameterized ? insert.params[position++] : undefined;
      if (ignored.has(column)) continue;
      params.push(row[column][0]);
      if (parameterized) params.push(parameter);
    }
    return Boolean(
      await this.database.queryOne(
        `SELECT 1 AS matches FROM "${policy.schema.table}" WHERE ${comparisons.join(' AND ')} AND ${this.guardSql()}`,
        [...params, ...this.guard()]
      )
    );
  }
  /** Verify the complete selected tenant dataset, after all of its expected rows were read back. */
  async verifyDataset(policy: SqliteDatasetInspectionPolicy, expectedRows: number): Promise<void> {
    const { schema, tenantKey } = structuredClone({
      schema: policy.schema,
      tenantKey: policy.tenantKey,
    });
    if (
      !Number.isSafeInteger(expectedRows) ||
      expectedRows < 0 ||
      !/^[a-z][a-z0-9_]*$/.test(schema.table)
    )
      throw error();
    function ownership(value: typeof schema): BackupRowOwnership {
      if ('parent' in value)
        return {
          kind: 'parent',
          table: value.parent.schema.table,
          keys: value.parent.schema.primaryKey.map((parent, i) => ({
            parent,
            child: value.parent.childColumns[i],
          })),
          ownership: ownership(value.parent.schema),
        };
      return value.scopeTypeColumn
        ? { kind: 'scope', typeColumn: value.scopeTypeColumn, idColumn: value.tenantColumn }
        : {
            kind: 'tenant',
            column: value.tenantColumn,
            identity: value.tenantIdentity ?? 'tenantId',
          };
    }
    const predicate = backupOwnershipPredicate(ownership(schema), {
      tenantId: this.identity.tenantId,
      tenantKey: tenantKey ?? this.identity.tenantId,
    });
    // tenantKey must not silently fall back when it is actually used as the owner identity.
    const direct = 'parent' in schema ? schema.parent.schema : schema;
    if (direct.tenantIdentity === 'tenantKey' && !tenantKey) throw error();
    await this.assertLive();
    const count = await this.database.queryOne<{ total: number }>(
      `SELECT count(*) AS total FROM "${schema.table}" AS backup_row WHERE ${predicate.sql} AND ${this.guardSql()}`,
      [...predicate.params, ...this.guard()]
    );
    if (!count || count.total !== expectedRows) throw error();
    if (
      await this.database.queryOne('SELECT 1 AS invalid FROM pragma_foreign_key_check(?) LIMIT 1', [
        schema.table,
      ])
    )
      throw error();
    await this.assertLive();
  }
  /** Freeze this target against further importer writes; this is not application activation. */
  async seal(): Promise<void> {
    if (this.mode === 'verify') throw error();
    await this.authorize();
    const result = await this.database.execute(
      `UPDATE tenant_backup_restore_targets SET state='sealed'
      WHERE ${SEALABLE_GUARD} AND id=?`,
      [...this.guard(), this.identity.id]
    );
    if (!result.success || result.rowsAffected !== 1) throw error();
    if (!(await this.database.queryOne(`SELECT 1 AS sealed WHERE ${SEALED_GUARD}`, this.guard())))
      throw error();
    await this.authorize();
  }
}

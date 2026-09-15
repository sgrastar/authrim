import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBundleReferenceIndex } from './bundle-validation';
import type { TenantBackupLease } from './operation-store';
import type { TenantPortableDependency, TenantPortableRecordIdentity } from './reference-contract';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
const PAGE_SIZE = 100;
const ACTIVE = `EXISTS (SELECT 1 FROM tenant_backup_validation_sessions s
  JOIN tenant_backup_operations o ON o.id=s.operation_id AND o.tenant_id=s.tenant_id
  WHERE s.id=? AND s.tenant_id=? AND s.state IN ('open','sealed') AND s.fencing_token=?
  AND o.state='running' AND o.lease_owner=? AND o.fencing_token=s.fencing_token
  AND o.lease_expires_at>? AND o.updated_at<=?)`;

/** DB-backed scratch identities/edges. Every normal operation checks the live lease. */
export class DatabaseTenantBundleReferenceIndex implements TenantBundleReferenceIndex {
  private disposed = false;
  private constructor(
    private readonly database: Database,
    readonly sessionId: string,
    private readonly lease: TenantBackupLease,
    private readonly now: () => number
  ) {}

  static async create(
    database: Database,
    lease: TenantBackupLease,
    now: () => number
  ): Promise<DatabaseTenantBundleReferenceIndex> {
    const id = crypto.randomUUID();
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error('backup_validation_index_clock');
    const row = await database.queryOne<{ id: string }>(
      `INSERT INTO tenant_backup_validation_sessions
      (id,tenant_id,operation_id,fencing_token,state,created_at)
      SELECT ?,tenant_id,id,fencing_token,'open',? FROM tenant_backup_operations
      WHERE tenant_id=? AND id=? AND state='running' AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=?
      RETURNING id`,
      [
        id,
        timestamp,
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    if (!row) throw new Error('backup_validation_index_fenced');
    return new DatabaseTenantBundleReferenceIndex(database, id, { ...lease }, now);
  }

  /**
   * Product coordinators derive a stable session ID from the sealed input inventory. If the
   * INSERT response is lost, retry adopts that exact session and never creates a parallel index.
   */
  static async createOrResume(
    database: Database,
    sessionId: string,
    lease: TenantBackupLease,
    now: () => number
  ): Promise<DatabaseTenantBundleReferenceIndex> {
    const timestamp = now();
    if (
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(sessionId) ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0
    )
      throw new Error('backup_validation_index_invalid_resume');
    await database.queryOne<{ id: string }>(
      `INSERT INTO tenant_backup_validation_sessions
      (id,tenant_id,operation_id,fencing_token,state,created_at)
      SELECT ?,tenant_id,id,fencing_token,'open',? FROM tenant_backup_operations
      WHERE tenant_id=? AND id=? AND state='running' AND lease_owner=? AND fencing_token=?
      AND lease_expires_at>? AND updated_at<=? ON CONFLICT(id) DO NOTHING RETURNING id`,
      [
        sessionId,
        timestamp,
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    return this.resume(database, sessionId, lease, now);
  }

  /** Resume only the session pinned in the operation's durable validation checkpoint. */
  static async resume(
    database: Database,
    sessionId: string,
    lease: TenantBackupLease,
    now: () => number
  ): Promise<DatabaseTenantBundleReferenceIndex> {
    const timestamp = now();
    if (!sessionId || !Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error('backup_validation_index_invalid_resume');
    const resumed = await database.queryOne<{ id: string }>(
      `UPDATE tenant_backup_validation_sessions SET fencing_token=? WHERE id=? AND tenant_id=? AND operation_id=? AND fencing_token<=? AND state IN ('open','sealed')
      AND EXISTS (SELECT 1 FROM tenant_backup_operations o WHERE o.id=? AND o.tenant_id=? AND o.state='running' AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?) RETURNING id`,
      [
        lease.fencingToken,
        sessionId,
        lease.tenantId,
        lease.operationId,
        lease.fencingToken,
        lease.operationId,
        lease.tenantId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    if (!resumed) throw new Error('backup_validation_index_fenced');
    return new DatabaseTenantBundleReferenceIndex(database, sessionId, { ...lease }, now);
  }

  private params(): unknown[] {
    if (this.disposed) throw new Error('backup_validation_index_closed');
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error('backup_validation_index_clock');
    return [
      this.sessionId,
      this.lease.tenantId,
      this.lease.fencingToken,
      this.lease.owner,
      timestamp,
      timestamp,
    ];
  }

  /** One bounded cleanup slice, recoverable using only the operation's current lease. */
  static async cleanupAbandonedPage(
    database: Database,
    lease: TenantBackupLease,
    now: () => number
  ): Promise<{ found: boolean; done: boolean }> {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error('backup_validation_index_clock');
    // An older generation is permanently fenced. Never collect the current validator's
    // open/sealed session merely because a cleanup task is observing the operation.
    const session = await database.queryOne<{ id: string; fencing_token: number }>(
      `UPDATE tenant_backup_validation_sessions SET state='deleting'
      WHERE id=(SELECT s.id FROM tenant_backup_validation_sessions s
        JOIN tenant_backup_operations o ON o.id=s.operation_id AND o.tenant_id=s.tenant_id
        WHERE o.id=? AND o.tenant_id=? AND o.state IN ('running','cancelling')
        AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
        AND (s.state='deleting' OR s.fencing_token<o.fencing_token)
        AND (o.state='cancelling' OR NOT EXISTS (SELECT 1 FROM tenant_backup_input_validations v WHERE v.session_id=s.id AND v.operation_id=o.id AND v.tenant_id=o.tenant_id))
        ORDER BY s.created_at,s.id LIMIT 1)
      RETURNING id,fencing_token`,
      [lease.operationId, lease.tenantId, lease.owner, lease.fencingToken, timestamp, timestamp]
    );
    if (!session) {
      const active = await database.queryOne<{ id: string }>(
        `SELECT id FROM tenant_backup_operations WHERE id=? AND tenant_id=?
        AND state IN ('running','cancelling') AND lease_owner=? AND fencing_token=?
        AND lease_expires_at>? AND updated_at<=?`,
        [lease.operationId, lease.tenantId, lease.owner, lease.fencingToken, timestamp, timestamp]
      );
      if (!active) throw new Error('backup_validation_index_fenced');
      return { found: false, done: true };
    }
    const cleanup = new DatabaseTenantBundleReferenceIndex(
      database,
      session.id,
      { ...lease, fencingToken: session.fencing_token },
      now
    );
    cleanup.disposed = true;
    return { found: true, done: await cleanup.cleanupPage() };
  }

  private identity(record: TenantPortableRecordIdentity): void {
    if (
      !record ||
      record.tenantId !== this.lease.tenantId ||
      typeof record.module !== 'string' ||
      !record.module.length ||
      record.module.length > 256 ||
      typeof record.collection !== 'string' ||
      !record.collection.length ||
      record.collection.length > 256 ||
      typeof record.id !== 'string' ||
      !record.id.length ||
      record.id.length > 4096
    )
      throw new Error('backup_validation_index_identity');
  }

  async record(bundleId: string, record: TenantPortableRecordIdentity): Promise<boolean> {
    this.identity(record);
    const result = await this.database.queryOne<{ record_id: string }>(
      `INSERT INTO tenant_backup_validation_records
      (session_id,tenant_id,module,collection,record_id,bundle_id)
      SELECT ?,?,?,?,?,? WHERE ${ACTIVE} AND EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE id=? AND state='open')
      ON CONFLICT(session_id,module,collection,record_id) DO NOTHING RETURNING record_id`,
      [
        this.sessionId,
        this.lease.tenantId,
        record.module,
        record.collection,
        record.id,
        bundleId,
        ...this.params(),
        this.sessionId,
      ]
    );
    // A duplicate and a lost lease both block validation; neither is an empty success.
    return result !== null;
  }

  /** Stable source positions are internal bundle/dataset/row identities, never arbitrary user IDs. */
  async recordOnce(
    bundleId: string,
    sourceId: string,
    record: TenantPortableRecordIdentity
  ): Promise<boolean> {
    this.identity(record);
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(sourceId))
      throw new Error('backup_validation_index_source');
    await this.database.queryOne(
      `INSERT INTO tenant_backup_validation_records(session_id,tenant_id,module,collection,record_id,bundle_id,source_id)
      SELECT ?,?,?,?,?,?,? WHERE ${ACTIVE} AND EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE id=? AND state='open')
      ON CONFLICT DO NOTHING RETURNING record_id`,
      [
        this.sessionId,
        this.lease.tenantId,
        record.module,
        record.collection,
        record.id,
        bundleId,
        sourceId,
        ...this.params(),
        this.sessionId,
      ]
    );
    const saved = await this.database.queryOne<{ source_id: string; bundle_id: string }>(
      `SELECT source_id,bundle_id FROM tenant_backup_validation_records WHERE session_id=? AND tenant_id=? AND module=? AND collection=? AND record_id=? AND ${ACTIVE} AND EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE id=? AND state='open')`,
      [
        this.sessionId,
        this.lease.tenantId,
        record.module,
        record.collection,
        record.id,
        ...this.params(),
        this.sessionId,
      ]
    );
    return saved?.source_id === sourceId && saved.bundle_id === bundleId;
  }

  /** A deterministic source-edge ID makes partial inspection retries idempotent. */
  async referenceOnce(
    bundleId: string,
    sourceEdgeId: string,
    dependency: TenantPortableDependency
  ): Promise<void> {
    this.identity(dependency.from);
    this.identity(dependency.to);
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(sourceEdgeId))
      throw new Error('backup_validation_index_source');
    const json = JSON.stringify(dependency);
    if (json.length > 20000) throw new Error('backup_validation_index_reference_size');
    const id = `source:${bundleId}:${sourceEdgeId}`;
    await this.database.queryOne(
      `INSERT INTO tenant_backup_validation_references(session_id,id,tenant_id,bundle_id,dependency_json)
      SELECT ?,?,?,?,? WHERE ${ACTIVE} AND EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE id=? AND state='open')
      ON CONFLICT(session_id,id) DO NOTHING RETURNING id`,
      [this.sessionId, id, this.lease.tenantId, bundleId, json, ...this.params(), this.sessionId]
    );
    const saved = await this.database.queryOne<{ dependency_json: string; bundle_id: string }>(
      `SELECT dependency_json,bundle_id FROM tenant_backup_validation_references WHERE session_id=? AND tenant_id=? AND id=? AND ${ACTIVE} AND EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE id=? AND state='open')`,
      [this.sessionId, this.lease.tenantId, id, ...this.params(), this.sessionId]
    );
    if (!saved || saved.dependency_json !== json || saved.bundle_id !== bundleId)
      throw new Error('backup_validation_index_retry_conflict');
  }

  async hasRecord(record: TenantPortableRecordIdentity, bundleId?: string): Promise<boolean> {
    this.identity(record);
    const row = await this.database.queryOne<{ active: number; found: number }>(
      `SELECT
      ${ACTIVE} AS active,
      EXISTS (SELECT 1 FROM tenant_backup_validation_records WHERE session_id=? AND tenant_id=? AND module=? AND collection=? AND record_id=? AND (? IS NULL OR bundle_id=?)) AS found`,
      [
        ...this.params(),
        this.sessionId,
        this.lease.tenantId,
        record.module,
        record.collection,
        record.id,
        bundleId ?? null,
        bundleId ?? null,
      ]
    );
    if (!row?.active) throw new Error('backup_validation_index_fenced');
    return Boolean(row.found);
  }

  async reference(bundleId: string, dependency: TenantPortableDependency): Promise<void> {
    this.identity(dependency.from);
    this.identity(dependency.to);
    const json = JSON.stringify(dependency);
    if (json.length > 20000) throw new Error('backup_validation_index_reference_size');
    const row = await this.database.queryOne<{ id: string }>(
      `INSERT INTO tenant_backup_validation_references
      (session_id,id,tenant_id,bundle_id,dependency_json) SELECT ?,?,?,?,? WHERE ${ACTIVE} AND EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE id=? AND state='open') RETURNING id`,
      [
        this.sessionId,
        crypto.randomUUID(),
        this.lease.tenantId,
        bundleId,
        json,
        ...this.params(),
        this.sessionId,
      ]
    );
    if (!row) throw new Error('backup_validation_index_fenced');
  }

  /** Seal before scanning; only a persisted session-owned cursor may select a later page. */
  async referencesPage(after = ''): Promise<{
    entries: { id: string; bundleId: string; dependency: TenantPortableDependency }[];
    nextCursor: string;
    done: boolean;
  }> {
    if (typeof after !== 'string' || after.length > 4096)
      throw new Error('backup_validation_index_cursor');
    const sealed = await this.database.queryOne<{ id: string }>(
      `UPDATE tenant_backup_validation_sessions SET state='sealed' WHERE id=? AND tenant_id=? AND ${ACTIVE} RETURNING id`,
      [this.sessionId, this.lease.tenantId, ...this.params()]
    );
    if (!sealed) throw new Error('backup_validation_index_fenced');
    const rows = await this.database.query<{
      id: string;
      bundle_id: string;
      dependency_json: string;
    }>(
      `SELECT id,bundle_id,dependency_json FROM tenant_backup_validation_references WHERE session_id=? AND tenant_id=? AND id>? AND ${ACTIVE} ORDER BY id LIMIT ?`,
      [this.sessionId, this.lease.tenantId, after, ...this.params(), PAGE_SIZE]
    );
    const active = await this.database.queryOne<{ active: number }>(
      `SELECT ${ACTIVE} AS active`,
      this.params()
    );
    if (!active?.active) throw new Error('backup_validation_index_fenced');
    return {
      entries: rows.map((row) => ({
        id: row.id,
        bundleId: row.bundle_id,
        dependency: JSON.parse(row.dependency_json) as TenantPortableDependency,
      })),
      nextCursor: rows.length ? rows[rows.length - 1].id : after,
      done: rows.length < PAGE_SIZE,
    };
  }

  async *references(): AsyncGenerator<{ bundleId: string; dependency: TenantPortableDependency }> {
    let after = '';
    while (true) {
      const page = await this.referencesPage(after);
      for (const { bundleId, dependency } of page.entries) yield { bundleId, dependency };
      if (page.done) return;
      after = page.nextCursor;
    }
  }

  /** Logical disposal is immediate. Bounded physical cleanup leaves a durable deleting marker. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.database.execute(
      `UPDATE tenant_backup_validation_sessions SET state='deleting' WHERE id=? AND tenant_id=? AND fencing_token=?`,
      [this.sessionId, this.lease.tenantId, this.lease.fencingToken]
    );
    await this.cleanupPage();
  }

  /** Caller-owned session only; stale workers may clean their own isolated scratch generation. */
  async cleanupPage(): Promise<boolean> {
    for (const table of [
      'tenant_backup_validation_references',
      'tenant_backup_validation_records',
    ]) {
      await this.database.execute(
        `DELETE FROM ${table} WHERE rowid IN
        (SELECT rowid FROM ${table} WHERE session_id=? AND tenant_id=? AND
          EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE id=? AND tenant_id=? AND fencing_token=? AND state='deleting') LIMIT ?)`,
        [
          this.sessionId,
          this.lease.tenantId,
          this.sessionId,
          this.lease.tenantId,
          this.lease.fencingToken,
          PAGE_SIZE,
        ]
      );
    }
    const removed = await this.database.queryOne<{ id: string }>(
      `DELETE FROM tenant_backup_validation_sessions
      WHERE id=? AND tenant_id=? AND fencing_token=? AND state='deleting'
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_validation_records WHERE session_id=?)
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_validation_references WHERE session_id=?) RETURNING id`,
      [this.sessionId, this.lease.tenantId, this.lease.fencingToken, this.sessionId, this.sessionId]
    );
    if (removed) return true;
    const remaining = await this.database.queryOne<{ id: string }>(
      'SELECT id FROM tenant_backup_validation_sessions WHERE id=? AND tenant_id=? AND fencing_token=?',
      [this.sessionId, this.lease.tenantId, this.lease.fencingToken]
    );
    return remaining === null;
  }
}

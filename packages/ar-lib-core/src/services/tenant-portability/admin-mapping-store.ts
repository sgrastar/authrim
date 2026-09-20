import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupOperation } from './operation-store';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
const PAGE_SIZE = 100;

interface HeadRow {
  revision: number;
  state: 'open' | 'frozen';
  sealed_digest: string | null;
}
interface ApprovedHeadRow extends HeadRow {
  approved_by: string | null;
  approved_at: number | null;
  approval_operation_revision: number | null;
}

interface CountRow {
  source_count: number;
  mapped_count: number;
}

interface OperationSelectionRow {
  kind: string;
  request_json: string;
}

export interface TenantBackupAdminMappingStatus {
  revision: number;
  state: 'open' | 'frozen';
  sourceCount: number;
  mappedCount: number;
  complete: boolean;
  digest: string | null;
}

export interface TenantBackupAdminMappingSource {
  sourceAdminId: string;
  targetAdminId: string | null;
  targetEmail: string | null;
  targetName: string | null;
}

export interface TenantBackupAdminMappingTarget {
  id: string;
  email: string;
  name: string | null;
}

function identifier(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value))
    throw new Error('backup_admin_mapping_invalid');
}

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('backup_admin_mapping_invalid');
}

function count(value: CountRow | null): CountRow {
  if (
    !value ||
    !Number.isSafeInteger(value.source_count) ||
    value.source_count < 0 ||
    !Number.isSafeInteger(value.mapped_count) ||
    value.mapped_count < 0 ||
    value.mapped_count > value.source_count
  )
    throw new Error('backup_admin_mapping_invalid');
  return value;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Durable one-to-one mapping from validated source Admin IDs to active target Admin accounts. */
export class TenantBackupAdminMappingStore {
  constructor(private readonly database: Database) {}

  private async ensureOpen(
    tenantId: string,
    operationId: string,
    actorId: string,
    now: number
  ): Promise<HeadRow> {
    for (const value of [tenantId, operationId, actorId]) identifier(value);
    timestamp(now);
    await this.database.execute(
      `INSERT INTO tenant_backup_admin_mapping_heads
      (operation_id,tenant_id,created_by,created_at,updated_by,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`,
      [operationId, tenantId, actorId, now, actorId, now]
    );
    const head = await this.database.queryOne<HeadRow>(
      `SELECT revision,state,sealed_digest FROM tenant_backup_admin_mapping_heads
       WHERE operation_id=? AND tenant_id=?`,
      [operationId, tenantId]
    );
    if (!head || head.state !== 'open' || head.sealed_digest !== null)
      throw new Error('backup_admin_mapping_not_open');
    return head;
  }

  private async counts(tenantId: string, operationId: string): Promise<CountRow> {
    return count(
      await this.database.queryOne<CountRow>(
        `SELECT
          (SELECT count(*) FROM tenant_backup_validation_records r
           JOIN tenant_backup_input_validations v
             ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
           WHERE v.operation_id=? AND v.tenant_id=?
             AND r.collection='admin.admin_users') AS source_count,
          (SELECT count(*) FROM tenant_backup_admin_mappings
           WHERE operation_id=? AND tenant_id=?) AS mapped_count`,
        [operationId, tenantId, operationId, tenantId]
      )
    );
  }

  async status(tenantId: string, operationId: string): Promise<TenantBackupAdminMappingStatus> {
    identifier(tenantId);
    identifier(operationId);
    const [head, totals] = await Promise.all([
      this.database.queryOne<HeadRow>(
        `SELECT revision,state,sealed_digest FROM tenant_backup_admin_mapping_heads
         WHERE operation_id=? AND tenant_id=?`,
        [operationId, tenantId]
      ),
      this.counts(tenantId, operationId),
    ]);
    if (
      head &&
      (!Number.isSafeInteger(head.revision) ||
        head.revision < 0 ||
        !['open', 'frozen'].includes(head.state) ||
        (head.sealed_digest !== null && !/^[a-f0-9]{64}$/.test(head.sealed_digest)))
    )
      throw new Error('backup_admin_mapping_invalid');
    return {
      revision: head?.revision ?? 0,
      state: head?.state ?? 'open',
      sourceCount: totals.source_count,
      mappedCount: totals.mapped_count,
      complete: totals.source_count === totals.mapped_count,
      digest: head?.sealed_digest ?? null,
    };
  }

  async listSources(
    tenantId: string,
    operationId: string,
    after = ''
  ): Promise<{ entries: TenantBackupAdminMappingSource[]; nextCursor: string; done: boolean }> {
    identifier(tenantId);
    identifier(operationId);
    if (typeof after !== 'string' || after.length > 256)
      throw new Error('backup_admin_mapping_cursor');
    const rows = await this.database.query<{
      source_admin_id: string;
      target_admin_id: string | null;
      target_email: string | null;
      target_name: string | null;
    }>(
      `SELECT json_extract(r.record_id,'$[0][1]') AS source_admin_id,
        m.target_admin_id,u.email AS target_email,u.name AS target_name
       FROM tenant_backup_validation_records r
       JOIN tenant_backup_input_validations v
         ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
       LEFT JOIN tenant_backup_admin_mappings m
         ON m.operation_id=v.operation_id AND m.tenant_id=v.tenant_id
         AND json_array(json_array('text',m.source_admin_id))=r.record_id
       LEFT JOIN admin_users u ON u.id=m.target_admin_id AND u.tenant_id=m.tenant_id
       WHERE v.operation_id=? AND v.tenant_id=? AND r.collection='admin.admin_users'
         AND json_extract(r.record_id,'$[0][0]')='text'
         AND typeof(json_extract(r.record_id,'$[0][1]'))='text'
         AND json_extract(r.record_id,'$[0][1]')>?
       ORDER BY source_admin_id LIMIT ?`,
      [operationId, tenantId, after, PAGE_SIZE]
    );
    if (
      rows.some(
        (row) =>
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(row.source_admin_id) ||
          (row.target_admin_id !== null && !/^[A-Za-z0-9_.:-]{1,256}$/.test(row.target_admin_id)) ||
          (row.target_email !== null && typeof row.target_email !== 'string') ||
          (row.target_name !== null && typeof row.target_name !== 'string')
      )
    )
      throw new Error('backup_admin_mapping_invalid');
    return {
      entries: rows.map((row) => ({
        sourceAdminId: row.source_admin_id,
        targetAdminId: row.target_admin_id,
        targetEmail: row.target_email,
        targetName: row.target_name,
      })),
      nextCursor: rows.at(-1)?.source_admin_id ?? after,
      done: rows.length < PAGE_SIZE,
    };
  }

  async listTargets(
    tenantId: string,
    after = ''
  ): Promise<{ entries: TenantBackupAdminMappingTarget[]; nextCursor: string; done: boolean }> {
    identifier(tenantId);
    if (typeof after !== 'string' || after.length > 256)
      throw new Error('backup_admin_mapping_cursor');
    const rows = await this.database.query<{ id: string; email: string; name: string | null }>(
      `SELECT id,email,name FROM admin_users
       WHERE tenant_id=? AND is_active=1 AND status='active' AND id>?
       ORDER BY id LIMIT ?`,
      [tenantId, after, PAGE_SIZE]
    );
    if (
      rows.some(
        (row) =>
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id) ||
          typeof row.email !== 'string' ||
          !row.email ||
          (row.name !== null && typeof row.name !== 'string')
      )
    )
      throw new Error('backup_admin_mapping_invalid');
    return {
      entries: rows.map((row) => ({ ...row })),
      nextCursor: rows.at(-1)?.id ?? after,
      done: rows.length < PAGE_SIZE,
    };
  }

  async map(input: {
    tenantId: string;
    operationId: string;
    sourceAdminId: string;
    targetAdminId: string;
    actorId: string;
    now: number;
  }): Promise<TenantBackupAdminMappingStatus> {
    for (const value of [
      input.tenantId,
      input.operationId,
      input.sourceAdminId,
      input.targetAdminId,
      input.actorId,
    ])
      identifier(value);
    timestamp(input.now);
    await this.ensureOpen(input.tenantId, input.operationId, input.actorId, input.now);
    const result = await this.database.execute(
      `INSERT INTO tenant_backup_admin_mappings
      (operation_id,tenant_id,source_admin_id,target_admin_id,updated_by,updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(operation_id,source_admin_id) DO UPDATE SET
        target_admin_id=excluded.target_admin_id,
        updated_by=excluded.updated_by,
        updated_at=excluded.updated_at
      WHERE tenant_backup_admin_mappings.target_admin_id<>excluded.target_admin_id`,
      [
        input.operationId,
        input.tenantId,
        input.sourceAdminId,
        input.targetAdminId,
        input.actorId,
        input.now,
      ]
    );
    if (!result.success) throw new Error('backup_admin_mapping_conflict');
    return this.status(input.tenantId, input.operationId);
  }

  private async digestMappings(
    tenantId: string,
    operationId: string,
    expectedRevision: number,
    expectedState: HeadRow['state']
  ): Promise<string> {
    let after = '';
    let digest = await sha256(JSON.stringify({ version: 1, operationId, tenantId }));
    while (true) {
      const rows = await this.database.query<{
        source_admin_id: string;
        target_admin_id: string;
      }>(
        `SELECT source_admin_id,target_admin_id FROM tenant_backup_admin_mappings
         WHERE operation_id=? AND tenant_id=? AND source_admin_id>?
         ORDER BY source_admin_id LIMIT ?`,
        [operationId, tenantId, after, PAGE_SIZE]
      );
      for (const row of rows) {
        identifier(row.source_admin_id);
        identifier(row.target_admin_id);
        digest = await sha256(JSON.stringify([digest, row.source_admin_id, row.target_admin_id]));
      }
      if (rows.length < PAGE_SIZE) break;
      after = rows.at(-1)?.source_admin_id ?? '';
      if (!after) throw new Error('backup_admin_mapping_invalid');
    }
    const head = await this.database.queryOne<HeadRow>(
      `SELECT revision,state,sealed_digest FROM tenant_backup_admin_mapping_heads
       WHERE operation_id=? AND tenant_id=?`,
      [operationId, tenantId]
    );
    if (
      !head ||
      head.state !== expectedState ||
      head.revision !== expectedRevision ||
      (expectedState === 'open'
        ? head.sealed_digest !== null
        : !head.sealed_digest || !/^[a-f0-9]{64}$/.test(head.sealed_digest))
    )
      throw new Error('backup_admin_mapping_stale');
    return digest;
  }

  /** Verify that an Admin-selected import has a complete immutable mapping before target writes. */
  async assertApproved(tenantId: string, operationId: string): Promise<void> {
    identifier(tenantId);
    identifier(operationId);
    const operation = await this.database.queryOne<OperationSelectionRow>(
      `SELECT kind,request_json FROM tenant_backup_operations WHERE id=? AND tenant_id=?`,
      [operationId, tenantId]
    );
    if (!operation || operation.kind !== 'import' || typeof operation.request_json !== 'string')
      throw new Error('backup_admin_mapping_invalid');
    let selected = false;
    try {
      const request = JSON.parse(operation.request_json) as Record<string, unknown>;
      const selection = request.selection as Record<string, unknown> | undefined;
      selected = selection?.admin === true;
    } catch {
      throw new Error('backup_admin_mapping_invalid');
    }
    if (!selected) return;
    const [head, totals, invalidTargets] = await Promise.all([
      this.database.queryOne<HeadRow>(
        `SELECT revision,state,sealed_digest FROM tenant_backup_admin_mapping_heads
         WHERE operation_id=? AND tenant_id=?`,
        [operationId, tenantId]
      ),
      this.counts(tenantId, operationId),
      this.database.queryOne<{ invalid_count: number }>(
        `SELECT count(*) AS invalid_count FROM tenant_backup_admin_mappings m
         LEFT JOIN admin_users u ON u.id=m.target_admin_id AND u.tenant_id=m.tenant_id
           AND u.is_active=1 AND u.status='active'
         WHERE m.operation_id=? AND m.tenant_id=? AND u.id IS NULL`,
        [operationId, tenantId]
      ),
    ]);
    if (
      !head ||
      head.state !== 'frozen' ||
      !head.sealed_digest ||
      !/^[a-f0-9]{64}$/.test(head.sealed_digest) ||
      totals.source_count !== totals.mapped_count ||
      !invalidTargets ||
      !Number.isSafeInteger(invalidTargets.invalid_count) ||
      invalidTargets.invalid_count !== 0
    )
      throw new Error('backup_admin_mapping_not_approved');
    const digest = await this.digestMappings(tenantId, operationId, head.revision, 'frozen');
    if (digest !== head.sealed_digest) throw new Error('backup_admin_mapping_stale');
  }

  /** Resolve one source principal through the frozen map and recheck target eligibility. */
  async resolveFrozen(
    tenantId: string,
    operationId: string,
    sourceAdminId: string
  ): Promise<string> {
    for (const value of [tenantId, operationId, sourceAdminId]) identifier(value);
    const row = await this.database.queryOne<{ target_admin_id: string }>(
      `SELECT m.target_admin_id FROM tenant_backup_admin_mappings m
       JOIN tenant_backup_admin_mapping_heads h
         ON h.operation_id=m.operation_id AND h.tenant_id=m.tenant_id
         AND h.state='frozen' AND h.sealed_digest IS NOT NULL
       JOIN admin_users u ON u.id=m.target_admin_id AND u.tenant_id=m.tenant_id
         AND u.is_active=1 AND u.status='active'
       WHERE m.operation_id=? AND m.tenant_id=? AND m.source_admin_id=?`,
      [operationId, tenantId, sourceAdminId]
    );
    if (!row) throw new Error('backup_admin_mapping_unresolved');
    identifier(row.target_admin_id);
    return row.target_admin_id;
  }

  async approve(input: {
    tenantId: string;
    operationId: string;
    actorId: string;
    operationRevision: number;
    mappingRevision: number;
    now: number;
  }): Promise<{ operation: TenantBackupOperation; mappingDigest: string }> {
    for (const value of [input.tenantId, input.operationId, input.actorId]) identifier(value);
    timestamp(input.now);
    if (
      !Number.isSafeInteger(input.operationRevision) ||
      input.operationRevision < 0 ||
      !Number.isSafeInteger(input.mappingRevision) ||
      input.mappingRevision < 0
    )
      throw new Error('backup_admin_mapping_invalid');
    const head = await this.ensureOpen(input.tenantId, input.operationId, input.actorId, input.now);
    const totals = await this.counts(input.tenantId, input.operationId);
    if (head.revision !== input.mappingRevision || totals.source_count !== totals.mapped_count)
      throw new Error('backup_admin_mapping_incomplete');
    const mappingDigest = await this.digestMappings(
      input.tenantId,
      input.operationId,
      input.mappingRevision,
      'open'
    );
    try {
      const result = await this.database.execute(
        `UPDATE tenant_backup_admin_mapping_heads SET
          state='frozen',sealed_digest=?,updated_by=?,updated_at=?,approved_by=?,approved_at=?,
          approval_operation_revision=?
         WHERE operation_id=? AND tenant_id=? AND state='open' AND revision=?`,
        [
          mappingDigest,
          input.actorId,
          input.now,
          input.actorId,
          input.now,
          input.operationRevision,
          input.operationId,
          input.tenantId,
          input.mappingRevision,
        ]
      );
      if (!result.success || result.rowsAffected !== 1)
        throw new Error('backup_admin_mapping_stale');
    } catch {
      // D1 can commit a mutation while its response is lost. Read back the complete exact
      // approval below; never retry this side effect or infer success from a partial state.
    }
    const approvedHead = await this.database.queryOne<ApprovedHeadRow>(
      `SELECT revision,state,sealed_digest,approved_by,approved_at,approval_operation_revision
       FROM tenant_backup_admin_mapping_heads WHERE operation_id=? AND tenant_id=?`,
      [input.operationId, input.tenantId]
    );
    const operation = await this.database.queryOne<TenantBackupOperation>(
      `SELECT * FROM tenant_backup_operations WHERE id=? AND tenant_id=?`,
      [input.operationId, input.tenantId]
    );
    if (
      !approvedHead ||
      approvedHead.state !== 'frozen' ||
      approvedHead.revision !== input.mappingRevision ||
      approvedHead.sealed_digest !== mappingDigest ||
      approvedHead.approved_by !== input.actorId ||
      approvedHead.approved_at !== input.now ||
      approvedHead.approval_operation_revision !== input.operationRevision ||
      !operation ||
      operation.state !== 'queued' ||
      operation.revision !== input.operationRevision + 1
    )
      throw new Error('backup_admin_mapping_stale');
    return { operation, mappingDigest };
  }
}

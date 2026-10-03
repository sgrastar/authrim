import type { DatabaseAdapter } from '../db/adapter';
import type {
  CanonicalSettingsDocument,
  SettingScope,
  SettingsCanonicalStore,
} from '../utils/settings-manager';
import { generateVersion, settingsStorageKey } from '../utils/settings-manager';
import { sanitizeObject } from '../utils/security';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;

export interface PendingSettingsProjection {
  /** Null for a platform document. */
  tenantId: string | null;
  scope: SettingScope;
  category: string;
  version: string;
  documentJson: string;
  storageKey: string;
}

interface StoredRow {
  tenant_id: string;
  scope_type: 'tenant' | 'client' | 'platform';
  scope_id: string;
  category: string;
  document_json: string;
  version: string;
}

function invalid(): never {
  throw new Error('settings_canonical_store_invalid');
}

/**
 * Where a document is kept: tenant and client documents in tenant_settings_documents, keyed by
 * tenant, scope and category; platform documents in platform_settings_documents, by category.
 * `where`/`params` select the one row.
 */
function identity(category: string, scope: SettingScope) {
  const storageKey = settingsStorageKey(category, scope);
  if (scope.type === 'platform') {
    return {
      table: 'platform_settings_documents',
      tenantId: null,
      scopeType: 'platform' as const,
      scopeId: '',
      category,
      storageKey,
      where: 'category=?',
      params: [category] as string[],
    };
  }
  const tenantId = scope.type === 'tenant' ? scope.id : scope.tenantId;
  return {
    table: 'tenant_settings_documents',
    tenantId,
    scopeType: scope.type,
    scopeId: scope.id,
    category,
    storageKey,
    where: 'tenant_id=? AND scope_type=? AND scope_id=? AND category=?',
    params: [tenantId, scope.type, scope.id, category],
  };
}

/** Both tables as one row set, for the listings the scheduled projection works through. */
function allDocuments(columns: string, where: string): string {
  return `SELECT tenant_id,scope_type,scope_id,${columns} FROM tenant_settings_documents ${where}
    UNION ALL
    SELECT '' AS tenant_id,'platform' AS scope_type,'' AS scope_id,${columns}
    FROM platform_settings_documents ${where}`;
}

function document(value: CanonicalSettingsDocument): { json: string; version: string } {
  if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) invalid();
  const data = sanitizeObject(value.data);
  const json = JSON.stringify(data);
  if (
    new TextEncoder().encode(json).byteLength > 1048576 ||
    generateVersion(data) !== value.version
  )
    invalid();
  return { json, version: value.version };
}

function decode(row: StoredRow): CanonicalSettingsDocument {
  if (new TextEncoder().encode(row.document_json).byteLength > 1048576) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document_json);
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const data = sanitizeObject(parsed as Record<string, unknown>);
  if (generateVersion(data) !== row.version) invalid();
  return { data, version: row.version };
}

function toProjection(row: StoredRow): PendingSettingsProjection {
  const scope: SettingScope =
    row.scope_type === 'platform'
      ? { type: 'platform' }
      : row.scope_type === 'tenant'
        ? { type: 'tenant', id: row.scope_id }
        : { type: 'client', tenantId: row.tenant_id, id: row.scope_id };
  const key = identity(row.category, scope);
  if ((key.tenantId ?? '') !== row.tenant_id) invalid();
  decode(row);
  return {
    tenantId: key.tenantId,
    scope,
    category: row.category,
    version: row.version,
    documentJson: row.document_json,
    storageKey: key.storageKey,
  };
}

export class DatabaseSettingsCanonicalStore implements SettingsCanonicalStore {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now
  ) {}

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) invalid();
    return value;
  }

  async load(category: string, scope: SettingScope): Promise<CanonicalSettingsDocument | null> {
    const key = identity(category, scope);
    const row = await this.database.queryOne<StoredRow>(
      key.scopeType === 'platform'
        ? `SELECT '' AS tenant_id,'platform' AS scope_type,'' AS scope_id,category,document_json,
            version FROM platform_settings_documents WHERE ${key.where}`
        : `SELECT tenant_id,scope_type,scope_id,category,document_json,version
            FROM tenant_settings_documents WHERE ${key.where}`,
      key.params
    );
    if (!row) return null;
    if (
      row.tenant_id !== (key.tenantId ?? '') ||
      row.scope_type !== key.scopeType ||
      row.scope_id !== key.scopeId ||
      row.category !== key.category
    )
      invalid();
    return decode(row);
  }

  /**
   * Several documents of one tenant or client, and whether the platform's documents of the same
   * categories (what they inherit) are copied to KV, read in one query so they are one snapshot:
   * by category, the saved version and whether its copy to KV is still pending (null where none
   * is saved), and the platform documents whose copy is pending.
   */
  async snapshot(
    categories: readonly string[],
    scope: Exclude<SettingScope, { type: 'platform' }>
  ): Promise<{
    documents: Map<string, { version: string; pending: boolean } | null>;
    platformPending: string[];
  }> {
    const keys = categories.map((category) => identity(category, scope));
    const documents = new Map<string, { version: string; pending: boolean } | null>(
      categories.map((category) => [category, null])
    );
    if (keys.length === 0) return { documents, platformPending: [] };
    const { tenantId, scopeType, scopeId } = keys[0];
    const list = keys.map(() => '?').join(',');
    const names = keys.map((key) => key.category);
    const rows = await this.database.query<{
      layer: 'own' | 'platform';
      category: string;
      version: string;
      projection_state: 'pending' | 'applied';
    }>(
      `SELECT 'own' AS layer,category,version,projection_state FROM tenant_settings_documents
        WHERE tenant_id=? AND scope_type=? AND scope_id=? AND category IN (${list})
        UNION ALL
        SELECT 'platform' AS layer,category,version,projection_state
        FROM platform_settings_documents WHERE category IN (${list})`,
      [tenantId!, scopeType, scopeId, ...names, ...names]
    );
    const platformPending: string[] = [];
    for (const row of rows) {
      if (!documents.has(row.category)) invalid();
      const pending = row.projection_state === 'pending';
      if (row.layer === 'platform') {
        if (pending) platformPending.push(row.category);
      } else {
        documents.set(row.category, { version: row.version, pending });
      }
    }
    return { documents, platformPending };
  }

  async create(
    category: string,
    scope: SettingScope,
    value: CanonicalSettingsDocument
  ): Promise<CanonicalSettingsDocument> {
    const key = identity(category, scope);
    const saved = document(value);
    const now = this.timestamp();
    // New documents queue behind existing ones for reconciliation (reconciled_at = now).
    await this.database.execute(
      key.scopeType === 'platform'
        ? `INSERT INTO platform_settings_documents
          (category,document_json,version,revision,projection_state,updated_at,projected_at,reconciled_at)
          VALUES(?,?,?,1,'pending',?,NULL,?)
          ON CONFLICT(category) DO NOTHING`
        : `INSERT INTO tenant_settings_documents
          (tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at,projected_at,reconciled_at)
          VALUES(?,?,?,?,?,?,1,'pending',?,NULL,?)
          ON CONFLICT(tenant_id,scope_type,scope_id,category) DO NOTHING`,
      [...key.params, saved.json, saved.version, now, now]
    );
    const current = await this.load(category, scope);
    if (!current) invalid();
    return current;
  }

  async compareAndSet(
    category: string,
    scope: SettingScope,
    expectedVersion: string,
    value: CanonicalSettingsDocument
  ): Promise<boolean> {
    if (!/^sha256:[0-9a-f]{16}$/.test(expectedVersion)) invalid();
    const key = identity(category, scope);
    const saved = document(value);
    const result = await this.database.execute(
      `UPDATE ${key.table}
      SET document_json=?,version=?,revision=revision+1,projection_state='pending',updated_at=?,projected_at=NULL
      WHERE ${key.where} AND version=?`,
      [saved.json, saved.version, this.timestamp(), ...key.params, expectedVersion]
    );
    return result.success && result.rowsAffected === 1;
  }

  /** Replace a document for a fenced/bootstrap workflow that has no concurrent editor. */
  async replace(
    category: string,
    scope: Exclude<SettingScope, { type: 'platform' }>,
    value: CanonicalSettingsDocument
  ): Promise<CanonicalSettingsDocument> {
    const key = identity(category, scope);
    const saved = document(value);
    const now = this.timestamp();
    await this.database.execute(
      `INSERT INTO tenant_settings_documents
      (tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at,projected_at,reconciled_at)
      VALUES(?,?,?,?,?,?,1,'pending',?,NULL,?)
      ON CONFLICT(tenant_id,scope_type,scope_id,category) DO UPDATE SET
        document_json=excluded.document_json,
        version=excluded.version,
        revision=tenant_settings_documents.revision+1,
        projection_state='pending',
        updated_at=excluded.updated_at,
        projected_at=NULL`,
      [key.tenantId, key.scopeType, key.scopeId, key.category, saved.json, saved.version, now, now]
    );
    return { data: sanitizeObject(value.data), version: saved.version };
  }

  async markProjected(category: string, scope: SettingScope, version: string): Promise<void> {
    if (!/^sha256:[0-9a-f]{16}$/.test(version)) invalid();
    const key = identity(category, scope);
    const projectedAt = this.timestamp();
    const result = await this.database.execute(
      `UPDATE ${key.table} SET projection_state='applied',
        projected_at=CASE WHEN ?>=updated_at THEN ? ELSE updated_at END
      WHERE ${key.where} AND version=?`,
      [projectedAt, projectedAt, ...key.params, version]
    );
    if (!result.success || result.rowsAffected !== 1) invalid();
  }

  async markPending(category: string, scope: SettingScope, version: string): Promise<void> {
    if (!/^sha256:[0-9a-f]{16}$/.test(version)) invalid();
    const key = identity(category, scope);
    // Only the given version: a newer save projects itself and must not be reset here.
    const result = await this.database.execute(
      `UPDATE ${key.table} SET projection_state='pending', projected_at=NULL
      WHERE ${key.where} AND version=?`,
      [...key.params, version]
    );
    if (!result.success) invalid();
  }

  async pending(limit = 25): Promise<PendingSettingsProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    const rows = await this.database.query<StoredRow>(
      `${allDocuments('category,document_json,version,updated_at', "WHERE projection_state='pending'")}
      ORDER BY updated_at,tenant_id,scope_type,scope_id,category LIMIT ?`,
      [limit]
    );
    return rows.map(toProjection);
  }

  /**
   * Documents marked projected that changed since `since` (newest first). KV has no
   * conditional write, so a slow projection of an older version can land after a newer one
   * was projected and marked; the scheduled retry compares these with KV to repair that.
   */
  async recentlyProjected(since: number, limit = 25): Promise<PendingSettingsProjection[]> {
    if (!Number.isSafeInteger(since) || since < 0) invalid();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    const rows = await this.database.query<StoredRow>(
      `${allDocuments(
        'category,document_json,version,updated_at',
        "WHERE projection_state='applied' AND updated_at>=?"
      )}
      ORDER BY updated_at DESC,tenant_id,scope_type,scope_id,category LIMIT ?`,
      [since, since, limit]
    );
    return rows.map(toProjection);
  }

  /**
   * The documents compared with KV least recently, pending or projected (oldest first). The
   * scheduled retry takes these and marks each one reconciled, so every document gets its turn
   * whatever is added, removed or failing meanwhile: new documents queue behind existing ones,
   * and one that keeps failing does not hold back the others.
   */
  async leastRecentlyReconciled(
    limit = 25
  ): Promise<Array<PendingSettingsProjection & { projectionState: 'pending' | 'applied' }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    const rows = await this.database.query<StoredRow & { projection_state: 'pending' | 'applied' }>(
      `${allDocuments('category,document_json,version,projection_state,reconciled_at', '')}
      ORDER BY reconciled_at,tenant_id,scope_type,scope_id,category LIMIT ?`,
      [limit]
    );
    return rows.map((row) => ({ ...toProjection(row), projectionState: row.projection_state }));
  }

  /** Record that a document was compared with KV (or handed to the pending retry) now. */
  async markReconciled(category: string, scope: SettingScope): Promise<void> {
    const key = identity(category, scope);
    const result = await this.database.execute(
      `UPDATE ${key.table} SET reconciled_at=max(reconciled_at,?) WHERE ${key.where}`,
      [this.timestamp(), ...key.params]
    );
    if (!result.success) invalid();
  }
}

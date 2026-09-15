import type { DatabaseAdapter } from '../db/adapter';
import type {
  CanonicalSettingsDocument,
  SettingScope,
  SettingsCanonicalStore,
} from '../utils/settings-manager';
import { generateVersion, settingsStorageKey } from '../utils/settings-manager';
import { sanitizeObject } from '../utils/security';

type ScopedSetting = Exclude<SettingScope, { type: 'platform' }>;
type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;

export interface PendingSettingsProjection {
  tenantId: string;
  scope: ScopedSetting;
  category: string;
  version: string;
  documentJson: string;
  storageKey: string;
}

interface StoredRow {
  tenant_id: string;
  scope_type: 'tenant' | 'client';
  scope_id: string;
  category: string;
  document_json: string;
  version: string;
}

function invalid(): never {
  throw new Error('settings_canonical_store_invalid');
}

function identity(category: string, scope: ScopedSetting) {
  const storageKey = settingsStorageKey(category, scope);
  const tenantId = scope.type === 'tenant' ? scope.id : scope.tenantId;
  return { tenantId, scopeType: scope.type, scopeId: scope.id, category, storageKey };
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

  async load(category: string, scope: ScopedSetting): Promise<CanonicalSettingsDocument | null> {
    const key = identity(category, scope);
    const row = await this.database.queryOne<StoredRow>(
      `SELECT tenant_id,scope_type,scope_id,category,document_json,version
      FROM tenant_settings_documents
      WHERE tenant_id=? AND scope_type=? AND scope_id=? AND category=?`,
      [key.tenantId, key.scopeType, key.scopeId, key.category]
    );
    if (!row) return null;
    if (
      row.tenant_id !== key.tenantId ||
      row.scope_type !== key.scopeType ||
      row.scope_id !== key.scopeId ||
      row.category !== key.category
    )
      invalid();
    return decode(row);
  }

  async create(
    category: string,
    scope: ScopedSetting,
    value: CanonicalSettingsDocument
  ): Promise<CanonicalSettingsDocument> {
    const key = identity(category, scope);
    const saved = document(value);
    await this.database.execute(
      `INSERT INTO tenant_settings_documents
      (tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at,projected_at)
      VALUES(?,?,?,?,?,?,1,'pending',?,NULL)
      ON CONFLICT(tenant_id,scope_type,scope_id,category) DO NOTHING`,
      [
        key.tenantId,
        key.scopeType,
        key.scopeId,
        key.category,
        saved.json,
        saved.version,
        this.timestamp(),
      ]
    );
    const current = await this.load(category, scope);
    if (!current) invalid();
    return current;
  }

  async compareAndSet(
    category: string,
    scope: ScopedSetting,
    expectedVersion: string,
    value: CanonicalSettingsDocument
  ): Promise<boolean> {
    if (!/^sha256:[0-9a-f]{16}$/.test(expectedVersion)) invalid();
    const key = identity(category, scope);
    const saved = document(value);
    const result = await this.database.execute(
      `UPDATE tenant_settings_documents
      SET document_json=?,version=?,revision=revision+1,projection_state='pending',updated_at=?,projected_at=NULL
      WHERE tenant_id=? AND scope_type=? AND scope_id=? AND category=? AND version=?`,
      [
        saved.json,
        saved.version,
        this.timestamp(),
        key.tenantId,
        key.scopeType,
        key.scopeId,
        key.category,
        expectedVersion,
      ]
    );
    return result.success && result.rowsAffected === 1;
  }

  /** Replace a document for a fenced/bootstrap workflow that has no concurrent editor. */
  async replace(
    category: string,
    scope: ScopedSetting,
    value: CanonicalSettingsDocument
  ): Promise<CanonicalSettingsDocument> {
    const key = identity(category, scope);
    const saved = document(value);
    await this.database.execute(
      `INSERT INTO tenant_settings_documents
      (tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at,projected_at)
      VALUES(?,?,?,?,?,?,1,'pending',?,NULL)
      ON CONFLICT(tenant_id,scope_type,scope_id,category) DO UPDATE SET
        document_json=excluded.document_json,
        version=excluded.version,
        revision=tenant_settings_documents.revision+1,
        projection_state='pending',
        updated_at=excluded.updated_at,
        projected_at=NULL`,
      [
        key.tenantId,
        key.scopeType,
        key.scopeId,
        key.category,
        saved.json,
        saved.version,
        this.timestamp(),
      ]
    );
    return { data: sanitizeObject(value.data), version: saved.version };
  }

  async markProjected(category: string, scope: ScopedSetting, version: string): Promise<void> {
    if (!/^sha256:[0-9a-f]{16}$/.test(version)) invalid();
    const key = identity(category, scope);
    const projectedAt = this.timestamp();
    const result = await this.database.execute(
      `UPDATE tenant_settings_documents SET projection_state='applied',
        projected_at=CASE WHEN ?>=updated_at THEN ? ELSE updated_at END
      WHERE tenant_id=? AND scope_type=? AND scope_id=? AND category=? AND version=?`,
      [projectedAt, projectedAt, key.tenantId, key.scopeType, key.scopeId, key.category, version]
    );
    if (!result.success || result.rowsAffected !== 1) invalid();
  }

  async pending(limit = 25): Promise<PendingSettingsProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    const rows = await this.database.query<StoredRow>(
      `SELECT tenant_id,scope_type,scope_id,category,document_json,version
      FROM tenant_settings_documents WHERE projection_state='pending'
      ORDER BY updated_at,tenant_id,scope_type,scope_id,category LIMIT ?`,
      [limit]
    );
    return rows.map((row) => {
      const scope: ScopedSetting =
        row.scope_type === 'tenant'
          ? { type: 'tenant', id: row.scope_id }
          : { type: 'client', tenantId: row.tenant_id, id: row.scope_id };
      const key = identity(row.category, scope);
      if (key.tenantId !== row.tenant_id) invalid();
      decode(row);
      return {
        tenantId: row.tenant_id,
        scope,
        category: row.category,
        version: row.version,
        documentJson: row.document_json,
        storageKey: key.storageKey,
      };
    });
  }
}

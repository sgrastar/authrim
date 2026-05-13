/**
 * Custom Claim Schema History Manager
 *
 * Records versioned history of changes to custom_claim_schemas.
 * Pattern reference: SettingsHistoryManager (services/settings-history.ts)
 */

import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../db';

// =============================================================================
// Types
// =============================================================================

export interface SchemaHistoryEntry {
  id: string;
  tenant_id: string;
  schema_id: string;
  version: number;
  operation: 'create' | 'update' | 'delete' | 'rename' | 'toggle_active';
  snapshot: Record<string, unknown>;
  changes: SchemaChanges;
  actor_id: string | null;
  actor_type: 'user' | 'admin' | 'system' | 'api' | null;
  change_source: 'admin_api' | 'admin_ui' | 'migration' | 'rollback' | null;
  created_at: number;
}

export interface SchemaChanges {
  added: string[];
  removed: string[];
  modified: Array<{
    key: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}

export interface RecordSchemaChangeInput {
  schemaId: string;
  tenantId: string;
  operation: 'create' | 'update' | 'delete' | 'rename' | 'toggle_active';
  previousSnapshot: Record<string, unknown> | null;
  newSnapshot: Record<string, unknown>;
  actorId?: string;
  actorType?: 'user' | 'admin' | 'system' | 'api';
  changeSource?: 'admin_api' | 'admin_ui' | 'migration' | 'rollback';
}

export interface SchemaHistoryListResult {
  versions: Array<{
    version: number;
    operation: string;
    created_at: number;
    actor_id: string | null;
    actor_type: string | null;
    change_source: string | null;
    changes_summary: {
      added: number;
      removed: number;
      modified: number;
    };
  }>;
  total: number;
}

// =============================================================================
// Helpers
// =============================================================================

function generateHistoryId(): string {
  const timestamp = Date.now().toString(36);
  const randomBytes = new Uint8Array(5);
  crypto.getRandomValues(randomBytes);
  const random = Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `csh_${timestamp}${random}`;
}

export function calculateSchemaChanges(
  oldSnapshot: Record<string, unknown> | null,
  newSnapshot: Record<string, unknown>
): SchemaChanges {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];

  const old = oldSnapshot || {};

  for (const key of Object.keys(newSnapshot)) {
    if (!(key in old)) {
      added.push(key);
    } else if (JSON.stringify(old[key]) !== JSON.stringify(newSnapshot[key])) {
      modified.push({ key, oldValue: old[key], newValue: newSnapshot[key] });
    }
  }

  for (const key of Object.keys(old)) {
    if (!(key in newSnapshot)) {
      removed.push(key);
    }
  }

  return { added, removed, modified };
}

// =============================================================================
// Manager
// =============================================================================

export class CustomClaimSchemaHistoryManager {
  private adapter: DatabaseAdapter;

  constructor(db: DatabaseSource) {
    this.adapter = ensureDatabaseAdapter(db, 'custom-claims-history');
  }

  async recordChange(input: RecordSchemaChangeInput): Promise<SchemaHistoryEntry> {
    const now = Math.floor(Date.now() / 1000);

    const lastVersion = await this.adapter.queryOne<{ version: number }>(
      `SELECT MAX(version) as version FROM custom_claim_schema_history
       WHERE tenant_id = ? AND schema_id = ?`,
      [input.tenantId, input.schemaId]
    );

    const nextVersion = (lastVersion?.version ?? 0) + 1;
    const changes = calculateSchemaChanges(input.previousSnapshot, input.newSnapshot);

    const entry: SchemaHistoryEntry = {
      id: generateHistoryId(),
      tenant_id: input.tenantId,
      schema_id: input.schemaId,
      version: nextVersion,
      operation: input.operation,
      snapshot: input.newSnapshot,
      changes,
      actor_id: input.actorId ?? null,
      actor_type: input.actorType ?? null,
      change_source: input.changeSource ?? null,
      created_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO custom_claim_schema_history (
        id, tenant_id, schema_id, version, operation, snapshot, changes,
        actor_id, actor_type, change_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.tenant_id,
        entry.schema_id,
        entry.version,
        entry.operation,
        JSON.stringify(entry.snapshot),
        JSON.stringify(entry.changes),
        entry.actor_id,
        entry.actor_type,
        entry.change_source,
        entry.created_at,
      ]
    );

    return entry;
  }

  async listVersions(
    tenantId: string,
    schemaId: string,
    limit = 50,
    offset = 0
  ): Promise<SchemaHistoryListResult> {
    const countResult = await this.adapter.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM custom_claim_schema_history
       WHERE tenant_id = ? AND schema_id = ?`,
      [tenantId, schemaId]
    );

    const rows = await this.adapter.query<{
      version: number;
      operation: string;
      created_at: number;
      actor_id: string | null;
      actor_type: string | null;
      change_source: string | null;
      changes: string;
    }>(
      `SELECT version, operation, created_at, actor_id, actor_type, change_source, changes
       FROM custom_claim_schema_history
       WHERE tenant_id = ? AND schema_id = ?
       ORDER BY version DESC
       LIMIT ? OFFSET ?`,
      [tenantId, schemaId, limit, offset]
    );

    return {
      versions: rows.map((r) => {
        let changes: SchemaChanges = { added: [], removed: [], modified: [] };
        try {
          changes = JSON.parse(r.changes);
        } catch {
          // ignore parse error
        }
        return {
          version: r.version,
          operation: r.operation,
          created_at: r.created_at,
          actor_id: r.actor_id,
          actor_type: r.actor_type,
          change_source: r.change_source,
          changes_summary: {
            added: changes.added?.length ?? 0,
            removed: changes.removed?.length ?? 0,
            modified: changes.modified?.length ?? 0,
          },
        };
      }),
      total: countResult?.total ?? 0,
    };
  }

  async getVersion(
    tenantId: string,
    schemaId: string,
    version: number
  ): Promise<SchemaHistoryEntry | null> {
    const row = await this.adapter.queryOne<{
      id: string;
      tenant_id: string;
      schema_id: string;
      version: number;
      operation: string;
      snapshot: string;
      changes: string;
      actor_id: string | null;
      actor_type: string | null;
      change_source: string | null;
      created_at: number;
    }>(
      `SELECT * FROM custom_claim_schema_history
       WHERE tenant_id = ? AND schema_id = ? AND version = ?`,
      [tenantId, schemaId, version]
    );

    if (!row) return null;

    return {
      id: row.id,
      tenant_id: row.tenant_id,
      schema_id: row.schema_id,
      version: row.version,
      operation: row.operation as SchemaHistoryEntry['operation'],
      snapshot: JSON.parse(row.snapshot),
      changes: JSON.parse(row.changes),
      actor_id: row.actor_id,
      actor_type: row.actor_type as SchemaHistoryEntry['actor_type'],
      change_source: row.change_source as SchemaHistoryEntry['change_source'],
      created_at: row.created_at,
    };
  }
}

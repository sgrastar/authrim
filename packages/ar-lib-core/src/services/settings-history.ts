/**
 * Settings History Manager
 *
 * Provides versioning and rollback capabilities for configuration changes.
 * Each settings category maintains its own version history.
 *
 * Features:
 * - Automatic version numbering
 * - Full snapshot storage for easy rollback
 * - Change diff tracking
 * - Actor accountability
 * - Configurable retention policy
 *
 * @packageDocumentation
 */

import { D1Adapter, type DatabaseAdapter } from '../db';

// =============================================================================
// Types
// =============================================================================

export interface SettingsHistoryEntry {
  id: string;
  tenantId: string;
  category: string;
  version: number;
  snapshot: Record<string, unknown>;
  changes: SettingsChanges;
  actorId: string | null;
  actorType: 'user' | 'admin' | 'system' | 'api' | null;
  changeReason: string | null;
  changeSource: 'admin_api' | 'settings_ui' | 'migration' | 'rollback' | null;
  createdAt: number;
}

export interface SettingsChanges {
  added: string[];
  removed: string[];
  modified: Array<{
    key: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}

export interface RecordChangeInput {
  category: string;
  previousSnapshot: Record<string, unknown>;
  newSnapshot: Record<string, unknown>;
  actorId?: string;
  actorType?: 'user' | 'admin' | 'system' | 'api';
  changeReason?: string;
  changeSource?: 'admin_api' | 'settings_ui' | 'migration' | 'rollback';
}

export interface ListVersionsOptions {
  limit?: number;
  offset?: number;
}

export interface ListVersionsResult {
  versions: Array<{
    version: number;
    createdAt: number;
    actorId: string | null;
    actorType: string | null;
    changeSource: string | null;
    changeReason: string | null;
    changesSummary: {
      added: number;
      removed: number;
      modified: number;
    };
  }>;
  total: number;
}

export interface RollbackInput {
  targetVersion: number;
  actorId?: string;
  actorType?: 'user' | 'admin' | 'system' | 'api';
  changeReason?: string;
}

export interface SettingsRollbackResult {
  success: boolean;
  previousVersion: number;
  currentVersion: number;
  restoredSnapshot: Record<string, unknown>;
}

export interface SettingsHistoryConfig {
  /** Maximum versions to retain per category (default: 100) */
  maxVersions?: number;
  /** Maximum retention days (default: 90) */
  retentionDays?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_VERSIONS = 100;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_TENANT_ID = 'default';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a unique ID for history entries
 */
function generateHistoryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `sh_${timestamp}${random}`;
}

/**
 * Calculate diff between two snapshots
 */
export function calculateChanges(
  oldSnapshot: Record<string, unknown>,
  newSnapshot: Record<string, unknown>
): SettingsChanges {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];

  // Find added and modified keys
  for (const key of Object.keys(newSnapshot)) {
    if (!(key in oldSnapshot)) {
      added.push(key);
    } else if (JSON.stringify(oldSnapshot[key]) !== JSON.stringify(newSnapshot[key])) {
      modified.push({
        key,
        oldValue: oldSnapshot[key],
        newValue: newSnapshot[key],
      });
    }
  }

  // Find removed keys
  for (const key of Object.keys(oldSnapshot)) {
    if (!(key in newSnapshot)) {
      removed.push(key);
    }
  }

  return { added, removed, modified };
}

// =============================================================================
// Settings History Manager
// =============================================================================

export class SettingsHistoryManager {
  private db: D1Database;
  private adapter: DatabaseAdapter;
  private tenantId: string;
  private config: SettingsHistoryConfig;

  constructor(
    db: D1Database,
    tenantId: string = DEFAULT_TENANT_ID,
    config: SettingsHistoryConfig = {}
  ) {
    this.db = db;
    this.adapter = new D1Adapter({ db });
    this.tenantId = tenantId;
    this.config = {
      maxVersions: config.maxVersions ?? DEFAULT_MAX_VERSIONS,
      retentionDays: config.retentionDays ?? DEFAULT_RETENTION_DAYS,
    };
  }

  /**
   * Record a configuration change
   */
  async recordChange(input: RecordChangeInput): Promise<SettingsHistoryEntry> {
    const now = Math.floor(Date.now() / 1000);

    // Get the next version number
    const lastVersion = await this.adapter.queryOne<{ version: number }>(
      `SELECT MAX(version) as version FROM settings_history
       WHERE tenant_id = ? AND category = ?`,
      [this.tenantId, input.category]
    );

    const nextVersion = (lastVersion?.version ?? 0) + 1;

    // Calculate changes
    const changes = calculateChanges(input.previousSnapshot, input.newSnapshot);

    // Create history entry
    const entry: SettingsHistoryEntry = {
      id: generateHistoryId(),
      tenantId: this.tenantId,
      category: input.category,
      version: nextVersion,
      snapshot: input.newSnapshot,
      changes,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? null,
      changeReason: input.changeReason ?? null,
      changeSource: input.changeSource ?? null,
      createdAt: now,
    };

    // Insert into database
    await this.adapter.execute(
      `INSERT INTO settings_history (
        id, tenant_id, category, version, snapshot, changes,
        actor_id, actor_type, change_reason, change_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.tenantId,
        entry.category,
        entry.version,
        JSON.stringify(entry.snapshot),
        JSON.stringify(entry.changes),
        entry.actorId,
        entry.actorType,
        entry.changeReason,
        entry.changeSource,
        entry.createdAt,
      ]
    );

    // Cleanup old versions if needed
    await this.cleanupOldVersions(input.category);

    return entry;
  }

  /**
   * List version history for a category
   */
  async listVersions(
    category: string,
    options: ListVersionsOptions = {}
  ): Promise<ListVersionsResult> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    // Get total count
    const countResult = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM settings_history
       WHERE tenant_id = ? AND category = ?`,
      [this.tenantId, category]
    );

    // Get versions
    const rows = await this.adapter.query<{
      version: number;
      created_at: number;
      actor_id: string | null;
      actor_type: string | null;
      change_source: string | null;
      change_reason: string | null;
      changes: string;
    }>(
      `SELECT version, created_at, actor_id, actor_type, change_source, change_reason, changes
       FROM settings_history
       WHERE tenant_id = ? AND category = ?
       ORDER BY version DESC
       LIMIT ? OFFSET ?`,
      [this.tenantId, category, limit, offset]
    );

    const versions = rows.map((row) => {
      const changes = JSON.parse(row.changes) as SettingsChanges;
      return {
        version: row.version,
        createdAt: row.created_at,
        actorId: row.actor_id,
        actorType: row.actor_type,
        changeSource: row.change_source,
        changeReason: row.change_reason,
        changesSummary: {
          added: changes.added.length,
          removed: changes.removed.length,
          modified: changes.modified.length,
        },
      };
    });

    return {
      versions,
      total: countResult?.count ?? 0,
    };
  }

  /**
   * Get a specific version's snapshot
   */
  async getVersion(category: string, version: number): Promise<SettingsHistoryEntry | null> {
    const row = await this.adapter.queryOne<{
      id: string;
      tenant_id: string;
      category: string;
      version: number;
      snapshot: string;
      changes: string;
      actor_id: string | null;
      actor_type: string | null;
      change_reason: string | null;
      change_source: string | null;
      created_at: number;
    }>(
      `SELECT * FROM settings_history
       WHERE tenant_id = ? AND category = ? AND version = ?`,
      [this.tenantId, category, version]
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      category: row.category,
      version: row.version,
      snapshot: JSON.parse(row.snapshot) as Record<string, unknown>,
      changes: JSON.parse(row.changes) as SettingsChanges,
      actorId: row.actor_id,
      actorType: row.actor_type as 'user' | 'admin' | 'system' | 'api' | null,
      changeReason: row.change_reason,
      changeSource: row.change_source as
        | 'admin_api'
        | 'settings_ui'
        | 'migration'
        | 'rollback'
        | null,
      createdAt: row.created_at,
    };
  }

  /**
   * Get the latest version for a category
   */
  async getLatestVersion(category: string): Promise<SettingsHistoryEntry | null> {
    const row = await this.adapter.queryOne<{ version: number }>(
      `SELECT MAX(version) as version FROM settings_history
       WHERE tenant_id = ? AND category = ?`,
      [this.tenantId, category]
    );

    if (!row?.version) {
      return null;
    }

    return this.getVersion(category, row.version);
  }

  /**
   * Rollback to a specific version
   *
   * This creates a new version with the restored snapshot.
   *
   * Execution order is designed for error recovery:
   * 1. Read target version from DB
   * 2. Read current snapshot from KV
   * 3. Record rollback to DB first (can be compensated if KV fails)
   * 4. Apply snapshot to KV
   * 5. If KV fails, delete the DB entry (compensation)
   */
  async rollback(
    category: string,
    input: RollbackInput,
    getCurrentSnapshot: () => Promise<Record<string, unknown>>,
    applySnapshot: (snapshot: Record<string, unknown>) => Promise<void>
  ): Promise<SettingsRollbackResult> {
    // Get target version
    const targetEntry = await this.getVersion(category, input.targetVersion);
    if (!targetEntry) {
      throw new Error(`Version ${input.targetVersion} not found for category ${category}`);
    }

    // Get current snapshot
    const currentSnapshot = await getCurrentSnapshot();

    // Get current version number
    const latestEntry = await this.getLatestVersion(category);
    const previousVersion = latestEntry?.version ?? 0;

    // Record the rollback to DB first (before KV write)
    // This allows compensation if KV write fails
    const newEntry = await this.recordChange({
      category,
      previousSnapshot: currentSnapshot,
      newSnapshot: targetEntry.snapshot,
      actorId: input.actorId,
      actorType: input.actorType,
      changeReason: input.changeReason ?? `Rollback to version ${input.targetVersion}`,
      changeSource: 'rollback',
    });

    // Apply the restored snapshot to KV
    // If this fails, we compensate by deleting the DB entry
    try {
      await applySnapshot(targetEntry.snapshot);
    } catch (error) {
      // Compensation: delete the newly created history entry
      await this.deleteVersion(category, newEntry.version);
      throw error;
    }

    return {
      success: true,
      previousVersion,
      currentVersion: newEntry.version,
      restoredSnapshot: targetEntry.snapshot,
    };
  }

  /**
   * Delete a specific version entry (used for compensation on rollback failure)
   * @internal
   */
  private async deleteVersion(category: string, version: number): Promise<void> {
    await this.adapter.execute(
      'DELETE FROM settings_history WHERE tenant_id = ? AND category = ? AND version = ?',
      [this.tenantId, category, version]
    );
  }

  /**
   * Cleanup old versions based on retention policy
   */
  private async cleanupOldVersions(category: string): Promise<void> {
    const maxVersions = this.config.maxVersions ?? DEFAULT_MAX_VERSIONS;
    const retentionDays = this.config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const retentionCutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;

    // Delete versions beyond max count
    await this.adapter.execute(
      `DELETE FROM settings_history
       WHERE tenant_id = ? AND category = ? AND version NOT IN (
         SELECT version FROM settings_history
         WHERE tenant_id = ? AND category = ?
         ORDER BY version DESC
         LIMIT ?
       )`,
      [this.tenantId, category, this.tenantId, category, maxVersions]
    );

    // Delete versions older than retention period (but keep at least 10)
    await this.adapter.execute(
      `DELETE FROM settings_history
       WHERE tenant_id = ? AND category = ? AND created_at < ? AND version NOT IN (
         SELECT version FROM settings_history
         WHERE tenant_id = ? AND category = ?
         ORDER BY version DESC
         LIMIT 10
       )`,
      [this.tenantId, category, retentionCutoff, this.tenantId, category]
    );
  }
}

/**
 * Create a settings history manager
 */
export function createSettingsHistoryManager(
  db: D1Database,
  tenantId?: string,
  config?: SettingsHistoryConfig
): SettingsHistoryManager {
  return new SettingsHistoryManager(db, tenantId, config);
}

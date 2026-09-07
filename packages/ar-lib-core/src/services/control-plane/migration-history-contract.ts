export const AUTHRIM_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS authrim_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)`;

export const AUTHRIM_MIGRATIONS_COLUMN_ALTERS = [
  'ALTER TABLE authrim_migrations ADD COLUMN checksum TEXT;',
  'ALTER TABLE authrim_migrations ADD COLUMN execution_time_ms INTEGER;',
  'ALTER TABLE authrim_migrations ADD COLUMN setup_version TEXT;',
  'ALTER TABLE authrim_migrations ADD COLUMN tool_version TEXT;',
] as const;

export const AUTHRIM_MIGRATION_HISTORY_SQL =
  'SELECT filename, checksum, applied_at, execution_time_ms, setup_version, tool_version FROM authrim_migrations ORDER BY filename';

export interface AuthrimMigrationHistoryRow extends Record<string, unknown> {
  filename: string;
  checksum?: string | null;
  applied_at?: number | null;
  execution_time_ms?: number | null;
  setup_version?: string | null;
  tool_version?: string | null;
}

export interface ValidateMigrationHistoryOptions {
  requireChecksum?: boolean;
  requireAppliedAt?: boolean;
  rejectDuplicates?: boolean;
}

function optionalFiniteNumber(value: unknown): value is number | null | undefined {
  return (
    value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

export function validateAuthrimMigrationHistoryRows(
  rows: readonly Record<string, unknown>[],
  options: ValidateMigrationHistoryOptions = {}
): AuthrimMigrationHistoryRow[] {
  const filenames = new Set<string>();
  return rows.map((row) => {
    if (typeof row.filename !== 'string' || row.filename.trim().length === 0) {
      throw new TypeError('migration_history_invalid_filename');
    }
    const filename = row.filename.trim();
    if (options.rejectDuplicates && filenames.has(filename)) {
      throw new TypeError('migration_history_duplicate_filename');
    }
    filenames.add(filename);
    if (
      !optionalString(row.checksum) ||
      (options.requireChecksum &&
        (typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(row.checksum)))
    ) {
      throw new TypeError('migration_history_invalid_checksum');
    }
    if (
      !optionalFiniteNumber(row.applied_at) ||
      (options.requireAppliedAt && typeof row.applied_at !== 'number')
    ) {
      throw new TypeError('migration_history_invalid_applied_at');
    }
    if (
      !optionalFiniteNumber(row.execution_time_ms) ||
      !optionalString(row.setup_version) ||
      !optionalString(row.tool_version)
    ) {
      throw new TypeError('migration_history_invalid_metadata');
    }
    return {
      ...row,
      filename,
      checksum: row.checksum as string | null | undefined,
      applied_at: row.applied_at as number | null | undefined,
      execution_time_ms: row.execution_time_ms as number | null | undefined,
      setup_version: row.setup_version as string | null | undefined,
      tool_version: row.tool_version as string | null | undefined,
    };
  });
}

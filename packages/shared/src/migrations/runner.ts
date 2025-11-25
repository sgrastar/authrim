/**
 * Database Migration Runner
 * Issue #14: Schema version management
 *
 * Provides automated migration management with:
 * - Migration history tracking
 * - Checksum validation
 * - Idempotent execution
 * - Rollback support
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Migration file metadata
 */
export interface Migration {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

/**
 * Applied migration record from database
 */
export interface AppliedMigration {
  version: number;
  name: string;
  applied_at: number;
  checksum: string;
  execution_time_ms?: number;
}

/**
 * Migration metadata
 */
export interface MigrationMetadata {
  current_version: number;
  last_migration_at?: number;
  environment: string;
}

/**
 * Migration runner options
 */
export interface MigrationRunnerOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * Migration Runner
 *
 * Manages database schema migrations with version tracking and validation
 */
export class MigrationRunner {
  constructor(private db: D1Database) {}

  /**
   * Initialize migration infrastructure
   * Creates schema_migrations and migration_metadata tables if they don't exist
   */
  async initialize(): Promise<void> {
    try {
      // Check if schema_migrations table exists
      const result = await this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .first<{ name: string }>();

      if (!result) {
        console.log('📦 Initializing migration infrastructure...');

        // Read and execute 000_schema_migrations.sql
        const initSql = readFileSync(
          join(process.cwd(), 'migrations', '000_schema_migrations.sql'),
          'utf-8'
        );

        await this.db.exec(initSql);
        console.log('✅ Migration infrastructure initialized');
      }
    } catch (error) {
      console.error('❌ Failed to initialize migration infrastructure:', error);
      throw error;
    }
  }

  /**
   * Get all applied migrations from database
   */
  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.initialize();

    const result = await this.db
      .prepare(
        'SELECT version, name, applied_at, checksum, execution_time_ms FROM schema_migrations ORDER BY version'
      )
      .all<AppliedMigration>();

    return result.results || [];
  }

  /**
   * Get migration metadata
   */
  async getMetadata(): Promise<MigrationMetadata> {
    await this.initialize();

    const result = await this.db
      .prepare(
        "SELECT current_version, last_migration_at, environment FROM migration_metadata WHERE id = 'global'"
      )
      .first<MigrationMetadata>();

    return (
      result || {
        current_version: 0,
        environment: 'development',
      }
    );
  }

  /**
   * Get pending migrations that haven't been applied yet
   */
  async getPendingMigrations(migrationsDir: string): Promise<Migration[]> {
    const appliedMigrations = await this.getAppliedMigrations();
    const appliedVersions = new Set(appliedMigrations.map((m) => m.version));

    const allMigrations = this.loadMigrations(migrationsDir);

    // Filter out migration 000 (infrastructure) and already applied migrations
    return allMigrations.filter((m) => m.version > 0 && !appliedVersions.has(m.version));
  }

  /**
   * Load all migration files from directory
   */
  private loadMigrations(migrationsDir: string): Migration[] {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    return files.map((filename) => {
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }

      const version = parseInt(match[1], 10);
      const name = match[2];
      const filepath = join(migrationsDir, filename);
      const sql = readFileSync(filepath, 'utf-8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      return { version, name, filename, sql, checksum };
    });
  }

  /**
   * Run all pending migrations
   */
  async runMigrations(migrationsDir: string, options: MigrationRunnerOptions = {}): Promise<void> {
    const pending = await this.getPendingMigrations(migrationsDir);

    if (pending.length === 0) {
      console.log('✅ No pending migrations');
      return;
    }

    console.log(`📋 Found ${pending.length} pending migration(s):`);
    pending.forEach((m) => console.log(`  - ${m.filename}`));

    if (options.dryRun) {
      console.log('\n🔍 Dry run mode - no changes will be applied');
      return;
    }

    for (const migration of pending) {
      await this.applyMigration(migration, options);
    }

    console.log('\n✅ All migrations applied successfully');
  }

  /**
   * Apply a single migration
   */
  private async applyMigration(
    migration: Migration,
    options: MigrationRunnerOptions = {}
  ): Promise<void> {
    console.log(`\n🔄 Applying: ${migration.filename}`);
    const startTime = Date.now();

    try {
      // Execute migration SQL
      if (options.verbose) {
        console.log(`   SQL:\n${migration.sql.substring(0, 200)}...`);
      }

      await this.db.exec(migration.sql);

      const executionTime = Date.now() - startTime;

      // Record migration in schema_migrations table
      await this.db
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at, checksum, execution_time_ms)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          migration.version,
          migration.name,
          Math.floor(Date.now() / 1000),
          migration.checksum,
          executionTime
        )
        .run();

      // Update migration metadata
      await this.db
        .prepare(
          `UPDATE migration_metadata
           SET current_version = ?, last_migration_at = ?
           WHERE id = 'global'`
        )
        .bind(migration.version, Math.floor(Date.now() / 1000))
        .run();

      console.log(`✅ Applied in ${executionTime}ms`);
    } catch (error) {
      console.error(`❌ Failed to apply ${migration.filename}:`, error);
      throw error;
    }
  }

  /**
   * Validate migration integrity
   * Checks if applied migrations match their files (via checksum)
   */
  async validateMigrations(migrationsDir: string): Promise<boolean> {
    const applied = await this.getAppliedMigrations();
    const allMigrations = this.loadMigrations(migrationsDir);

    let isValid = true;

    console.log('🔍 Validating migration integrity...\n');

    // Check for missing migrations
    for (const appliedMig of applied) {
      const fileMig = allMigrations.find((m) => m.version === appliedMig.version);

      if (!fileMig) {
        console.error(
          `❌ Applied migration ${appliedMig.version} (${appliedMig.name}) not found in files`
        );
        isValid = false;
        continue;
      }

      // Validate checksum
      if (fileMig.checksum !== appliedMig.checksum) {
        console.error(
          `❌ Checksum mismatch for migration ${appliedMig.version} (${appliedMig.name}):\n` +
            `   Database: ${appliedMig.checksum}\n` +
            `   File:     ${fileMig.checksum}\n` +
            `   This indicates the migration file was modified after being applied!`
        );
        isValid = false;
      } else {
        console.log(`✅ Migration ${appliedMig.version} (${appliedMig.name}) - checksum valid`);
      }
    }

    if (isValid) {
      console.log('\n✅ All migrations validated successfully');
    } else {
      console.log('\n❌ Migration validation failed - integrity compromised!');
    }

    return isValid;
  }

  /**
   * Display migration status
   */
  async showStatus(migrationsDir: string): Promise<void> {
    const metadata = await this.getMetadata();
    const applied = await this.getAppliedMigrations();
    const pending = await this.getPendingMigrations(migrationsDir);

    console.log('\n📊 Migration Status:\n');
    console.log(`  Environment:      ${metadata.environment}`);
    console.log(`  Current Version:  ${metadata.current_version}`);
    console.log(`  Applied:          ${applied.length} migration(s)`);
    console.log(`  Pending:          ${pending.length} migration(s)`);

    if (metadata.last_migration_at) {
      const lastMigrationDate = new Date(metadata.last_migration_at * 1000);
      console.log(`  Last Migration:   ${lastMigrationDate.toISOString()}`);
    }

    if (applied.length > 0) {
      console.log('\n  📚 Applied Migrations:');
      applied.forEach((m) => {
        const date = new Date(m.applied_at * 1000).toISOString().split('T')[0];
        const time = m.execution_time_ms ? ` (${m.execution_time_ms}ms)` : '';
        console.log(`    ${m.version.toString().padStart(3, '0')}: ${m.name} [${date}]${time}`);
      });
    }

    if (pending.length > 0) {
      console.log('\n  🔜 Pending Migrations:');
      pending.forEach((m) => {
        console.log(`    ${m.version.toString().padStart(3, '0')}: ${m.name}`);
      });
    }

    console.log('');
  }
}

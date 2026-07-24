#!/usr/bin/env tsx
/**
 * Create New Migration Script
 * Issue #14: Schema version management
 *
 * Usage: pnpm migrate:create <description>
 * Example: pnpm migrate:create add_user_preferences
 */

import { writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  assertProductVersionOpenForNewMigrations,
  syncDraftReleaseMigrationManifest,
} from '../packages/setup/src/core/release-migrations.js';

function main() {
  const description = process.argv[2];

  if (!description) {
    console.error('❌ Error: Migration description required\n');
    console.log('Usage: pnpm migrate:create <description>');
    console.log('Example: pnpm migrate:create add_user_preferences\n');
    process.exit(1);
  }

  // Validate description format (snake_case)
  if (!/^[a-z0-9_]+$/.test(description)) {
    console.error(
      '❌ Error: Description must be snake_case (lowercase letters, numbers, underscores only)'
    );
    console.error(`   Got: "${description}"\n`);
    process.exit(1);
  }

  const migrationsDir = join(process.cwd(), 'migrations');
  const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
    version: string;
  };
  assertProductVersionOpenForNewMigrations(migrationsDir, rootPackage.version);

  // Find next version number
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let nextVersion = 1;
  if (files.length > 0) {
    const lastFile = files[files.length - 1];
    const match = lastFile.match(/^(\d+)_/);
    if (match) {
      nextVersion = parseInt(match[1], 10) + 1;
    }
  }

  // Format version with zero-padding
  const versionStr = nextVersion.toString().padStart(3, '0');
  const filename = `${versionStr}_${description}.sql`;
  const filepath = join(migrationsDir, filename);

  // Get current date
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

  // Migration template
  const template = `-- Migration: ${filename}
-- Description: [Add description here]
-- Author: @[username]
-- Date: ${dateStr}
-- Issue: #[issue-number]

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- Add your SQL statements here
-- Example:
-- ALTER TABLE users ADD COLUMN new_field TEXT;
-- CREATE INDEX IF NOT EXISTS idx_users_new_field ON users(new_field);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- Example rollback:
-- DROP INDEX IF EXISTS idx_users_new_field;
-- ALTER TABLE users DROP COLUMN new_field;
-- DELETE FROM schema_migrations WHERE version = ${nextVersion};

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: ${versionStr}
-- =============================================================================
`;

  try {
    writeFileSync(filepath, template, 'utf-8');
    syncDraftReleaseMigrationManifest({
      migrationsRoot: migrationsDir,
      productVersion: rootPackage.version,
    });
    console.log(`✅ Created migration: ${filename}\n`);
    console.log('📝 Next steps:');
    console.log(`   1. Edit: ${filepath}`);
    console.log('   2. Add SQL statements in "Up Migration" section');
    console.log('   3. Document rollback in "Down Migration" section');
    console.log('   4. The draft release manifest was updated automatically');
    console.log('   5. Run: pnpm migrate:manifest:check\n');
  } catch (error) {
    console.error('❌ Failed to create migration:', error);
    process.exit(1);
  }
}

main();

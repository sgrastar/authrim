/**
 * Migrate Command
 *
 * Handles migration from legacy flat file structure to new unified
 * .authrim/{env}/ directory structure.
 */

import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import {
  getMigrationStatus,
  migrateToNewStructure,
  validateMigration,
  type MigrationOptions,
} from '../../core/migrate.js';
import { validateEnvName } from '../../core/paths.js';

// =============================================================================
// Types
// =============================================================================

export interface MigrateCommandOptions {
  /** Specific environment to migrate */
  env?: string;
  /** Dry run - show what would be done without making changes */
  dryRun?: boolean;
  /** Skip backup creation */
  noBackup?: boolean;
  /** Delete legacy files after migration */
  deleteLegacy?: boolean;
  /** Skip confirmation prompt */
  yes?: boolean;
}

// =============================================================================
// Migrate Command
// =============================================================================

export async function migrateCommand(options: MigrateCommandOptions): Promise<void> {
  console.log(chalk.bold('\n🔄 Authrim Migration\n'));

  const baseDir = process.cwd();

  // Security: Validate environment name if provided
  if (options.env && !validateEnvName(options.env)) {
    console.error(chalk.red('Invalid environment name: ' + options.env));
    console.log(chalk.gray('Environment name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.'));
    process.exitCode = 1;
    return;
  }

  // Check current status
  const status = getMigrationStatus(baseDir);

  if (!status.needsMigration) {
    if (status.currentStructure === 'new') {
      console.log(chalk.green('✓ Already using new directory structure'));
      console.log(chalk.gray(`  Environments: ${status.environments.join(', ') || 'none'}`));
    } else {
      console.log(chalk.yellow('No configuration files found to migrate'));
      console.log(chalk.gray('  Run "authrim-setup init" to create a new configuration.'));
    }
    return;
  }

  // Show current state
  console.log(chalk.bold('Current State:'));
  console.log(chalk.cyan('  Structure: ') + chalk.yellow('Legacy (flat files)'));
  console.log(chalk.cyan('  Environments: ') + status.environments.join(', '));
  console.log(chalk.cyan('  Legacy files:'));
  for (const file of status.legacyFiles) {
    console.log(chalk.gray(`    • ${file}`));
  }

  console.log('');

  // Show target state
  console.log(chalk.bold('Migration Target:'));
  console.log(chalk.cyan('  Structure: ') + chalk.green('New (.authrim/{env}/)'));
  for (const env of status.environments) {
    console.log(chalk.gray(`    • .authrim/${env}/config.json`));
    console.log(chalk.gray(`    • .authrim/${env}/lock.json`));
    console.log(chalk.gray(`    • .authrim/${env}/version.txt`));
    console.log(chalk.gray(`    • .authrim/${env}/keys/`));
  }

  console.log('');

  // Dry run mode
  if (options.dryRun) {
    console.log(chalk.yellow('DRY RUN MODE - No changes will be made\n'));
  }

  // Confirm migration
  if (!options.yes && !options.dryRun) {
    const confirmed = await confirm({
      message: 'Proceed with migration?',
      default: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nMigration cancelled.'));
      return;
    }
  }

  console.log('');

  // Run migration
  const migrationOptions: MigrationOptions = {
    baseDir,
    env: options.env,
    dryRun: options.dryRun,
    noBackup: options.noBackup,
    deleteLegacy: options.deleteLegacy,
    onProgress: (msg) => console.log(msg),
  };

  const result = await migrateToNewStructure(migrationOptions);

  // Show results
  console.log('');
  console.log(chalk.bold('━━━ Migration ' + (options.dryRun ? 'Plan' : 'Results') + ' ━━━\n'));

  if (result.success) {
    console.log(chalk.green('✓ Migration ' + (options.dryRun ? 'plan' : 'completed') + ' successfully!\n'));

    if (result.backupPath) {
      console.log(chalk.cyan('Backup: ') + result.backupPath);
    }

    console.log(chalk.cyan('Environments migrated: ') + result.migratedEnvs.join(', '));
    console.log(chalk.cyan('Files ' + (options.dryRun ? 'to be ' : '') + 'migrated: ') + result.migratedFiles.length);

    // Validate migration (if not dry run)
    if (!options.dryRun) {
      console.log('');
      console.log(chalk.bold('Validation:'));

      for (const env of result.migratedEnvs) {
        const validation = await validateMigration(baseDir, env);
        if (validation.valid) {
          console.log(chalk.green(`  ✓ ${env}: Valid`));
        } else {
          console.log(chalk.yellow(`  ⚠ ${env}: Issues found`));
          for (const issue of validation.issues) {
            console.log(chalk.red(`    • ${issue}`));
          }
        }
      }
    }
  } else {
    console.log(chalk.red('✗ Migration failed\n'));

    for (const error of result.errors) {
      console.log(chalk.red(`  • ${error}`));
    }

    if (result.backupPath) {
      console.log('');
      console.log(chalk.yellow('Your files have been backed up to:'));
      console.log(chalk.cyan(`  ${result.backupPath}`));
    }
  }

  console.log('');
}

// =============================================================================
// Status Command
// =============================================================================

export async function migrateStatusCommand(): Promise<void> {
  console.log(chalk.bold('\n📊 Authrim Structure Status\n'));

  const baseDir = process.cwd();
  const status = getMigrationStatus(baseDir);

  // Structure type
  const structureLabel = {
    new: chalk.green('New (.authrim/{env}/)'),
    legacy: chalk.yellow('Legacy (flat files)'),
    none: chalk.gray('Not initialized'),
  };

  console.log(chalk.bold('Structure: ') + structureLabel[status.currentStructure]);

  // Migration needed
  if (status.needsMigration) {
    console.log(chalk.bold('Migration: ') + chalk.yellow('Recommended'));
    console.log(chalk.gray('  Run "authrim-setup migrate" to update to new structure'));
  } else if (status.currentStructure === 'new') {
    console.log(chalk.bold('Migration: ') + chalk.green('Not needed'));
  }

  // Environments
  console.log('');
  console.log(chalk.bold('Environments:'));
  if (status.environments.length > 0) {
    for (const env of status.environments) {
      console.log(chalk.cyan(`  • ${env}`));
    }
  } else {
    console.log(chalk.gray('  No environments found'));
  }

  // Legacy files
  if (status.legacyFiles.length > 0) {
    console.log('');
    console.log(chalk.bold('Legacy Files:'));
    for (const file of status.legacyFiles) {
      console.log(chalk.yellow(`  • ${file}`));
    }
  }

  console.log('');
}

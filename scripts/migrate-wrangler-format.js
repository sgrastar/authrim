#!/usr/bin/env node
/**
 * Migration script: Convert wrangler.{env}.toml to wrangler.toml with [env.xxx] sections
 *
 * This script reads existing wrangler.{env}.toml files and converts them to the new
 * Cloudflare official [env.xxx] section format in a single wrangler.toml file.
 *
 * Usage:
 *   node scripts/migrate-wrangler-format.js --env=conformance
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseToml } from '@iarna/toml';

// Parse command line arguments
const args = process.argv.slice(2);
let envName = 'conformance';

for (const arg of args) {
  if (arg.startsWith('--env=')) {
    envName = arg.split('=')[1];
  }
}

console.log(`🔄 Migrating wrangler.${envName}.toml files to [env.${envName}] format`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const packagesDir = join(process.cwd(), 'packages');
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let migratedCount = 0;
let skippedCount = 0;

for (const pkg of packages) {
  const oldFile = join(packagesDir, pkg, `wrangler.${envName}.toml`);
  const newFile = join(packagesDir, pkg, 'wrangler.toml');

  // Skip if old file doesn't exist
  if (!existsSync(oldFile)) {
    continue;
  }

  // Skip UI packages (Pages projects don't use [env.xxx] format)
  if (pkg === 'ar-admin-ui' || pkg === 'ar-login-ui') {
    console.log(`  ⏭️  Skipping ${pkg} (Cloudflare Pages project)`);
    skippedCount++;
    continue;
  }

  console.log(`  📦 Converting ${pkg}/wrangler.${envName}.toml...`);

  try {
    const oldContent = readFileSync(oldFile, 'utf-8');

    // Parse TOML content manually (simple parsing for our use case)
    const newContent = convertToEnvFormat(oldContent, envName);

    writeFileSync(newFile, newContent, 'utf-8');
    console.log(`     ✅ Created ${pkg}/wrangler.toml`);
    migratedCount++;
  } catch (error) {
    console.error(`     ❌ Error: ${error.message}`);
  }
}

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 Migration Summary`);
console.log(`   ✅ Migrated: ${migratedCount}`);
console.log(`   ⏭️  Skipped: ${skippedCount}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

/**
 * Convert old wrangler.{env}.toml content to [env.xxx] section format
 */
function convertToEnvFormat(content, env) {
  const lines = content.split('\n');
  const newLines = [];

  // Track current section state
  let inSection = false;
  let currentSection = '';
  let compatibilityDate = '';
  let compatibilityFlags = '';
  let mainEntry = '';
  let workerName = '';

  // Collect migrations separately (they stay at top level)
  const migrationLines = [];
  let inMigrations = false;

  // First pass: extract top-level settings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('name = ')) {
      workerName = trimmed.match(/"([^"]+)"/)?.[1] || '';
    } else if (trimmed.startsWith('main = ')) {
      mainEntry = trimmed;
    } else if (trimmed.startsWith('compatibility_date = ')) {
      compatibilityDate = trimmed;
    } else if (trimmed.startsWith('compatibility_flags = ')) {
      compatibilityFlags = trimmed;
    } else if (trimmed === '[[migrations]]') {
      inMigrations = true;
      migrationLines.push(line);
    } else if (inMigrations) {
      if (trimmed.startsWith('[[') && !trimmed.startsWith('[[migrations]]')) {
        inMigrations = false;
      } else {
        migrationLines.push(line);
        // Continue until next section
        if (trimmed === '' && lines[i + 1]?.trim().startsWith('[[') && !lines[i + 1]?.trim().startsWith('[[migrations]]')) {
          inMigrations = false;
        }
      }
    }
  }

  // Write top-level settings
  newLines.push(mainEntry);
  newLines.push(compatibilityDate);
  newLines.push(compatibilityFlags);
  newLines.push('');

  // Add migrations at top level if present
  if (migrationLines.length > 0) {
    newLines.push('# Durable Objects Migrations');
    for (const ml of migrationLines) {
      newLines.push(ml);
    }
    newLines.push('');
  }

  // Start environment section
  newLines.push(`# Environment: ${env}`);
  newLines.push(`[env.${env}]`);
  newLines.push(`name = "${workerName}"`);

  // Second pass: convert remaining content to env-specific format
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip already processed top-level settings
    if (
      trimmed.startsWith('name = ') ||
      trimmed.startsWith('main = ') ||
      trimmed.startsWith('compatibility_date = ') ||
      trimmed.startsWith('compatibility_flags = ')
    ) {
      continue;
    }

    // Skip migrations (already handled)
    if (trimmed === '[[migrations]]') {
      // Skip until next non-migration section
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith('[[') && !lines[i + 1].trim().startsWith('[')) {
        i++;
        if (lines[i].trim() === '' && lines[i + 1]?.trim().startsWith('[[') && !lines[i + 1]?.trim().startsWith('[[migrations]]')) {
          break;
        }
      }
      continue;
    }

    // Convert section headers
    if (trimmed.startsWith('[[')) {
      // Array section (e.g., [[kv_namespaces]], [[d1_databases]], etc.)
      const section = trimmed.slice(2, -2);
      if (section !== 'migrations') {
        newLines.push(`[[env.${env}.${section}]]`);
      }
    } else if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
      // Table section (e.g., [placement], [vars])
      const section = trimmed.slice(1, -1);
      newLines.push(`[env.${env}.${section}]`);
    } else if (trimmed !== '' && !trimmed.startsWith('#')) {
      // Regular key-value line or comment
      newLines.push(line);
    } else {
      // Empty lines and comments
      newLines.push(line);
    }
  }

  return newLines.join('\n');
}

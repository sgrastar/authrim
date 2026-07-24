#!/usr/bin/env node
// CI Database Migration Runner
//
// Runs D1 database migrations for a given environment using the setup package's
// runMigrationsForEnvironment helper.  An authrim_migrations tracking table inside
// each D1 database ensures every migration file is applied at most once, making
// repeated runs idempotent.
//
// Usage:
//   DEPLOY_ENV=test node scripts/ci-run-migrations.mjs
//
// Required files (restored from GitHub Secrets before running this script):
//   .authrim/{env}/lock.json  -> AUTHRIM_{ENV}_LOCK secret (provides DB names)
//
// Required env vars:
//   DEPLOY_ENV              - environment prefix (e.g. "test")
//   CLOUDFLARE_API_TOKEN    - Cloudflare API token (used by wrangler internally)
//   CLOUDFLARE_ACCOUNT_ID   - Cloudflare account ID

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

// Import from built setup package
const { findMigrationsRoot, runMigrationsForEnvironment } = await import(
  join(rootDir, 'packages/setup/dist/core/cloudflare.js')
);
const { loadInstalledReleaseMigrationManifest } = await import(
  join(rootDir, 'packages/setup/dist/core/release-migrations.js')
);
const { acquireEnvironmentOperationLock, loadLockFileAuto } = await import(
  join(rootDir, 'packages/setup/dist/core/lock.js')
);
const { getRootProductVersion } = await import(
  join(rootDir, 'packages/setup/dist/core/version.js')
);
const { evaluateReleaseDeploymentGuard, releaseDeploymentGuardMessage } = await import(
  join(rootDir, 'packages/setup/dist/core/release-deployment-guard.js')
);

const env = process.env.DEPLOY_ENV;
if (!env) {
  console.error('❌ DEPLOY_ENV environment variable is required');
  process.exit(1);
}

console.log(`📜 Running D1 migrations for env: ${env}`);
console.log('');

const { lock, path: lockPath } = await loadLockFileAuto(rootDir, env);
if (!lock) {
  throw new Error(`Environment ${env} has no lock file.`);
}
if (!lock.productVersion && Object.keys(lock.workers ?? {}).length === 0) {
  throw new Error('Initial schema bootstrap must use authrim-setup deploy.');
}
const operationLock = await acquireEnvironmentOperationLock(lockPath, 'ci-d1-migration');
let result;
try {
  const lockedEnvironment = await loadLockFileAuto(rootDir, env);
  if (!lockedEnvironment.lock || JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(lock)) {
    throw new Error('environment_changed_while_waiting_for_ci_d1_migration_lock');
  }
  const productVersion = await getRootProductVersion(rootDir);
  const guard = evaluateReleaseDeploymentGuard(
    lockedEnvironment.lock,
    productVersion,
    'manual_migration'
  );
  if (!guard.allowed) {
    throw new Error(releaseDeploymentGuardMessage(guard, productVersion));
  }
  const migrationsRoot = await findMigrationsRoot(rootDir);
  if (!migrationsRoot.path) throw new Error('Migrations directory not found.');
  const installedRelease = loadInstalledReleaseMigrationManifest({
    migrationsRoot: migrationsRoot.path,
    productVersion,
    lock: lockedEnvironment.lock,
  });
  result = await runMigrationsForEnvironment(env, rootDir, (msg) => console.log(msg), undefined, {
    productVersion,
    allowDraft: installedRelease.draft,
  });
} finally {
  await operationLock.release();
}

console.log('');

if (!result.success) {
  const errors = [result.core, result.pii, result.admin]
    .filter((r) => !r.success && r.error)
    .map((r) => r.error);
  console.error('❌ Migration failed:');
  for (const err of errors) {
    console.error(`   ${err}`);
  }
  process.exit(1);
}

const totalApplied = result.core.appliedCount + result.pii.appliedCount + result.admin.appliedCount;
const totalSkipped = result.core.skippedCount + result.pii.skippedCount + result.admin.skippedCount;

console.log(
  `✅ Migrations complete — applied: ${totalApplied}, skipped (already applied): ${totalSkipped}`
);

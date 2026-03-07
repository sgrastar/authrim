#!/usr/bin/env node
/**
 * CI Wrangler Config Generator
 *
 * Generates packages/*/wrangler.toml files from .authrim/{env}/config.json
 * and .authrim/{env}/lock.json, which are restored from GitHub Secrets in CI.
 *
 * Usage:
 *   DEPLOY_ENV=test node scripts/ci-generate-wrangler.mjs
 *
 * Required files (restored from GitHub Secrets before running this script):
 *   .authrim/{env}/config.json  → AUTHRIM_{ENV}_CONFIG secret
 *   .authrim/{env}/lock.json    → AUTHRIM_{ENV}_LOCK secret
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

// Import from built setup package
const { generateWranglerConfig, toToml } = await import(
  join(rootDir, 'packages/setup/dist/core/wrangler.js')
);
const { CORE_WORKER_COMPONENTS, OPTIONAL_WORKER_COMPONENTS } = await import(
  join(rootDir, 'packages/setup/dist/core/naming.js')
);

const env = process.env.DEPLOY_ENV;
if (!env) {
  console.error('❌ DEPLOY_ENV environment variable is required');
  process.exit(1);
}

const configPath = join(rootDir, `.authrim/${env}/config.json`);
const lockPath = join(rootDir, `.authrim/${env}/lock.json`);

if (!existsSync(configPath)) {
  console.error(`❌ Config not found: ${configPath}`);
  console.error('   Make sure AUTHRIM_TEST_CONFIG secret is set and restored before this step.');
  process.exit(1);
}
if (!existsSync(lockPath)) {
  console.error(`❌ Lock file not found: ${lockPath}`);
  console.error('   Make sure AUTHRIM_TEST_LOCK secret is set and restored before this step.');
  process.exit(1);
}

console.log(`📋 Generating wrangler.toml files for env: ${env}`);
console.log(`   config: ${configPath}`);
console.log(`   lock:   ${lockPath}`);
console.log('');

const config = JSON.parse(await readFile(configPath, 'utf-8'));
const lock = JSON.parse(await readFile(lockPath, 'utf-8'));

// Build resource IDs from lock file
const resourceIds = { d1: {}, kv: {} };
for (const [key, value] of Object.entries(lock.d1 || {})) {
  resourceIds.d1[key] = { id: value.id, name: value.name };
}
for (const [key, value] of Object.entries(lock.kv || {})) {
  resourceIds.kv[key] = { id: value.id, name: value.name };
}
if (lock.queues) {
  resourceIds.queues = {};
  for (const [key, value] of Object.entries(lock.queues)) {
    resourceIds.queues[key] = { id: value.id, name: value.name };
  }
}
if (lock.r2) {
  resourceIds.r2 = {};
  for (const [key, value] of Object.entries(lock.r2)) {
    resourceIds.r2[key] = { name: value.name };
  }
}

// Determine which components to generate
const components = [...CORE_WORKER_COMPONENTS];
if (config.components?.saml) components.push('ar-saml');
if (config.components?.async) components.push('ar-async');
if (config.components?.vc) components.push('ar-vc');
if (config.components?.bridge) components.push('ar-bridge');
if (config.components?.policy) components.push('ar-policy');

let generated = 0;
const skipped = [];

for (const component of components) {
  const componentDir = join(rootDir, 'packages', component);
  if (!existsSync(componentDir)) {
    skipped.push(component);
    continue;
  }

  const wranglerConfig = generateWranglerConfig(component, config, resourceIds);
  const tomlContent = toToml(wranglerConfig, env);
  const tomlPath = join(componentDir, 'wrangler.toml');

  await writeFile(tomlPath, tomlContent, 'utf-8');
  console.log(`✅ ${component}/wrangler.toml`);
  generated++;
}

if (skipped.length > 0) {
  console.log('');
  console.log(`⊗  Skipped (directory not found): ${skipped.join(', ')}`);
}

console.log('');
console.log(`✅ Generated ${generated} wrangler.toml files for env: ${env}`);

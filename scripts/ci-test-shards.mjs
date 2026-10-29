#!/usr/bin/env node

/**
 * Which workspace packages each API test shard of the CI runs.
 *
 * The API tests used to be one job that ran every package one after another, and it was the longest
 * job of the workflow by far. They now run as one job per shard, so the workflow takes as long as
 * its slowest shard. `check` fails when a package that has tests belongs to no shard (it would
 * silently never run) or to two shards (it would run twice), so a new package cannot be forgotten.
 *
 *   node scripts/ci-test-shards.mjs names            JSON list of the shard names (for a matrix)
 *   node scripts/ci-test-shards.mjs filters <shard>  turbo `--filter` flags for that shard
 *   node scripts/ci-test-shards.mjs check            fail unless every tested package has one shard
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Tested by `ui-tests`, not by the API tests. */
export const UI_PACKAGES = [
  '@authrim/ar-admin-console',
  '@authrim/ar-admin-ui',
  '@authrim/ar-login-ui',
];

/**
 * Balanced from the CI timings of the unsharded job: ar-management alone is the longest test
 * (about 15 minutes of the 30), then ar-auth and ar-runtime-aws; the rest is small.
 */
export const SHARDS = {
  management: ['@authrim/ar-management'],
  auth: [
    '@authrim/ar-auth',
    '@authrim/ar-token',
    '@authrim/ar-discovery',
    '@authrim/ar-router',
    '@authrim/ar-userinfo',
    '@authrim/ar-policy',
  ],
  core: [
    '@authrim/ar-lib-core',
    '@authrim/ar-lib-field-mapping',
    '@authrim/ar-lib-logging',
    '@authrim/ar-lib-plugin',
    '@authrim/ar-lib-policy',
    '@authrim/ar-lib-scim',
    '@authrim/ar-bridge',
    '@authrim/ar-async',
  ],
  services: [
    '@authrim/ar-runtime-aws',
    '@authrim/setup',
    '@authrim/ar-saml',
    '@authrim/ar-vc',
    '@authrim/ar-control',
    '@authrim/ar-agent-access',
    '@authrim/ar-plugin-runner',
  ],
};

/** Every package of the workspace that has a `test` script, by name. */
export async function testedPackages(root) {
  const packagesDir = path.join(root, 'packages');
  const names = [];
  for (const entry of await fs.readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(packagesDir, entry.name, 'package.json')));
    } catch {
      continue;
    }
    if (manifest.scripts?.test) names.push(manifest.name);
  }
  return names.sort();
}

/** The problems with the assignment of tested packages to shards; empty when it is complete. */
export function checkShards(tested, shards = SHARDS, uiPackages = UI_PACKAGES) {
  const problems = [];
  const owner = new Map();
  for (const [shard, packages] of Object.entries(shards)) {
    for (const name of packages) {
      if (owner.has(name)) problems.push(`${name} is in both "${owner.get(name)}" and "${shard}"`);
      owner.set(name, shard);
    }
  }
  for (const name of tested) {
    if (!uiPackages.includes(name) && !owner.has(name)) {
      problems.push(`${name} has tests but belongs to no shard`);
    }
  }
  for (const name of owner.keys()) {
    if (!tested.includes(name)) problems.push(`${name} is in a shard but has no test script`);
    if (uiPackages.includes(name)) problems.push(`${name} is a UI package, run by ui-tests`);
  }
  return problems;
}

export function filtersFor(shard, shards = SHARDS) {
  const packages = shards[shard];
  if (!packages) throw new Error(`Unknown shard "${shard}"`);
  return packages.map((name) => `--filter=${name}`).join(' ');
}

async function main(argv) {
  const [command, shard] = argv;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (command === 'names') {
    console.log(JSON.stringify(Object.keys(SHARDS)));
  } else if (command === 'filters') {
    console.log(filtersFor(shard));
  } else if (command === 'check') {
    const problems = checkShards(await testedPackages(root));
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: ci-test-shards.mjs names | filters <shard> | check');
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}

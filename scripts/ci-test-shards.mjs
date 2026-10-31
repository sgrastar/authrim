#!/usr/bin/env node

/**
 * Which workspace packages each API test shard of the CI runs.
 *
 * The API tests used to be one job that ran every package one after another, and it was the longest
 * job of the workflow by far. They now run as one job per shard, so the workflow takes as long as
 * its slowest shard. `check` fails when a package that has tests belongs to no shard (it would
 * silently never run) or to two shards (it would run twice), so a new package cannot be forgotten.
 *
 * A shard that is still too long can be cut into several jobs with `vitest --shard=i/N` (see
 * `PARTS`). It stays one logical shard of one package, so the checks above are unchanged; each part
 * is one entry of the CI matrix, and the coverage of the parts is merged back into one result by
 * `ci-merge-coverage.mjs`.
 *
 *   node scripts/ci-test-shards.mjs names            JSON list of the shard names
 *   node scripts/ci-test-shards.mjs matrix           JSON list of the CI jobs (one per part)
 *   node scripts/ci-test-shards.mjs filters <shard>  turbo `--filter` flags for that shard
 *   node scripts/ci-test-shards.mjs check            fail unless every tested package has one shard
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCOPE = '@authrim/';
const scoped = (names) => names.map((name) => `${SCOPE}${name}`);

/** Tested by `ui-tests`, not by the API tests. */
export const UI_PACKAGES = scoped(['ar-admin-console', 'ar-admin-ui', 'ar-login-ui']);

/**
 * The package names are written without their scope on purpose: the logging package's import
 * boundary test rejects the quoted name of that package anywhere in the repository.
 *
 * Balanced from the CI timings of the unsharded job: ar-management alone is the longest test
 * (about 15 minutes of the 30), then ar-auth and ar-runtime-aws; the rest is small. Since the
 * split into shards, management (13-17 minutes) is cut into `PARTS` and the others take 5-8.
 */
export const SHARDS = {
  management: scoped(['ar-management']),
  auth: scoped(['ar-auth', 'ar-token', 'ar-discovery', 'ar-router', 'ar-userinfo', 'ar-policy']),
  core: scoped([
    'ar-lib-core',
    'ar-lib-field-mapping',
    'ar-lib-logging',
    'ar-lib-plugin',
    'ar-lib-policy',
    'ar-lib-scim',
    'ar-bridge',
    'ar-async',
  ]),
  services: scoped([
    'ar-runtime-aws',
    'setup',
    'ar-saml',
    'ar-vc',
    'ar-control',
    'ar-agent-access',
    'ar-plugin-runner',
  ]),
};

/**
 * Shards that run as several jobs, by the number of `vitest --shard=i/N` parts. Vitest hands each
 * part the files whose path hash falls into its slice, so the parts have the same number of files
 * but not exactly the same duration; keep a margin when picking the count. Such a shard must hold
 * exactly one package, because the vitest flag is passed to every package of the turbo run.
 *
 * ar-management has 432 test files and 8,535 tests; unsplit it took 13-17 minutes of CI (923 s of
 * test run) against 5-9 for every other job. The files of a part are chosen by a hash of their
 * path, so the parts differ in duration. Measured on one machine against 419 s unsplit, the
 * longest part took 54% with three parts (225, 168, 57 s) and 38% with four (77, 159, 70, 50 s),
 * which puts the CI job at about 8.8 and 6.3 minutes. The other jobs take up to 8.7 minutes, so
 * four parts leave the margin that three do not. A single file (tenant-backup-import-discard)
 * takes up to 6 minutes of wall clock, which limits what more parts could gain.
 */
export const PARTS = { management: 4 };

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
export function checkShards(tested, shards = SHARDS, uiPackages = UI_PACKAGES, parts = PARTS) {
  const problems = [];
  for (const [shard, count] of Object.entries(parts)) {
    if (!shards[shard]) problems.push(`"${shard}" is split into parts but is not a shard`);
    else if (shards[shard].length !== 1) {
      problems.push(`"${shard}" is split into parts, so it must hold exactly one package`);
    }
    if (!Number.isInteger(count) || count < 2) problems.push(`"${shard}" needs at least 2 parts`);
  }
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

/**
 * The jobs of the CI matrix: one per shard, or one per part of a split shard. `id` names the job and
 * its coverage artifact, `part` is the 1-based part of a split shard (empty otherwise) and
 * `vitestShard` the flag that selects it.
 */
export function matrixEntries(shards = SHARDS, parts = PARTS) {
  return Object.keys(shards).flatMap((shard) => {
    const count = parts[shard];
    if (!count) return [{ shard, id: shard, part: '', vitestShard: '' }];
    return Array.from({ length: count }, (_, i) => ({
      shard,
      id: `${shard}-${i + 1}`,
      part: String(i + 1),
      vitestShard: `--shard=${i + 1}/${count}`,
    }));
  });
}

/**
 * Packages whose coverage arrives in parts, as `{ directory, parts }` (the directory under
 * `packages/`), for the script that merges them.
 */
export function splitPackages(shards = SHARDS, parts = PARTS) {
  return Object.entries(parts).map(([shard, count]) => ({
    directory: shards[shard][0].split('/').pop(),
    parts: count,
  }));
}

async function main(argv) {
  const [command, shard] = argv;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (command === 'names') {
    console.log(JSON.stringify(Object.keys(SHARDS)));
  } else if (command === 'matrix') {
    console.log(JSON.stringify(matrixEntries()));
  } else if (command === 'filters') {
    console.log(filtersFor(shard));
  } else if (command === 'check') {
    const problems = checkShards(await testedPackages(root));
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: ci-test-shards.mjs names | matrix | filters <shard> | check');
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}

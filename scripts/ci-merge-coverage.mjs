#!/usr/bin/env node

/**
 * Merges the coverage of a package whose tests ran as several CI jobs (`PARTS` of
 * ci-test-shards.mjs) back into the one `coverage-final.json` that ci-pr-coverage-comment.mjs reads.
 *
 * Each part uploads its `coverage-final.json` (istanbul format, written by the vitest coverage
 * provider) as `packages/<package>/coverage-parts/<part>/coverage-final.json`. Merging istanbul
 * data is a sum: for a file that appears in several parts, the hit counters of its statements,
 * functions and branches are added up. That is exactly what an unsharded run counts, so the
 * coverage of the package does not depend on how many parts it ran in.
 *
 * The script needs no installed dependencies, because the summary job only checks out the code.
 * It refuses to guess: a missing or surplus part, or a file whose statement/function/branch layout
 * differs between parts (the counters would not line up), is an error instead of a quietly wrong
 * number.
 *
 *   node scripts/ci-merge-coverage.mjs [--root <repository root>]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splitPackages } from './ci-test-shards.mjs';

const LAYOUT_KEYS = ['statementMap', 'fnMap', 'branchMap'];

function sameLayout(a, b) {
  return LAYOUT_KEYS.every((key) => JSON.stringify(a[key] ?? {}) === JSON.stringify(b[key] ?? {}));
}

function addCounts(into, from) {
  for (const id of Object.keys(from ?? {})) into[id] = (into[id] ?? 0) + from[id];
}

function addBranchCounts(into, from) {
  for (const id of Object.keys(from ?? {})) {
    into[id] = (into[id] ?? []).map((count, i) => count + (from[id][i] ?? 0));
  }
}

/** Sums the hit counters of the istanbul coverage maps; throws when a file's layout differs. */
export function mergeCoverage(coverageMaps) {
  const merged = {};
  for (const coverageMap of coverageMaps) {
    for (const [file, coverage] of Object.entries(coverageMap)) {
      const target = merged[file];
      if (!target) {
        merged[file] = structuredClone(coverage);
        continue;
      }
      if (!sameLayout(target, coverage)) {
        throw new Error(`${file} has a different statement/function/branch layout in the parts`);
      }
      addCounts(target.s, coverage.s);
      addCounts(target.f, coverage.f);
      addBranchCounts(target.b, coverage.b);
      if (target.bT && coverage.bT) addBranchCounts(target.bT, coverage.bT);
    }
  }
  return merged;
}

async function listParts(partsDir) {
  try {
    const entries = await fs.readdir(partsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Merges the `coverage-parts/*` of one package into its `coverage/coverage-final.json`. */
export async function mergePackageCoverage({ root, directory, parts }) {
  const packageDir = path.join(root, 'packages', directory);
  const partsDir = path.join(packageDir, 'coverage-parts');
  const expected = Array.from({ length: parts }, (_, i) => String(i + 1));
  const found = (await listParts(partsDir)).sort();
  if (found.join() !== expected.join()) {
    throw new Error(
      `${directory}: expected the coverage of parts ${expected.join(', ')} in ${partsDir}, found ${
        found.join(', ') || 'none'
      }`
    );
  }

  const coverageMaps = [];
  for (const part of expected) {
    const file = path.join(partsDir, part, 'coverage-final.json');
    coverageMaps.push(JSON.parse(await fs.readFile(file, 'utf8')));
  }

  const outputDir = path.join(packageDir, 'coverage');
  await fs.mkdir(outputDir, { recursive: true });
  // A summary left over from a single part would take precedence over the merged data.
  await fs.rm(path.join(outputDir, 'coverage-summary.json'), { force: true });
  const output = path.join(outputDir, 'coverage-final.json');
  const merged = mergeCoverage(coverageMaps);
  await fs.writeFile(output, JSON.stringify(merged));
  return { output, files: Object.keys(merged).length };
}

async function main(argv) {
  const rootFlag = argv.indexOf('--root');
  const root =
    rootFlag >= 0
      ? path.resolve(argv[rootFlag + 1])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const split of splitPackages()) {
    const { output, files } = await mergePackageCoverage({ root, ...split });
    console.log(`${split.directory}: merged ${split.parts} parts, ${files} files -> ${output}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

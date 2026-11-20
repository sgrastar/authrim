#!/usr/bin/env node
// Run mutator over one package in chunks of source files, one report per chunk.
//
// Why: in a large package a single run needs hours, its heap grows with every executed mutant
// (an out-of-memory crash loses the whole run), and the final JSON report lists every mutant,
// which breaks past ~200k mutants (`RangeError: Invalid string length`). A chunk covers only a
// slice of the sources, so its run, its memory and its report stay small, and a finished chunk is
// never lost. The per-function result cache in `.mutator/` is shared, so re-running a chunk only
// executes what changed.
//
// Usage:
//   node scripts/mutation-chunks.mjs <package-dir-name> [options] [-- <extra mutator args>]
//     --list              print the chunks and exit
//     --chunk 1,3         run only these chunks (1-based, as printed by --list)
//     --max-bytes <n>     source bytes per chunk (default 300000)
//     --clean             delete the package's old chunk reports first
//     --time-budget <s>   shorthand for `-- --time-budget <s>`, applied to every chunk
//   e.g. pnpm test:mutation:chunks ar-lib-core --time-budget 1800
//
// Reports go to packages/<pkg>/.mutator/report-chunks/<nn>-<hash of the file list>/ and are merged per package by
// `pnpm test:mutation:summary` (a file in a newer report replaces its older entry). Chunks are
// consecutive files in path order, so a directory usually lands in one chunk. Files excluded by
// the package's mutator.config.mjs are left out. Set NODE_OPTIONS to override the 12 GB heap.

import { existsSync, globSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, matchesGlob, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_GLOB = 'src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const DEFAULT_MAX_BYTES = 300_000;

/** Greedy chunks of consecutive files; a file larger than the limit gets its own chunk. */
export function planChunks(files, maxBytes = DEFAULT_MAX_BYTES) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const file of sorted) {
    if (current.length > 0 && bytes + file.size > maxBytes) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk) => ({
    files: chunk.map((f) => f.path),
    bytes: chunk.reduce((sum, f) => sum + f.size, 0),
  }));
}

export function parseArgs(argv) {
  const opts = {
    pkg: undefined,
    list: false,
    clean: false,
    only: undefined,
    maxBytes: DEFAULT_MAX_BYTES,
    extra: [],
  };
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  if (dash !== -1) opts.extra.push(...argv.slice(dash + 1));
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--clean') opts.clean = true;
    else if (arg === '--chunk') {
      const value = own[++i];
      if (!value) throw new Error('--chunk needs a value such as 1,3');
      opts.only = value.split(',').map(Number);
    } else if (arg === '--max-bytes') opts.maxBytes = Number(own[++i]);
    else if (arg === '--time-budget') opts.extra.push('--time-budget', own[++i]);
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (!opts.pkg) opts.pkg = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  for (const arg of opts.extra) {
    const name = arg.split('=')[0];
    if (['--include', '--exclude', '--report-dir', '--reporter', '--root'].includes(name)) {
      throw new Error(`${name} is set by the chunk runner and cannot be passed through`);
    }
  }
  if (!opts.pkg) throw new Error('usage: mutation-chunks.mjs <package-dir-name> [options]');
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes < 1) throw new Error('bad --max-bytes');
  if (opts.only && opts.only.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error('bad --chunk');
  }
  return opts;
}

async function configExcludes(pkgDir) {
  const config = ['mjs', 'js', 'ts']
    .map((ext) => join(pkgDir, `mutator.config.${ext}`))
    .find((p) => existsSync(p));
  if (!config) throw new Error(`no mutator.config.* in ${pkgDir}`);
  const mod = await import(pathToFileURL(config).href);
  return mod.default?.exclude ?? [];
}

async function sourceFiles(pkgDir) {
  const exclude = await configExcludes(pkgDir);
  return globSync(SOURCE_GLOB, { cwd: pkgDir })
    .filter((rel) => !exclude.some((pattern) => matchesGlob(rel, pattern)))
    .map((rel) => ({ path: rel.replaceAll('\\', '/'), size: statSync(join(pkgDir, rel)).size }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkgDir = join(ROOT, 'packages', opts.pkg);
  if (!existsSync(pkgDir)) throw new Error(`no such package: packages/${opts.pkg}`);
  const chunks = planChunks(await sourceFiles(pkgDir), opts.maxBytes);
  const width = Math.max(2, String(chunks.length).length);
  // The hash of the file list keeps a chunk's report apart from reports of other splits: after
  // the sources change, a rerun of "chunk 1" must not overwrite the result of files that moved.
  const name = (n) =>
    `${String(n).padStart(width, '0')}-${createHash('sha256')
      .update(chunks[n - 1].files.join('\n'))
      .digest('hex')
      .slice(0, 8)}`;

  if (opts.list) {
    chunks.forEach((c, i) =>
      console.log(`${i + 1}\t${c.files.length} files\t${c.bytes} bytes\t${c.files[0]} …`)
    );
    return;
  }

  if (opts.only?.some((n) => n > chunks.length)) {
    throw new Error(`--chunk out of range: the package has ${chunks.length} chunk(s)`);
  }
  const reportRoot = join(pkgDir, '.mutator', 'report-chunks');
  if (opts.clean) rmSync(reportRoot, { recursive: true, force: true });
  const failed = [];
  for (const [index, chunk] of chunks.entries()) {
    const n = index + 1;
    if (opts.only && !opts.only.includes(n)) continue;
    const reportDir = join(reportRoot, name(n));
    console.log(
      `\n== chunk ${n}/${chunks.length}: ${chunk.files.length} files, ${chunk.bytes} bytes`
    );
    const args = [
      'mutator',
      ...chunk.files.flatMap((f) => ['--include', f]),
      '--report-dir',
      reportDir,
      ...opts.extra,
    ];
    const env = { ...process.env };
    env.NODE_OPTIONS ??= '--max-old-space-size=12288';
    const startedAt = Date.now();
    const result = spawnSync('npx', args, { cwd: pkgDir, stdio: 'inherit', env });
    const reportFile = join(reportDir, 'mutation.json');
    const written = existsSync(reportFile) && statSync(reportFile).mtimeMs >= startedAt;
    if (result.status !== 0 || !written) {
      failed.push(n);
      console.error(
        `chunk ${n} failed (exit ${result.status ?? result.signal}${written ? '' : ', no report written'})`
      );
    }
  }
  const have = existsSync(reportRoot) ? readdirSync(reportRoot).length : 0;
  console.log(
    `\n${have}/${chunks.length} chunk report(s) in ${reportRoot}` +
      (failed.length ? `; failed chunks: ${failed.join(', ')}` : '')
  );
  console.log('Merge them with: pnpm test:mutation:summary');
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

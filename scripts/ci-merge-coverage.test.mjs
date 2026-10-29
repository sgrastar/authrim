import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergeCoverage, mergePackageCoverage } from './ci-merge-coverage.mjs';

const at = (line) => ({ start: { line, column: 0 }, end: { line, column: 10 } });

function fileCoverage({ s, f, b }) {
  return {
    path: '/repo/src/a.ts',
    statementMap: { 0: at(1), 1: at(2) },
    fnMap: { 0: { name: 'run', decl: at(1), loc: at(1), line: 1 } },
    branchMap: { 0: { type: 'if', loc: at(2), locations: [at(2), at(3)], line: 2 } },
    s,
    f,
    b,
  };
}

test('adds up the counters of a file covered by several parts', () => {
  const merged = mergeCoverage([
    { '/repo/src/a.ts': fileCoverage({ s: { 0: 1, 1: 0 }, f: { 0: 2 }, b: { 0: [1, 0] } }) },
    { '/repo/src/a.ts': fileCoverage({ s: { 0: 0, 1: 0 }, f: { 0: 0 }, b: { 0: [0, 3] } }) },
    { '/repo/src/a.ts': fileCoverage({ s: { 0: 4, 1: 1 }, f: { 0: 1 }, b: { 0: [0, 0] } }) },
  ]);
  assert.deepEqual(merged['/repo/src/a.ts'].s, { 0: 5, 1: 1 });
  assert.deepEqual(merged['/repo/src/a.ts'].f, { 0: 3 });
  assert.deepEqual(merged['/repo/src/a.ts'].b, { 0: [1, 3] });
});

test('keeps a file that only one part loaded, and does not change its input', () => {
  const only = fileCoverage({ s: { 0: 1, 1: 1 }, f: { 0: 1 }, b: { 0: [1, 1] } });
  const input = [{ '/repo/src/a.ts': only }, { '/repo/src/b.ts': { ...only, path: '/b.ts' } }];
  const merged = mergeCoverage(input);
  assert.deepEqual(Object.keys(merged).sort(), ['/repo/src/a.ts', '/repo/src/b.ts']);
  merged['/repo/src/a.ts'].s[0] = 99;
  assert.equal(only.s[0], 1);
});

test('refuses to add counters whose statements do not line up', () => {
  const other = fileCoverage({ s: { 0: 1, 1: 0 }, f: { 0: 0 }, b: { 0: [0, 0] } });
  other.statementMap = { 0: at(1), 1: at(7) };
  assert.throws(
    () =>
      mergeCoverage([
        { '/repo/src/a.ts': fileCoverage({ s: { 0: 1, 1: 0 }, f: { 0: 0 }, b: { 0: [0, 0] } }) },
        { '/repo/src/a.ts': other },
      ]),
    /different statement\/function\/branch layout/
  );
});

async function stagePackage(dir, parts) {
  for (const [part, coverage] of Object.entries(parts)) {
    const partDir = path.join(dir, 'packages', 'pkg', 'coverage-parts', part);
    await mkdir(partDir, { recursive: true });
    await writeFile(path.join(partDir, 'coverage-final.json'), JSON.stringify(coverage));
  }
}

test('writes the merged coverage of a package, and rejects a missing or surplus part', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ci-merge-coverage-'));
  try {
    const one = { '/a.ts': fileCoverage({ s: { 0: 1, 1: 0 }, f: { 0: 1 }, b: { 0: [1, 0] } }) };
    const two = { '/a.ts': fileCoverage({ s: { 0: 0, 1: 2 }, f: { 0: 0 }, b: { 0: [0, 1] } }) };
    await stagePackage(dir, { 1: one });
    await assert.rejects(
      mergePackageCoverage({ root: dir, directory: 'pkg', parts: 2 }),
      /expected the coverage of parts 1, 2 .* found 1/
    );

    await stagePackage(dir, { 2: two, 3: two });
    await assert.rejects(
      mergePackageCoverage({ root: dir, directory: 'pkg', parts: 2 }),
      /found 1, 2, 3/
    );

    await rm(path.join(dir, 'packages', 'pkg', 'coverage-parts', '3'), { recursive: true });
    // A summary of one part must not shadow the merged data.
    await mkdir(path.join(dir, 'packages', 'pkg', 'coverage'), { recursive: true });
    await writeFile(path.join(dir, 'packages', 'pkg', 'coverage', 'coverage-summary.json'), '{}');
    const { output, files } = await mergePackageCoverage({ root: dir, directory: 'pkg', parts: 2 });
    assert.equal(files, 1);
    const merged = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(merged['/a.ts'].s, { 0: 1, 1: 2 });
    await assert.rejects(
      readFile(path.join(dir, 'packages', 'pkg', 'coverage', 'coverage-summary.json')),
      { code: 'ENOENT' }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

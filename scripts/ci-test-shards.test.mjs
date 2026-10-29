import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  checkShards,
  filtersFor,
  matrixEntries,
  PARTS,
  SHARDS,
  splitPackages,
  testedPackages,
} from './ci-test-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every package that has tests is in exactly one shard', async () => {
  assert.deepEqual(checkShards(await testedPackages(root)), []);
});

test('reports a package that no shard runs, one that two shards run, and an unknown one', () => {
  const shards = { a: ['@x/one', '@x/two'], b: ['@x/two', '@x/ghost'] };
  assert.deepEqual(checkShards(['@x/one', '@x/two', '@x/three'], shards, [], {}), [
    '@x/two is in both "a" and "b"',
    '@x/three has tests but belongs to no shard',
    '@x/ghost is in a shard but has no test script',
  ]);
});

test('does not ask the UI packages to be in a shard', () => {
  assert.deepEqual(checkShards(['@x/ui'], {}, ['@x/ui'], {}), []);
});

test('only lets a shard of one package be split into at least two parts', () => {
  const shards = { one: ['@x/one'], two: ['@x/a', '@x/b'] };
  const tested = ['@x/one', '@x/a', '@x/b'];
  assert.deepEqual(checkShards(tested, shards, [], { one: 3 }), []);
  assert.deepEqual(checkShards(tested, shards, [], { one: 1, two: 2, ghost: 2 }), [
    '"one" needs at least 2 parts',
    '"two" is split into parts, so it must hold exactly one package',
    '"ghost" is split into parts but is not a shard',
  ]);
});

test('turns a shard into turbo filters', () => {
  assert.equal(filtersFor('management'), '--filter=@authrim/ar-management');
  assert.ok(filtersFor('auth').split(' ').length === SHARDS.auth.length);
  assert.throws(() => filtersFor('missing'), /Unknown shard/);
});

test('turns a split shard into one matrix job per vitest part', () => {
  const shards = { big: ['@x/big'], small: ['@x/small'] };
  assert.deepEqual(matrixEntries(shards, { big: 2 }), [
    { shard: 'big', id: 'big-1', part: '1', vitestShard: '--shard=1/2' },
    { shard: 'big', id: 'big-2', part: '2', vitestShard: '--shard=2/2' },
    { shard: 'small', id: 'small', part: '', vitestShard: '' },
  ]);
  assert.deepEqual(splitPackages(shards, { big: 2 }), [{ directory: 'big', parts: 2 }]);
});

test('management runs as several parts, in a package directory that exists', () => {
  assert.ok(PARTS.management >= 2);
  assert.deepEqual(splitPackages(), [{ directory: 'ar-management', parts: PARTS.management }]);
});

test('the matrix of the CI workflow is the one the shard script describes', async () => {
  const workflow = parse(await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const job = workflow.jobs['api-package-tests'];
  assert.deepEqual(job.strategy.matrix.include, matrixEntries());
  assert.ok(workflow.jobs['lint-and-test'].needs.includes('api-package-tests'));
  assert.ok(workflow.jobs['coverage-summary'].needs.includes('api-package-tests'));
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { collectPackageSizes } from './ci-package-sizes.mjs';
import { buildComment } from './ci-pr-coverage-comment.mjs';

test('measures nested outputs and both UIs, excludes metadata/tests, and renders totals', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authrim-sizes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = 'x'.repeat(1024);
  for (const name of ['ar-auth', 'ar-admin-ui', 'ar-login-ui']) {
    const dir = path.join(root, 'packages', name);
    const output = path.join(dir, name.endsWith('-ui') ? '.svelte-kit/cloudflare' : 'dist');
    await fs.mkdir(path.join(output, 'nested'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `@authrim/${name}` })
    );
    await fs.writeFile(path.join(output, 'nested', 'index.js'), content);
    for (const ignored of [
      'index.js.map',
      'index.d.ts',
      'index.test.js',
      'index.spec.js',
      'tsconfig.tsbuildinfo',
    ]) {
      await fs.writeFile(path.join(output, ignored), 'ignored');
    }
    await fs.mkdir(path.join(output, '__tests__'));
    await fs.writeFile(path.join(output, '__tests__', 'fixture.js'), 'ignored');
  }
  const sizes = await collectPackageSizes(root);
  assert.equal(sizes.packages.length, 3);
  assert.deepEqual(sizes.totals, {
    uncompressedBytes: 3072,
    gzipBytes: 3 * gzipSync(content).length,
  });
  for (const pkg of sizes.packages) assert.equal(pkg.uncompressedBytes, 1024);
  const comment = buildComment({
    packages: [
      {
        name: '@authrim/ar-auth',
        status: 'covered',
        testCases: 2,
        coverage: { statements: { pct: 75 } },
      },
    ],
    totals: { codeLines: 1, testLines: 1 },
    repositorySuites: [],
    packageSizes: sizes,
  });
  const packageTable = comment.split('### Packages')[1].split('### Repository Test Suites')[0];
  assert.ok(!packageTable.includes('| status |'));
  assert.ok(!packageTable.includes('| lines |'));
  assert.match(packageTable, /Package \| Test cases \| stmts \| branches \| funcs \| Uncompressed \| Gzip/);
  assert.match(packageTable, /@authrim\/ar-auth \| 2 \| 75.00% \| - \| - \| 1.00 KiB/);
  assert.match(packageTable, /@authrim\/ar-admin-ui \| - \| - \| - \| - \| 1.00 KiB/);
  assert.match(comment, /All packages uncompressed \| 0.00 MiB/);
  assert.match(comment, /All packages gzip \| 0.00 MiB/);
  // Exercise MiB conversion independently of small filesystem fixtures.
  sizes.totals = { uncompressedBytes: 2 * 1024 ** 2, gzipBytes: 1024 ** 2 };
  const large = buildComment({
    packages: [],
    totals: {},
    repositorySuites: [],
    packageSizes: sizes,
  });
  assert.match(large, /All packages uncompressed \| 2.00 MiB/);
  assert.match(large, /All packages gzip \| 1.00 MiB/);
  await fs.rm(path.join(root, 'packages/ar-auth/dist'), { recursive: true });
  await assert.rejects(collectPackageSizes(root), { code: 'ENOENT' });
});

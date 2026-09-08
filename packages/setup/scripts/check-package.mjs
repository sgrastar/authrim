/** Explicit, network-enabled release check; never publishes or deploys resources. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = await mkdtemp(join(tmpdir(), 'authrim-setup-package-'));
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', workspace], {
    cwd: packageDir,
    stdio: 'inherit',
  });
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      '--cache',
      join(workspace, 'cache'),
      join(workspace, `authrim-setup-${manifest.version}.tgz`),
    ],
    { cwd: workspace, stdio: 'inherit' }
  );
  const installed = join(workspace, 'node_modules', '@authrim', 'setup');
  const packed = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  for (const [name, range] of Object.entries(packed.dependencies ?? {})) {
    assert(!name.startsWith('@authrim/'), `Internal runtime dependency: ${name}`);
    assert(!range.startsWith('workspace:'), `Unresolved workspace dependency: ${name}`);
  }
  const entry = join(installed, packed.bin['authrim-setup']);
  for (const args of [['--version'], ['--help'], ['download', '--help']]) {
    const output = execFileSync(process.execPath, [entry, ...args], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert(output.trim().length > 0);
    if (args[0] === '--version') assert.equal(output.trim(), manifest.version);
  }
  process.stdout.write('Standalone npm install and launcher checks passed.\n');
} finally {
  await rm(workspace, { recursive: true, force: true });
}

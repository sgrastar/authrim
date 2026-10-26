import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.ts',
    'restore-cli': 'src/import/restore-cli.ts',
    'collector-cli': 'src/import/collector-cli.ts',
    lambda: 'src/lambda.ts',
    'db-bootstrap': 'src/maintenance/db-bootstrap-handler.ts',
    'synthetic-backup-cli': 'src/rehearsal/generate-synthetic-backup.ts',
    'browser-sp': 'src/rehearsal/browser-sp-lambda.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  metafile: true,
  define: { AUTHRIM_AWS_BUNDLED: 'true' },
  banner: {
    js: "import { createRequire as __authrimAwsRequire } from 'node:module'; const require = __authrimAwsRequire(import.meta.url);",
  },
  alias: {
    'cloudflare:workers': fileURLToPath(
      new URL('../src/cloudflare-unavailable.ts', import.meta.url)
    ),
  },
});
// Production serving entries must never contain maintenance or synthetic rehearsal helpers.
for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
  if (!/\/(?:lambda|index)\.mjs$/u.test(outputPath)) continue;
  if (
    Object.keys(output.inputs).some(
      (input) => input.startsWith('src/maintenance/') || input.startsWith('src/rehearsal/')
    )
  ) {
    throw new Error('synthetic_rehearsal_in_serving_bundle');
  }
}
// The isolated test SP receives no IdP signing key, fixture generator or maintenance executor.
for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
  if (!/\/browser-sp\.mjs$/u.test(outputPath)) continue;
  if (
    Object.keys(output.inputs).some(
      (input) =>
        input.startsWith('src/maintenance/') ||
        input === 'src/rehearsal/synthetic-fixture.ts' ||
        input === 'src/rehearsal/generate-synthetic-backup.ts' ||
        input === 'src/rehearsal/saml-login-probe.ts'
    )
  ) {
    throw new Error('privileged_rehearsal_in_browser_sp_bundle');
  }
}
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/metafile.json', import.meta.url), JSON.stringify(result.metafile));
const storageOutput = new URL('../dist/storage/', import.meta.url);
await mkdir(storageOutput, { recursive: true });
const storageSource = new URL('../src/storage/', import.meta.url);
for (const name of await readdir(storageSource)) {
  if (name.endsWith('.sql'))
    await copyFile(new URL(name, storageSource), new URL(name, storageOutput));
}

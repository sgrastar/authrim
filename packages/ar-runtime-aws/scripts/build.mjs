import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = {
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.ts',
    'restore-cli': 'src/import/restore-cli.ts',
    'collector-cli': 'src/import/collector-cli.ts',
    lambda: 'src/lambda.ts',
    'db-bootstrap': 'src/maintenance/db-bootstrap-handler.ts',
    'synthetic-backup-cli': 'src/rehearsal/generate-synthetic-backup.ts',
    'browser-sp': 'src/rehearsal/browser-sp-lambda.ts',
    'dsql-cli': 'src/dsql/cli.ts',
    'runtime-ui-config': 'src/ui/runtime-ui-config.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  metafile: true,
  define: { AUTHRIM_AWS_BUNDLED: 'true', AUTHRIM_AWS_EMBEDDED_UI: 'true' },
  banner: {
    js: "import { createRequire as __authrimAwsRequire } from 'node:module'; const require = __authrimAwsRequire(import.meta.url);",
  },
  alias: {
    'cloudflare:workers': fileURLToPath(
      new URL('../src/cloudflare-unavailable.ts', import.meta.url)
    ),
  },
};
const result = await build(options);
const apiOnly = await build({
  ...options,
  entryPoints: { 'lambda-api': 'src/lambda.ts' },
  define: { ...options.define, AUTHRIM_AWS_EMBEDDED_UI: 'false' },
});
Object.assign(result.metafile.inputs, apiOnly.metafile.inputs);
Object.assign(result.metafile.outputs, apiOnly.metafile.outputs);
if (Object.keys(apiOnly.metafile.outputs['dist/lambda-api.mjs'].inputs).some(
  (input) => input === 'src/ui/passkey-login.ts'
)) throw new Error('embedded_login_ui_in_api_only_bundle');
// Production serving entries must never contain maintenance or synthetic rehearsal helpers.
for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
  if (!/\/(?:lambda|lambda-api|index)\.mjs$/u.test(outputPath)) continue;
  if (
    Object.keys(output.inputs).some(
      (input) =>
        input.startsWith('src/maintenance/') ||
        input.startsWith('src/rehearsal/') ||
        input.startsWith('src/dsql/')
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

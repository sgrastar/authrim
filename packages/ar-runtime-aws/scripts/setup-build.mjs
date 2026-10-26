import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve } from 'node:path';
import { AwsSetupError } from './setup-aws-cli.mjs';
import { readSetupFile, readSetupJson, setupDigest } from './setup-execution-state.mjs';

const execute = promisify(execFile);
const ENTRIES = [
  'index',
  'restore-cli',
  'collector-cli',
  'lambda',
  'lambda-api',
  'db-bootstrap',
  'synthetic-backup-cli',
  'browser-sp',
];

/** Pins the bytes esbuild actually consumed, including shared dist and installed dependency inputs. */
export async function readExecutionBuildPins(root) {
  const packageRoot = join(root, 'packages/ar-runtime-aws');
  const metafile = await readSetupJson(join(packageRoot, 'dist/metafile.json'), {
    maxBytes: 16 * 1024 * 1024,
  });
  if (!metafile.inputs || !metafile.outputs || Object.keys(metafile.inputs).length > 20_000)
    throw new AwsSetupError('aws_setup_build_manifest_invalid');
  const inputs = [];
  for (const name of Object.keys(metafile.inputs).sort()) {
    const path = resolve(packageRoot, name);
    const repositoryPath = relative(root, path);
    if (repositoryPath.startsWith('..') || repositoryPath.startsWith('/'))
      throw new AwsSetupError('aws_setup_build_input_outside_repository');
    const bytes = await readSetupFile(path, { maxBytes: 32 * 1024 * 1024 });
    inputs.push({ path: repositoryPath, sha256: setupDigest(bytes), bytes: bytes.length });
  }
  const outputs = {};
  for (const entry of ENTRIES) {
    const file = `dist/${entry}.mjs`;
    if (!metafile.outputs[file]) throw new AwsSetupError('aws_setup_build_output_missing');
    const bytes = await readSetupFile(join(packageRoot, file), { maxBytes: 64 * 1024 * 1024 });
    outputs[entry] = { sha256: setupDigest(bytes), bytes: bytes.length };
  }
  return { inputs, outputs };
}

/** No deployment hooks or caller-supplied commands. Existing shared builds are prerequisites and pinned. */
export async function captureExecutionBuild(root) {
  try {
    await execute(process.execPath, [join(root, 'packages/ar-runtime-aws/scripts/build.mjs')], {
      cwd: root,
      shell: false,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new AwsSetupError('aws_setup_build_failed');
  }
  return readExecutionBuildPins(root);
}

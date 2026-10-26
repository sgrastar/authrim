import { lstat, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  openVerifiedTenantBackupV2,
  type OpenVerifiedTenantBackupV2Input,
  type VerifiedTenantBackupV2,
} from './backup-reader';
import { canonicalRestoreJson, readPinnedRestoreFile } from './restore-evidence';
import {
  collectAwsSamlSupplementFromBackup,
  collectAwsSamlSupplementFromPinnedCapture,
} from './supplement-collector';

/** The plan is independently hash-pinned; secrets are referenced only by environment name. */
export interface AwsSupplementCollectorPlan {
  formatVersion: 1;
  backup: Omit<OpenVerifiedTenantBackupV2Input, 'passphrase' | 'signal' | 'nowMs'> & {
    passphraseEnv: string;
  };
  capture: { path: string; expectedSha256: string } | { source: 'bundle' };
  outputPath: string;
}

function invalid(): never {
  throw new Error('aws_supplement_collector_plan_invalid');
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
  )
    invalid();
}

export function resolveAwsSupplementCollectorPlan(
  plan: AwsSupplementCollectorPlan,
  environment: Readonly<Record<string, string | undefined>>
): {
  backup: OpenVerifiedTenantBackupV2Input;
  capture: AwsSupplementCollectorPlan['capture'];
  outputPath: string;
} {
  try {
    exactKeys(plan, ['formatVersion', 'backup', 'capture', 'outputPath']);
    exactKeys(plan.backup, [
      'partPaths',
      'receipt',
      'selection',
      'datasets',
      'maxSnapshotAgeMs',
      'passphraseEnv',
    ]);
    if (!plan.capture || typeof plan.capture !== 'object') invalid();
    if ('source' in plan.capture) {
      exactKeys(plan.capture, ['source']);
      if (plan.capture.source !== 'bundle') invalid();
    } else {
      exactKeys(plan.capture, ['path', 'expectedSha256']);
      if (typeof plan.capture.path !== 'string' || typeof plan.capture.expectedSha256 !== 'string')
        invalid();
    }
    if (
      plan.formatVersion !== 1 ||
      !Array.isArray(plan.backup.partPaths) ||
      typeof plan.outputPath !== 'string' ||
      typeof plan.backup.passphraseEnv !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(plan.backup.passphraseEnv)
    )
      invalid();
    const passphrase = environment[plan.backup.passphraseEnv];
    if (!passphrase) invalid();
    const { passphraseEnv: _passphraseEnv, ...backup } = plan.backup;
    return {
      backup: { ...backup, passphrase },
      capture: { ...plan.capture },
      outputPath: plan.outputPath,
    };
  } catch {
    return invalid();
  }
}

/** No Cloudflare or AWS API access. Only operator-supplied local files are opened. */
export async function runAwsSupplementCollectorCli(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node dist/collector-cli.mjs --plan /absolute/plan.json --plan-sha256 <trusted SHA256>\n'
    );
    return;
  }
  let backup: VerifiedTenantBackupV2 | null = null;
  let createdOutput: { path: string; dev: bigint; ino: bigint } | null = null;
  try {
    if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--plan-sha256') invalid();
    const bytes = await readPinnedRestoreFile(args[1], args[3], 4 * 1024 * 1024);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const plan = JSON.parse(raw) as AwsSupplementCollectorPlan;
    if (canonicalRestoreJson(plan) !== raw) invalid();
    const input = resolveAwsSupplementCollectorPlan(plan, process.env);
    backup = await openVerifiedTenantBackupV2(input.backup);
    const receipt =
      'source' in input.capture
        ? await collectAwsSamlSupplementFromBackup({ backup, outputPath: input.outputPath })
        : await collectAwsSamlSupplementFromPinnedCapture({
            backup,
            capturePath: input.capture.path,
            expectedCaptureSha256: input.capture.expectedSha256,
            outputPath: input.outputPath,
          });
    const identity = await lstat(receipt.outputPath, { bigint: true });
    createdOutput = { path: receipt.outputPath, dev: identity.dev, ino: identity.ino };
    await backup.close();
    backup = null;
    // The output contains only identifiers, hashes and row counts, never source values.
    process.stdout.write(`${canonicalRestoreJson({ status: 'collected', ...receipt })}\n`);
  } catch {
    if (createdOutput) {
      const observed = await lstat(createdOutput.path, { bigint: true }).catch(() => null);
      if (observed?.dev === createdOutput.dev && observed.ino === createdOutput.ino) {
        await unlink(createdOutput.path).catch(() => undefined);
      }
    }
    if (backup) await backup.close().catch(() => undefined);
    process.stderr.write('aws_supplement_collector_failed\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runAwsSupplementCollectorCli(process.argv.slice(2));
}

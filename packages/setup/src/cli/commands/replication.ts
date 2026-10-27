/** Provider-independent replication commands. Runtime owns plans, validation and durable state. */
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';

export type ReplicationMode =
  | 'plan'
  | 'status'
  | 'sync'
  | 'switch'
  | 'resume'
  | 'initialize'
  | 'failover'
  | 'cancel'
  | 'watch';

export interface ReplicationOptions {
  source?: string;
  config?: string;
  out?: string;
  plan?: string;
  planSha256?: string;
  state?: string;
  configSha256?: string;
  stateDir?: string;
  intervalSeconds?: string;
}

interface ReplicationDependencies {
  runScript?: (script: string, args: string[], rootDir: string) => Promise<number>;
  reportError?: (message: string) => void;
}

function executeScript(script: string, args: string[], rootDir: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
    });
    const forwardInt = () => {
      child.kill('SIGINT');
    };
    const forwardTerm = () => {
      child.kill('SIGTERM');
    };
    const cleanup = () => {
      process.off('SIGINT', forwardInt);
      process.off('SIGTERM', forwardTerm);
    };
    if (args[0] === 'watch') {
      process.on('SIGINT', forwardInt);
      process.on('SIGTERM', forwardTerm);
    }
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}

function filePath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    !value ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error('replication_arguments_invalid');
  }
  return resolve(value);
}

/** Paths and reviewed digest are forwarded verbatim; no cloud login or automatic fallback. */
export async function runReplicationCommand(
  mode: ReplicationMode,
  options: ReplicationOptions,
  dependencies: ReplicationDependencies = {}
): Promise<number> {
  const reportError =
    dependencies.reportError ?? ((message) => process.stderr.write(`${message}\n`));
  let rootDir: string;
  let script: string;
  let args: string[];
  try {
    rootDir = filePath(options.source ?? process.cwd());
    script = join(rootDir, 'packages', 'ar-runtime-aws', 'scripts', 'replication-execute.mjs');
    const metadata = await lstat(script);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('replication_source_missing');
    }
    if (mode === 'plan') {
      args = ['plan', '--config', filePath(options.config), '--out', filePath(options.out)];
    } else if (mode === 'status') {
      args = ['status', '--state', filePath(options.state)];
    } else if (mode === 'watch') {
      if (
        typeof options.configSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(options.configSha256) ||
        typeof options.intervalSeconds !== 'string' ||
        !/^[1-9][0-9]*$/u.test(options.intervalSeconds) ||
        Number(options.intervalSeconds) < 60 ||
        Number(options.intervalSeconds) > 2_592_000
      ) {
        throw new Error('replication_arguments_invalid');
      }
      args = [
        'watch',
        '--config',
        filePath(options.config),
        '--config-sha256',
        options.configSha256,
        '--state-dir',
        filePath(options.stateDir),
        '--interval-seconds',
        options.intervalSeconds,
      ];
    } else if (['sync', 'switch', 'resume', 'initialize', 'failover', 'cancel'].includes(mode)) {
      const digest = options.planSha256;
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
        throw new Error('replication_digest_invalid');
      }
      args = [
        mode,
        '--plan',
        filePath(options.plan),
        '--plan-sha256',
        digest,
        '--state',
        filePath(options.state),
      ];
    } else {
      throw new Error('replication_arguments_invalid');
    }
  } catch {
    reportError(
      JSON.stringify({ status: 'blocked', code: 'replication_source_or_arguments_invalid' })
    );
    return 2;
  }
  try {
    return await (dependencies.runScript ?? executeScript)(script, args, rootDir);
  } catch {
    reportError(JSON.stringify({ status: 'blocked', code: 'replication_process_failed' }));
    return 2;
  }
}

export function registerReplicationCommands(program: Command): void {
  const replication = program
    .command('replication')
    .description('Plan and operate an explicitly configured Cloudflare/AWS replication pair');
  replication
    .command('plan')
    .description('Validate local replication settings and write a pinned plan without cloud calls')
    .requiredOption(
      '--config <path>',
      'Public replication configuration; credentials are references'
    )
    .requiredOption('--out <path>', 'New plan file; existing files are never overwritten')
    .option('--source <path>', 'Authrim source repository')
    .action(async (options: ReplicationOptions) => {
      process.exitCode = await runReplicationCommand('plan', options);
    });
  replication
    .command('watch')
    .description(
      'Run periodic snapshot synchronization on this host until stopped; never promote automatically'
    )
    .requiredOption('--config <path>', 'Public replication configuration')
    .requiredOption('--config-sha256 <sha256>', 'Reviewed configuration digest')
    .requiredOption('--state-dir <path>', 'Dedicated private scheduler state directory')
    .requiredOption('--interval-seconds <seconds>', 'Snapshot interval, from 60 seconds to 30 days')
    .option('--source <path>', 'Authrim source repository')
    .action(async (options: ReplicationOptions) => {
      process.exitCode = await runReplicationCommand('watch', options);
    });
  replication
    .command('status')
    .description('Read saved replication progress without contacting either deployment')
    .requiredOption('--state <path>', 'Private durable execution state file')
    .option('--source <path>', 'Authrim source repository')
    .action(async (options: ReplicationOptions) => {
      process.exitCode = await runReplicationCommand('status', options);
    });
  for (const mode of ['sync', 'switch', 'resume', 'initialize', 'failover', 'cancel'] as const) {
    replication
      .command(mode)
      .description(
        mode === 'initialize'
          ? 'Explicitly initialize the dedicated authority database and pair from a reviewed plan'
          : mode === 'sync'
            ? 'Copy a verified encrypted snapshot into a fresh inactive generation'
            : mode === 'switch'
              ? 'Perform a planned drain, final snapshot verification and primary promotion'
              : mode === 'failover'
                ? 'Promote a reviewed standby snapshot within accepted data-loss bounds; unresolved writes block'
                : mode === 'cancel'
                  ? 'Cancel an unpromoted environment drain without discarding outstanding writer permits'
                  : 'Resume the same pinned replication operation from its durable state'
      )
      .requiredOption('--plan <path>', 'Pinned plan created with replication plan')
      .requiredOption('--plan-sha256 <sha256>', 'Reviewed plan digest returned by the plan command')
      .requiredOption('--state <path>', 'Private durable execution state file')
      .option('--source <path>', 'Authrim source repository')
      .action(async (options: ReplicationOptions) => {
        process.exitCode = await runReplicationCommand(mode, options);
      });
  }
}

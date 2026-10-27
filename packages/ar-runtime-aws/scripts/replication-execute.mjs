/** Setup transport only. The shared runtime CLI owns configuration, plans and operation state. */
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class ReplicationSetupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function argumentsFor(args) {
  const [mode, ...rest] = args;
  const required = {
    plan: ['config', 'out'],
    status: ['state'],
    sync: ['plan', 'plan-sha256', 'state'],
    switch: ['plan', 'plan-sha256', 'state'],
    resume: ['plan', 'plan-sha256', 'state'],
    initialize: ['plan', 'plan-sha256', 'state'],
    failover: ['plan', 'plan-sha256', 'state'],
    cancel: ['plan', 'plan-sha256', 'state'],
    watch: ['config', 'config-sha256', 'state-dir', 'interval-seconds'],
  }[mode];
  if (!Array.isArray(required) || rest.length !== required.length * 2) {
    throw new ReplicationSetupError('replication_arguments_invalid');
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const key = typeof flag === 'string' && flag.startsWith('--') ? flag.slice(2) : undefined;
    const value = rest[index + 1];
    if (
      !required.includes(key) ||
      options[key] !== undefined ||
      typeof value !== 'string' ||
      !value ||
      value.startsWith('--') ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new ReplicationSetupError('replication_arguments_invalid');
    }
    options[key] = value;
  }
  if (
    ['plan-sha256', 'config-sha256'].some(
      (key) => options[key] !== undefined && !/^[a-f0-9]{64}$/u.test(options[key])
    )
  ) {
    throw new ReplicationSetupError('replication_arguments_invalid');
  }
  if (
    options['interval-seconds'] !== undefined &&
    (!/^[1-9][0-9]*$/u.test(options['interval-seconds']) ||
      !Number.isSafeInteger(Number(options['interval-seconds'])) ||
      Number(options['interval-seconds']) < 60 ||
      Number(options['interval-seconds']) > 2592000)
  ) {
    throw new ReplicationSetupError('replication_arguments_invalid');
  }
  return [
    mode,
    ...required.flatMap((key) => [
      `--${key}`,
      ['plan-sha256', 'config-sha256', 'interval-seconds'].includes(key)
        ? options[key]
        : resolve(options[key]),
    ]),
  ];
}

function executeRuntime(bundle, args, root) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    if (args[0] === 'watch') {
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
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

export async function runReplicationExecutionCommand(
  args,
  root = process.cwd(),
  dependencies = {}
) {
  const forwarded = argumentsFor(args);
  const rootDir = resolve(root);
  const bundle = join(
    rootDir,
    'packages',
    'ar-runtime-aws',
    'dist',
    forwarded[0] === 'watch' ? 'replication-scheduler.mjs' : 'replication-cli.mjs'
  );
  try {
    const metadata = await lstat(bundle);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ReplicationSetupError('replication_runtime_unavailable');
    }
  } catch {
    throw new ReplicationSetupError('replication_runtime_unavailable');
  }
  try {
    return await (dependencies.execute ?? executeRuntime)(bundle, forwarded, rootDir);
  } catch {
    throw new ReplicationSetupError('replication_process_failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReplicationExecutionCommand(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ status: 'blocked', code: error instanceof ReplicationSetupError ? error.code : 'replication_process_failed' })}\n`
      );
      process.exitCode = 2;
    });
}

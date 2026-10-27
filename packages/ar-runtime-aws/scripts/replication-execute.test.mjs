import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { runReplicationExecutionCommand } from './replication-execute.mjs';

let root;
let bundle;
const digest = 'a'.repeat(64);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'authrim-replication-transport-'));
  bundle = join(root, 'packages/ar-runtime-aws/dist/replication-cli.mjs');
  await mkdir(dirname(bundle), { recursive: true });
  await writeFile(bundle, '// synthetic runtime transport fixture\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

for (const [mode, options] of [
  ['plan', ['--out', 'new-plan.json', '--config', 'public-config.json']],
  ['status', ['--state', 'state.json']],
  ...['sync', 'switch', 'resume', 'initialize', 'failover', 'cancel'].map((mode) => [
    mode,
    ['--state', 'state.json', '--plan-sha256', digest, '--plan', 'pinned plan.json'],
  ]),
]) {
  test(`${mode} forwards only the normalized public CLI contract`, async () => {
    const invocations = [];
    const result = await runReplicationExecutionCommand([mode, ...options], root, {
      execute: async (...args) => {
        invocations.push(args);
        return 0;
      },
    });
    const expected =
      mode === 'plan'
        ? ['plan', '--config', resolve('public-config.json'), '--out', resolve('new-plan.json')]
        : mode === 'status'
          ? ['status', '--state', resolve('state.json')]
          : [
              mode,
              '--plan',
              resolve('pinned plan.json'),
              '--plan-sha256',
              digest,
              '--state',
              resolve('state.json'),
            ];
    assert.equal(result, 0);
    assert.deepEqual(invocations, [[bundle, expected, root]]);
  });
}

for (const args of [
  [],
  ['unknown'],
  ['__proto__'],
  ['status'],
  ['status', '--state', 'state.json', '--force', 'true'],
  ['status', '--state', '--yes'],
  ['status', '--state', 'state\nprivate.json'],
  ['plan', '--config', 'config.json', '--config', 'other.json'],
  ['sync', '--plan', 'plan.json', '--plan-sha256', 'not-a-digest', '--state', 'state.json'],
  ['switch', '--plan', 'plan.json', '--plan-sha256', 'A'.repeat(64), '--state', 'state.json'],
  ['resume', '--plan', 'plan.json', '--plan-sha256', digest, '--credential', 'private-value'],
]) {
  test(`invalid arguments reject before execution: ${args[0] ?? 'missing mode'} ${args.length}`, async () => {
    let called = false;
    await assert.rejects(
      runReplicationExecutionCommand(args, root, {
        execute: async () => {
          called = true;
          return 0;
        },
      }),
      { code: 'replication_arguments_invalid' }
    );
    assert.equal(called, false);
  });
}

test('missing runtime bundle never creates a successful placeholder result', async () => {
  await rm(bundle);
  let called = false;
  await assert.rejects(
    runReplicationExecutionCommand(['status', '--state', 'state.json'], root, {
      execute: async () => {
        called = true;
        return 0;
      },
    }),
    { code: 'replication_runtime_unavailable' }
  );
  assert.equal(called, false);
});

test('runtime bundle must be a regular file, not a symbolic link or directory', async () => {
  await rm(bundle);
  const target = join(root, 'other.mjs');
  await writeFile(target, '// unrelated\n');
  await symlink(target, bundle);
  await assert.rejects(runReplicationExecutionCommand(['status', '--state', 'state.json'], root), {
    code: 'replication_runtime_unavailable',
  });
  await rm(bundle);
  await mkdir(bundle);
  await assert.rejects(runReplicationExecutionCommand(['status', '--state', 'state.json'], root), {
    code: 'replication_runtime_unavailable',
  });
});

test('real child process nonzero exit is preserved without interpreting it as completion', async () => {
  await writeFile(bundle, 'process.exitCode = 2;\n');
  assert.equal(await runReplicationExecutionCommand(['status', '--state', 'state.json'], root), 2);
});

test('exceptions from the runtime transport never expose arbitrary error content', async () => {
  await assert.rejects(
    runReplicationExecutionCommand(['status', '--state', 'state.json'], root, {
      execute: async () => {
        throw new Error('private credential and row');
      },
    }),
    { code: 'replication_process_failed', message: 'replication_process_failed' }
  );
});

test('watch selects the separate scheduler bundle with pinned config and unchanged numeric interval', async () => {
  const scheduler = join(dirname(bundle), 'replication-scheduler.mjs');
  await writeFile(scheduler, '// synthetic scheduler');
  const calls = [];
  const result = await runReplicationExecutionCommand(
    [
      'watch',
      '--state-dir',
      'watch-state',
      '--config',
      'config.json',
      '--interval-seconds',
      '300',
      '--config-sha256',
      digest,
    ],
    root,
    {
      execute: async (...args) => {
        calls.push(args);
        return 0;
      },
    }
  );
  assert.equal(result, 0);
  assert.deepEqual(calls, [
    [
      scheduler,
      [
        'watch',
        '--config',
        resolve('config.json'),
        '--config-sha256',
        digest,
        '--state-dir',
        resolve('watch-state'),
        '--interval-seconds',
        '300',
      ],
      root,
    ],
  ]);
});

for (const interval of ['0', '59', '60.1', '1e3', 'NaN', '2592001']) {
  test(`watch rejects invalid interval ${interval}`, async () => {
    await assert.rejects(
      runReplicationExecutionCommand(
        [
          'watch',
          '--config',
          'config.json',
          '--config-sha256',
          digest,
          '--state-dir',
          'state',
          '--interval-seconds',
          interval,
        ],
        root
      ),
      { code: 'replication_arguments_invalid' }
    );
  });
}

test('watch does not fall back to one-shot CLI when scheduler is missing', async () => {
  await assert.rejects(
    runReplicationExecutionCommand(
      [
        'watch',
        '--config',
        'config.json',
        '--config-sha256',
        digest,
        '--state-dir',
        'state',
        '--interval-seconds',
        '60',
      ],
      root
    ),
    { code: 'replication_runtime_unavailable' }
  );
});

test('watch transport forwards SIGTERM and waits for graceful scheduler exit', async () => {
  const scheduler = join(dirname(bundle), 'replication-scheduler.mjs');
  await writeFile(
    scheduler,
    String.raw`process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('stopped\n'); process.exit(0); }, 25));
process.stdout.write('ready\n');
setTimeout(() => process.exit(3), 3000);
`
  );
  const runner = join(root, 'run.mjs');
  const moduleUrl = new URL('./replication-execute.mjs', import.meta.url).href;
  const args = [
    'watch',
    '--config',
    'config.json',
    '--config-sha256',
    digest,
    '--state-dir',
    'state',
    '--interval-seconds',
    '60',
  ];
  await writeFile(
    runner,
    `import { runReplicationExecutionCommand } from ${JSON.stringify(moduleUrl)};
process.exitCode = await runReplicationExecutionCommand(${JSON.stringify(args)}, ${JSON.stringify(root)});
`
  );
  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let sent = false;
  child.stdout.on('data', (bytes) => {
    stdout += bytes.toString();
    if (!sent && stdout.includes('ready\n')) {
      sent = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString();
  });
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
  assert.equal(exit, 0, stderr);
  assert.equal(sent, true);
  assert.match(stdout, /stopped/);
});

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerReplicationCommands,
  runReplicationCommand,
  type ReplicationMode,
} from '../cli/commands/replication.js';

describe('provider-independent replication command', () => {
  let source: string;
  let script: string;
  const digest = 'a'.repeat(64);

  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), 'authrim-replication-command-'));
    script = join(source, 'packages/ar-runtime-aws/scripts/replication-execute.mjs');
    await mkdir(join(source, 'packages/ar-runtime-aws/scripts'), { recursive: true });
    await writeFile(script, '// transport fixture only\n');
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
  });

  it('registers an opt-in command group without changing Cloudflare or AWS commands', () => {
    const program = new Command();
    const existing = ['init', 'deploy', 'aws'].map((name) => program.command(name));
    registerReplicationCommands(program);
    expect(program.commands.slice(0, 3)).toEqual(existing);
    const command = program.commands[3];
    expect(command.name()).toBe('replication');
    expect(command.commands.map((entry) => entry.name())).toEqual([
      'plan',
      'watch',
      'status',
      'sync',
      'switch',
      'resume',
      'initialize',
      'failover',
      'cancel',
    ]);
    for (const mode of ['sync', 'switch', 'resume', 'initialize', 'failover', 'cancel']) {
      expect(
        command.commands
          .find((entry) => entry.name() === mode)
          ?.options.filter((option) => option.mandatory)
          .map((option) => option.long)
      ).toEqual(['--plan', '--plan-sha256', '--state']);
    }
    expect(
      command.commands.flatMap((entry) => entry.options.map((option) => option.long))
    ).not.toContain('--yes');
  });

  it('forwards local plan creation without credentials or prerequisite cloud calls', async () => {
    const runScript = vi.fn().mockResolvedValue(0);
    expect(
      await runReplicationCommand(
        'plan',
        { source, config: 'pair.json', out: 'reviewed-plan.json' },
        { runScript }
      )
    ).toBe(0);
    expect(runScript).toHaveBeenCalledExactlyOnceWith(
      script,
      ['plan', '--config', resolve('pair.json'), '--out', resolve('reviewed-plan.json')],
      source
    );
  });

  it('reads status with only the durable state path', async () => {
    const runScript = vi.fn().mockResolvedValue(0);
    expect(
      await runReplicationCommand('status', { source, state: 'progress.json' }, { runScript })
    ).toBe(0);
    expect(runScript).toHaveBeenCalledExactlyOnceWith(
      script,
      ['status', '--state', resolve('progress.json')],
      source
    );
  });

  it('forwards explicit watch settings without launching a background service or promoting', async () => {
    const runScript = vi.fn().mockResolvedValue(0);
    expect(
      await runReplicationCommand(
        'watch',
        {
          source,
          config: 'pair.json',
          configSha256: digest,
          stateDir: 'watch-state',
          intervalSeconds: '60',
        },
        { runScript }
      )
    ).toBe(0);
    expect(runScript).toHaveBeenCalledExactlyOnceWith(
      script,
      [
        'watch',
        '--config',
        resolve('pair.json'),
        '--config-sha256',
        digest,
        '--state-dir',
        resolve('watch-state'),
        '--interval-seconds',
        '60',
      ],
      source
    );
  });

  it.each(['0', '59', '2592001', 'Infinity', '1e3', '60.1', '060', ''])(
    'rejects invalid watch interval %s before child execution',
    async (intervalSeconds) => {
      const runScript = vi.fn();
      expect(
        await runReplicationCommand(
          'watch',
          {
            source,
            config: 'pair.json',
            configSha256: digest,
            stateDir: 'watch-state',
            intervalSeconds,
          },
          { runScript, reportError: vi.fn() }
        )
      ).toBe(2);
      expect(runScript).not.toHaveBeenCalled();
    }
  );

  it('forwards a watcher stop signal and waits for the child to finish its current operation', async () => {
    const before = process.listeners('SIGTERM');
    await writeFile(
      script,
      `import { writeFile } from 'node:fs/promises';
const marker = ${JSON.stringify(join(source, 'watch-marker'))};
const interval = setInterval(() => {}, 1000);
process.on('SIGTERM', async () => {
  clearInterval(interval);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(marker, 'finished-current-operation');
});
await writeFile(marker, 'ready');\n`
    );
    const running = runReplicationCommand('watch', {
      source,
      config: 'pair.json',
      configSha256: digest,
      stateDir: 'watch-state',
      intervalSeconds: '60',
    });
    await vi.waitFor(async () =>
      expect(await readFile(join(source, 'watch-marker'), 'utf8')).toBe('ready')
    );
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    added[0]();
    expect(await running).toBe(0);
    expect(await readFile(join(source, 'watch-marker'), 'utf8')).toBe('finished-current-operation');
    expect(process.listeners('SIGTERM')).toEqual(before);
  });

  it.each(['sync', 'switch', 'resume', 'initialize', 'failover', 'cancel'] as const)(
    'forwards %s to the same runtime with the reviewed plan and durable state',
    async (mode) => {
      const runScript = vi.fn().mockResolvedValue(0);
      expect(
        await runReplicationCommand(
          mode,
          { source, plan: 'plan with spaces.json', planSha256: digest, state: 'state.json' },
          { runScript }
        )
      ).toBe(0);
      expect(runScript).toHaveBeenCalledExactlyOnceWith(
        script,
        [
          mode,
          '--plan',
          resolve('plan with spaces.json'),
          '--plan-sha256',
          digest,
          '--state',
          resolve('state.json'),
        ],
        source
      );
    }
  );

  it.each([undefined, '', 'not-a-digest', 'A'.repeat(64)])(
    'rejects an absent or malformed plan digest before invoking the runtime',
    async (planSha256) => {
      const runScript = vi.fn();
      const reportError = vi.fn();
      expect(
        await runReplicationCommand(
          'switch',
          { source, plan: 'plan.json', state: 'state.json', planSha256 },
          { runScript, reportError }
        )
      ).toBe(2);
      expect(runScript).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ status: 'blocked', code: 'replication_source_or_arguments_invalid' })
      );
    }
  );

  it.each([
    ['plan', { config: 'pair.json' }],
    ['status', {}],
    ['resume', { plan: 'plan.json', planSha256: digest }],
    ['sync', { plan: 'plan.json', planSha256: digest, state: 'state\nsecret.json' }],
    ['watch', { config: 'pair.json', stateDir: 'watch-state', intervalSeconds: '60' }],
    [
      'watch',
      {
        config: 'pair.json',
        configSha256: 'A'.repeat(64),
        stateDir: 'watch-state',
        intervalSeconds: '60',
      },
    ],
  ] as const)('rejects incomplete or invalid %s paths', async (mode, options) => {
    const runScript = vi.fn();
    expect(
      await runReplicationCommand(mode, { source, ...options }, { runScript, reportError: vi.fn() })
    ).toBe(2);
    expect(runScript).not.toHaveBeenCalled();
  });

  it('rejects an unknown command instead of selecting a default operation', async () => {
    const runScript = vi.fn();
    expect(
      await runReplicationCommand(
        'other' as ReplicationMode,
        { source },
        { runScript, reportError: vi.fn() }
      )
    ).toBe(2);
    expect(runScript).not.toHaveBeenCalled();
  });

  it('fails closed when the source transport is absent or a symbolic link', async () => {
    await rm(script);
    const runScript = vi.fn();
    const options = { source, state: 'state.json' };
    expect(
      await runReplicationCommand('status', options, { runScript, reportError: vi.fn() })
    ).toBe(2);
    const target = join(source, 'unexpected.mjs');
    await writeFile(target, 'throw new Error("unexpected execution");');
    await symlink(target, script);
    expect(
      await runReplicationCommand('status', options, { runScript, reportError: vi.fn() })
    ).toBe(2);
    expect(runScript).not.toHaveBeenCalled();
  });

  it('preserves a backend failure instead of reporting successful synchronization', async () => {
    const runScript = vi.fn().mockResolvedValue(2);
    expect(
      await runReplicationCommand(
        'sync',
        { source, plan: 'plan.json', planSha256: digest, state: 'state.json' },
        { runScript }
      )
    ).toBe(2);
  });

  it('redacts child process exceptions', async () => {
    const reportError = vi.fn();
    expect(
      await runReplicationCommand(
        'status',
        { source, state: 'state.json' },
        {
          runScript: vi.fn().mockRejectedValue(new Error('credential and private-row-content')),
          reportError,
        }
      )
    ).toBe(2);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ status: 'blocked', code: 'replication_process_failed' })
    );
  });
});

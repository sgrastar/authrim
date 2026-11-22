/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment -- mock call inspection */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

const watchReplication = vi.fn();
vi.mock('./scheduler', () => ({ watchReplication: (...a: unknown[]) => watchReplication(...a) }));

const STOPPED_MSG =
  'replication_watch_stopped; inspect saved state and reviewed configuration before restarting\n';
const valid = [
  'watch',
  '--config',
  'c.json',
  '--config-sha256',
  'abc',
  '--state-dir',
  '/s',
  '--interval-seconds',
  '30',
];

describe('runReplicationSchedulerCli', () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    watchReplication.mockReset();
    watchReplication.mockResolvedValue(undefined);
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(args: string[]) {
    const { runReplicationSchedulerCli } = await import('./scheduler-cli');
    await runReplicationSchedulerCli(args);
  }

  it('passes parsed options and stops cleanly', async () => {
    await run(valid);
    expect(watchReplication).toHaveBeenCalledTimes(1);
    const [opts, signal] = watchReplication.mock.calls[0];
    expect(opts.configPath).toBe('c.json');
    expect(opts.configSha256).toBe('abc');
    expect(opts.stateDirectory).toBe('/s');
    expect(opts.intervalSeconds).toBe(30);
    expect(opts.executorPath).toBe(
      fileURLToPath(
        new URL('./replication-cli.mjs', new URL('./scheduler-cli.ts', import.meta.url))
      )
    );
    expect(opts.schedulerPath).toBe(fileURLToPath(new URL('./scheduler-cli.ts', import.meta.url)));
    expect(signal.aborted).toBe(false);
    expect(out).toHaveBeenCalledWith('{"status":"stopped","automaticPromotion":false}\n');
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('accepts options in any order', async () => {
    await run([
      'watch',
      '--interval-seconds',
      '5',
      '--state-dir',
      '/s',
      '--config-sha256',
      'h',
      '--config',
      'x',
    ]);
    expect(watchReplication.mock.calls[0][0].intervalSeconds).toBe(5);
    expect(watchReplication.mock.calls[0][0].configPath).toBe('x');
  });

  it('aborts the signal on SIGTERM / SIGINT and removes listeners afterwards', async () => {
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    let captured: AbortSignal | undefined;
    watchReplication.mockImplementation(async (_o: unknown, s: AbortSignal) => {
      captured = s;
      expect(process.listenerCount('SIGTERM')).toBe(before[0] + 1);
      expect(process.listenerCount('SIGINT')).toBe(before[1] + 1);
      process.emit('SIGTERM');
      expect(s.aborted).toBe(true);
    });
    await run(valid);
    expect(captured?.aborted).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(before[0]);
    expect(process.listenerCount('SIGINT')).toBe(before[1]);

    watchReplication.mockImplementation(async (_o: unknown, s: AbortSignal) => {
      process.emit('SIGINT');
      expect(s.aborted).toBe(true);
    });
    await run(valid);
  });

  const bad: Array<[string, string[]]> = [
    ['no args', []],
    ['wrong command', ['run', ...valid.slice(1)]],
    ['too few args', valid.slice(0, 7)],
    ['too many args', [...valid, '--config', 'z']],
    [
      'missing -- prefix',
      [
        'watch',
        'config',
        'c',
        '--config-sha256',
        'a',
        '--state-dir',
        '/s',
        '--interval-seconds',
        '3',
      ],
    ],
    [
      'single dash prefix',
      [
        'watch',
        '-xconfig',
        'c',
        '--config-sha256',
        'a',
        '--state-dir',
        '/s',
        '--interval-seconds',
        '3',
      ],
    ],
    [
      'unknown key',
      [
        'watch',
        '--bogus',
        'c',
        '--config-sha256',
        'a',
        '--state-dir',
        '/s',
        '--interval-seconds',
        '3',
      ],
    ],
    [
      'duplicate key',
      ['watch', '--config', 'c', '--config', 'd', '--state-dir', '/s', '--interval-seconds', '3'],
    ],
    [
      'empty value',
      [
        'watch',
        '--config',
        '',
        '--config-sha256',
        'a',
        '--state-dir',
        '/s',
        '--interval-seconds',
        '3',
      ],
    ],
    ['zero interval', [...valid.slice(0, 8), '0']],
    ['leading zero interval', [...valid.slice(0, 8), '05']],
    ['non numeric interval', [...valid.slice(0, 8), '1a']],
    ['prefixed junk interval', [...valid.slice(0, 8), 'a1']],
    ['negative interval', [...valid.slice(0, 8), '-1']],
    ['decimal interval', [...valid.slice(0, 8), '1.5']],
  ];
  for (const [name, args] of bad) {
    it(`rejects ${name}`, async () => {
      await run(args);
      expect(watchReplication).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith(STOPPED_MSG);
      expect(out).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  }

  it('accepts multi digit interval and rejects trailing junk after digits', async () => {
    await run([...valid.slice(0, 8), '120']);
    expect(watchReplication.mock.calls[0][0].intervalSeconds).toBe(120);
    watchReplication.mockClear();
    await run([...valid.slice(0, 8), '12x']);
    expect(watchReplication).not.toHaveBeenCalled();
  });

  it('reports failure when the watcher throws', async () => {
    watchReplication.mockRejectedValue(new Error('boom'));
    await run(valid);
    expect(err).toHaveBeenCalledWith(STOPPED_MSG);
    expect(out).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('scheduler-cli main guard', () => {
  const orig = process.argv[1];
  afterEach(() => {
    process.argv[1] = orig;
    vi.resetModules();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  it('runs with process.argv when invoked as entrypoint', async () => {
    vi.resetModules();
    watchReplication.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const target = fileURLToPath(new URL('./scheduler-cli.ts', import.meta.url));
    const argvBackup = process.argv;
    process.argv = [argvBackup[0], target, ...valid];
    try {
      await import('./scheduler-cli');
    } finally {
      process.argv = argvBackup;
    }
    expect(pathToFileURL(target).href).toBe(new URL('./scheduler-cli.ts', import.meta.url).href);
    expect(watchReplication).toHaveBeenCalledTimes(1);
    expect(watchReplication.mock.calls[0][0].configPath).toBe('c.json');
  });
  it('does not run when not the entrypoint', async () => {
    vi.resetModules();
    watchReplication.mockReset();
    await import('./scheduler-cli');
    expect(watchReplication).not.toHaveBeenCalled();
  });
});

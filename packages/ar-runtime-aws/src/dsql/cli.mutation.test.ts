/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- fakes and deliberately malformed inputs are intentionally untyped */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDsqlAssessmentSources, runDsqlCli } from './cli';
import { runDsqlConfigurationProbe } from './configuration-probe';
import { runDsqlIdentityProbe } from './identity-probe';
import { runDsqlProbe } from './probe';

const adapter = vi.hoisted(() => ({ close: vi.fn(), created: vi.fn() }));
vi.mock('./adapter', () => ({
  AuroraDsqlAdapter: class {
    constructor(config: unknown) {
      adapter.created(config);
    }
    close = adapter.close;
  },
}));
vi.mock('./probe', () => ({ runDsqlProbe: vi.fn() }));
vi.mock('./identity-probe', () => ({ runDsqlIdentityProbe: vi.fn() }));
vi.mock('./configuration-probe', () => ({ runDsqlConfigurationProbe: vi.fn() }));

const FAILURE = 'dsql_evaluation_failed; configuration and server details were withheld\n';
const HELP =
  'Experimental DSQL compatibility tools; do not activate the SAML runtime.\n' +
  '  assess --root <repository>\n' +
  '  probe --config <connection.json> [--write-probe]\n' +
  '  identity-probe --config <connection.json> --write-probe [--users <1..2000>]\n' +
  '  configuration-probe --config <connection.json> --write-probe [--sps <1..2000>]\n' +
  'Assessment is local only. Probe is read-only unless --write-probe is specified.\n' +
  'Write probes use a new synthetic schema and remove only their own objects.\n';

let directory: string;
let config: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
const validConfig = {
  hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
  region: 'ap-northeast-1',
  user: 'admin',
};
const out = () => stdout.mock.calls.map(([m]: [unknown]) => String(m)).join('');
const err = () => stderr.mock.calls.map(([m]: [unknown]) => String(m)).join('');

beforeEach(async () => {
  vi.clearAllMocks();
  adapter.close.mockResolvedValue(undefined);
  directory = await mkdtemp(join(tmpdir(), 'authrim-dsql-cli-mut-'));
  config = join(directory, 'connection.json');
  await writeFile(config, JSON.stringify(validConfig));
  stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function fixtureRoot(extra: Record<string, string> = {}): Promise<string> {
  const files: Record<string, string> = {
    'migrations/core/postgresql/b.sql': 'SELECT 2;',
    'migrations/core/postgresql/a.sql': 'SELECT 1;',
    'migrations/core/postgresql/notes.txt': 'x',
    'migrations/core/postgresql/c.sql.bak': 'x',
    'migrations/pii/postgresql/p.sql': 'SELECT 3;',
    'packages/ar-runtime-aws/src/storage/s.sql': 'SELECT 4;',
    'packages/ar-runtime-aws/src/storage/s.ts': 'x',
    ...Object.fromEntries(
      [
        'maintenance/database.ts',
        'import/aws-schema-bootstrap.ts',
        'import/postgres-restore.ts',
        'import/state-restore.ts',
        'storage/postgres-account-auth-state.ts',
        'storage/postgres-authorization-code.ts',
      ].map((p) => [`packages/ar-runtime-aws/src/${p}`, ''])
    ),
    ...extra,
  };
  for (const [name, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), source);
  }
  return directory;
}

describe('DSQL CLI (mutation hardening)', () => {
  it('lists only .sql files, sorted, with kinds', async () => {
    const root = await fixtureRoot();
    const sources = await loadDsqlAssessmentSources(root);
    expect(sources.map((s) => `${s.kind}:${s.path}`)).toEqual([
      'sql:migrations/core/postgresql/a.sql',
      'sql:migrations/core/postgresql/b.sql',
      'sql:migrations/pii/postgresql/p.sql',
      'sql:packages/ar-runtime-aws/src/storage/s.sql',
      ...[
        'maintenance/database.ts',
        'import/aws-schema-bootstrap.ts',
        'import/postgres-restore.ts',
        'import/state-restore.ts',
        'storage/postgres-account-auth-state.ts',
        'storage/postgres-authorization-code.ts',
      ].map((p) => `typescript:packages/ar-runtime-aws/src/${p}`),
    ]);
  });

  it('prints exact help and exits 0 only for a lone --help', async () => {
    expect(await runDsqlCli(['--help'])).toBe(0);
    expect(out()).toBe(HELP);
    expect(err()).toBe('');
    stdout.mockClear();
    expect(await runDsqlCli(['--help', 'extra'])).toBe(1);
    expect(await runDsqlCli(['--helpx'])).toBe(1);
    expect(await runDsqlCli([])).toBe(1);
    expect(out()).toBe('');
    expect(err()).toBe(FAILURE + FAILURE + FAILURE);
  });

  it('assess: exit 0 without blockers, 2 with blockers, strict argument shape', async () => {
    const root = await fixtureRoot();
    expect(await runDsqlCli(['assess', '--root', root])).toBe(0);
    const report = JSON.parse(out());
    expect(report.sourcesScanned).toBe(10);
    expect(out()).toBe(`${JSON.stringify(report, null, 2)}\n`);
    stdout.mockClear();
    // a manual-review finding alone is not a blocker
    await writeFile(join(root, 'migrations/core/postgresql/a.sql'), 'CREATE INDEX i ON t(a);');
    expect(await runDsqlCli(['assess', '--root', root])).toBe(0);
    expect(JSON.parse(out()).findings.length).toBeGreaterThan(0);
    stdout.mockClear();
    await writeFile(join(root, 'migrations/core/postgresql/a.sql'), 'CREATE DATABASE d;');
    expect(await runDsqlCli(['assess', '--root', root])).toBe(2);
    stdout.mockClear();
    expect(await runDsqlCli(['assess', '--bad', root])).toBe(1);
    expect(await runDsqlCli(['other', '--root', root])).toBe(1);
    expect(await runDsqlCli(['assess', '--root'])).toBe(1);
    expect(await runDsqlCli(['assess', '--root', root, 'x'])).toBe(1);
    expect(out()).toBe('');
    expect(err()).toBe(FAILURE.repeat(4));
  });

  it('identity-probe: default count, explicit count, exit code, JSON output, close', async () => {
    const report = { passed: true, checks: [] };
    vi.mocked(runDsqlIdentityProbe).mockResolvedValue(report as never);
    expect(await runDsqlCli(['identity-probe', '--config', config, '--write-probe'])).toBe(0);
    expect(runDsqlIdentityProbe).toHaveBeenCalledWith(expect.anything(), {
      writeProbe: true,
      userCount: 201,
    });
    expect(adapter.created).toHaveBeenCalledWith(validConfig);
    expect(out()).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(adapter.close).toHaveBeenCalledTimes(1);
    expect(runDsqlConfigurationProbe).not.toHaveBeenCalled();
    expect(runDsqlProbe).not.toHaveBeenCalled();
    for (const [n, expected] of [
      ['1', 1],
      ['2000', 2000],
      ['9', 9],
    ] as const) {
      vi.mocked(runDsqlIdentityProbe).mockClear();
      expect(
        await runDsqlCli(['identity-probe', '--config', config, '--write-probe', '--users', n])
      ).toBe(0);
      expect(runDsqlIdentityProbe).toHaveBeenCalledWith(expect.anything(), {
        writeProbe: true,
        userCount: expected,
      });
    }
    vi.mocked(runDsqlIdentityProbe).mockResolvedValue({ passed: false } as never);
    expect(await runDsqlCli(['identity-probe', '--config', config, '--write-probe'])).toBe(1);
    expect(err()).toBe('');
  });

  it('configuration-probe: default count, exit code, close on failure', async () => {
    vi.mocked(runDsqlConfigurationProbe).mockResolvedValue({ passed: true } as never);
    expect(await runDsqlCli(['configuration-probe', '--config', config, '--write-probe'])).toBe(0);
    expect(runDsqlConfigurationProbe).toHaveBeenCalledWith(expect.anything(), {
      writeProbe: true,
      spCount: 101,
    });
    vi.mocked(runDsqlConfigurationProbe).mockResolvedValue({ passed: false } as never);
    expect(await runDsqlCli(['configuration-probe', '--config', config, '--write-probe'])).toBe(1);
    adapter.close.mockClear();
    vi.mocked(runDsqlConfigurationProbe).mockRejectedValue(new Error('boom'));
    expect(await runDsqlCli(['configuration-probe', '--config', config, '--write-probe'])).toBe(1);
    expect(adapter.close).toHaveBeenCalledTimes(1);
    expect(err()).toBe(FAILURE);
  });

  it('rejects malformed probe invocations before touching the adapter', async () => {
    const cases: string[][] = [
      ['identity-probe', '--config', config],
      ['identity-probe', '--config', config, '--write-probe', '--sps', '5'],
      ['identity-probe', '--config', config, '--write-probe', '--users'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '5', 'x'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '0'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '2001'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '1e3'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '0123'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '12345'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '5x'],
      ['identity-probe', '--config', config, '--write-probe', '--users', ' 5'],
      ['identity-probe', '--config', config, '--write-probe', '--users', '+5'],
      ['identity-probe', '--bad', config, '--write-probe'],
      ['identity-probe', '--config', config, '--no-write'],
      ['configuration-probe', '--config', config, '--write-probe', '--users', '5'],
      ['configuration-probe', '--config', config, '--write-probe', '--sps', '0'],
      ['configuration-probe', '--config', config, '--write-probe', '--sps', '2001'],
      ['configuration-probe', '--config', config, '--write-probe', '--sps', '0123'],
      ['configuration-probe', '--config', config, '--write-probe', '--sps', '5x'],
      ['configuration-probe', '--bad', config, '--write-probe'],
      ['configuration-probe', '--config', config, '--no-write'],
      ['probe', '--config', config, '--no-write'],
      ['probe', '--bad', config],
      ['probe', '--config'],
      ['probe', '--config', config, '--write-probe', 'x'],
      ['unknown', '--config', config],
      ['unknown', '--config', config, '--write-probe'],
      [],
    ];
    for (const args of cases) expect(await runDsqlCli(args), args.join(' ')).toBe(1);
    expect(adapter.created).not.toHaveBeenCalled();
    expect(runDsqlIdentityProbe).not.toHaveBeenCalled();
    expect(runDsqlConfigurationProbe).not.toHaveBeenCalled();
    expect(runDsqlProbe).not.toHaveBeenCalled();
    expect(out()).toBe('');
    expect(err()).toBe(FAILURE.repeat(cases.length));
  });

  it('validates the connection config before building an adapter', async () => {
    const bad = join(directory, 'bad.json');
    await writeFile(bad, JSON.stringify({ hostname: 'localhost' }));
    for (const args of [
      ['probe', '--config', bad],
      ['identity-probe', '--config', bad, '--write-probe'],
      ['configuration-probe', '--config', bad, '--write-probe'],
    ])
      expect(await runDsqlCli(args)).toBe(1);
    expect(adapter.created).not.toHaveBeenCalled();
  });

  it('probe: read-only by default, writes only with --write-probe, closes adapter', async () => {
    vi.mocked(runDsqlProbe).mockResolvedValue({ passed: true } as never);
    expect(await runDsqlCli(['probe', '--config', config])).toBe(0);
    expect(runDsqlProbe).toHaveBeenLastCalledWith(expect.anything(), { writeProbe: false });
    expect(out()).toBe(`${JSON.stringify({ passed: true }, null, 2)}\n`);
    expect(await runDsqlCli(['probe', '--config', config, '--write-probe'])).toBe(0);
    expect(runDsqlProbe).toHaveBeenLastCalledWith(expect.anything(), { writeProbe: true });
    expect(adapter.close).toHaveBeenCalledTimes(2);
    vi.mocked(runDsqlProbe).mockResolvedValue({ passed: false } as never);
    expect(await runDsqlCli(['probe', '--config', config])).toBe(1);
    expect(adapter.close).toHaveBeenCalledTimes(3);
    vi.mocked(runDsqlProbe).mockRejectedValue(new Error('x'));
    expect(await runDsqlCli(['probe', '--config', config])).toBe(1);
    expect(adapter.close).toHaveBeenCalledTimes(4);
    expect(runDsqlIdentityProbe).not.toHaveBeenCalled();
    expect(runDsqlConfigurationProbe).not.toHaveBeenCalled();
  });

  it('runs as a script only when it is the entry module', async () => {
    const self = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
    const argv = process.argv;
    const exitCode = process.exitCode;
    try {
      process.argv = [argv[0], join(directory, 'other.js'), '--help'];
      vi.resetModules();
      await import('./cli');
      expect(out()).toBe('');
      process.argv = [argv[0], self, '--help'];
      vi.resetModules();
      await import('./cli');
      expect(out()).toBe(HELP);
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  });
});

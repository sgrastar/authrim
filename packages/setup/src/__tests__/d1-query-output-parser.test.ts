import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import {
  parseD1DatabaseListOutput,
  parseD1RowsFromWranglerJson,
  parseKVNamespaceListOutput,
  queryD1Rows,
  runD1Migrations,
} from '../core/cloudflare.js';

/**
 * queryD1Rows answers questions such as "was this migration applied?", "does this resource exist?"
 * and "has the handoff been accepted?". A failed query that reads as "no rows" makes every one of
 * those answers "no", so the only output accepted as an empty result is a result that says
 * `success: true`. Every case below is output Wrangler could plausibly emit with exit code 0.
 */

const OK_EMPTY = JSON.stringify([{ results: [], success: true, meta: { changes: 0 } }]);
const OK_ROWS = JSON.stringify([
  { results: [{ id: 'a' }, { id: 'b' }], success: true, meta: { rows_read: 2 } },
]);
const FAILED = JSON.stringify([{ results: [], success: false }]);
const LONG_META = 'x'.repeat(80);

// Output captured from wrangler 4.149.0 (`d1 execute --local --json`) in a directory whose
// wrangler.toml holds fields Wrangler does not know. The configuration warning goes to stderr, and
// its text holds JSON-valid fragments (`[0]`). The failure is what the same command prints, with
// exit code 1, for a missing table.
const REAL_STDOUT =
  '[\n  {\n    "results": [],\n    "success": true,\n    "meta": {\n      "duration": 1\n    }\n  }\n]\n';
const REAL_WARNING =
  '\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m \u001b[1mProcessing wrangler.toml configuration:\u001b[0m\n\n' +
  '    - Unexpected fields found in kv_namespaces[0] field: "bogus"\n' +
  '    - Unexpected fields found in d1_databases[0] field: "extra"\n\n';
const REAL_FAILURE_STDOUT =
  '{\n  "error": {\n    "text": "no such table: nope: SQLITE_ERROR"\n  }\n}\n';

const warning = (text: string): string =>
  `▲ [WARNING] Processing wrangler.toml configuration:\n\n    - ${text}\n\n`;
const WARN_D1 = warning('Unexpected fields found in d1_databases[0] field: "extra"');
const WARN_KV = warning('Unexpected fields found in kv_namespaces[1] field: "bogus"');
const WARN_R2 = warning('Unexpected fields found in r2_buckets[0] field: "x"');
const WARN_MULTI =
  '▲ [WARNING] Processing wrangler.toml configuration:\n\n' +
  '    - Unexpected fields found in d1_databases[0] field: "extra"\n' +
  '    - Unexpected fields found in kv_namespaces[1] field: "bogus"\n' +
  '    - Unexpected fields found in r2_buckets[0] field: "x"\n' +
  '    - "queues" should be ["a", "b"] but got [1, 2] and {}\n\n';

type Case = readonly [name: string, stdout: string, stderr: string, expected: unknown[] | 'error'];

const CASES: readonly Case[] = [
  // Output that proves the query ran.
  ['a successful empty result', OK_EMPTY, '', []],
  ['a successful result with rows', OK_ROWS, '', [{ id: 'a' }, { id: 'b' }]],
  ['a successful empty result among noise', `banner\n${OK_EMPTY}\nfooter`, '', []],
  [
    'a successful result after an ANSI-coloured banner',
    `\u001b[33mbanner\u001b[0m\n${OK_ROWS}`,
    '',
    [{ id: 'a' }, { id: 'b' }],
  ],
  ['a successful result on stderr only', '', OK_EMPTY, []],
  ['a successful result with bracketed notices', `[wrangler:notice] hello\n${OK_EMPTY}`, '', []],
  [
    'a successful result whose meta holds empty lists',
    JSON.stringify([{ results: [], success: true, meta: { served_by: [], changes: [] } }]),
    '',
    [],
  ],
  // Diagnostics around the result are not results.
  ['the real success with the real configuration warning', REAL_STDOUT, REAL_WARNING, []],
  ['a success with a d1_databases warning on stderr', OK_EMPTY, WARN_D1, []],
  [
    'a success with a kv_namespaces warning on stderr',
    OK_ROWS,
    WARN_KV,
    [{ id: 'a' }, { id: 'b' }],
  ],
  ['a success with an r2_buckets warning on stderr', OK_EMPTY, WARN_R2, []],
  ['a success with a multi-line warning on stderr', OK_EMPTY, WARN_MULTI, []],
  ['a success with the warning ahead of it on stdout', `${WARN_D1}${OK_EMPTY}`, '', []],
  ['a success with the warning after it on stdout', `${OK_EMPTY}\n${WARN_MULTI}`, '', []],
  ['a success followed by a lone empty list', `${OK_EMPTY}\n[]`, '', []],
  [
    'a success with bare scalars and empty objects in the noise',
    `${OK_EMPTY}\n[0] [1, 2] ["a"] {}`,
    '',
    [],
  ],
  // Output that does not prove it.
  ['a failed result entry', FAILED, '', 'error'],
  [
    'a failed result entry with an empty list nested in it',
    JSON.stringify([{ results: [], success: false, error: { details: [] } }]),
    '',
    'error',
  ],
  ['a lone empty list', '[]', '', 'error'],
  ['an entry that does not report success', JSON.stringify([{ results: [] }]), '', 'error'],
  [
    'an entry with rows that does not report success',
    JSON.stringify([{ results: [{ id: 'a' }] }]),
    '',
    'error',
  ],
  ['a failure response', JSON.stringify({ success: false, result: [] }), '', 'error'],
  ['an empty result list', JSON.stringify({ success: true, result: [] }), '', 'error'],
  ['empty output', '', '', 'error'],
  ['output that cannot be parsed', 'wrangler: something went wrong', '', 'error'],
  ['a failed result among noise', `banner\n${FAILED}`, '', 'error'],
  ['a failed result on stderr', '', FAILED, 'error'],
  ['a success on stdout and a failure on stderr', OK_EMPTY, FAILED, 'error'],
  ['a failure on stdout and a success on stderr', FAILED, OK_EMPTY, 'error'],
  [
    'a long success followed by a short failure in one stream',
    `${JSON.stringify([{ results: [], success: true, meta: { note: LONG_META } }])}\n${FAILED}`,
    '',
    'error',
  ],
  [
    'a short failure followed by a long success in one stream',
    `${FAILED}\n${JSON.stringify([{ results: [], success: true, meta: { note: LONG_META } }])}`,
    '',
    'error',
  ],
  ['a warning and nothing else', '', WARN_D1, 'error'],
  ['a multi-line warning and nothing else', WARN_MULTI, '', 'error'],
  ['the real warning and the real failure output', REAL_FAILURE_STDOUT, REAL_WARNING, 'error'],
  ['a warning and a failed result', WARN_D1 + FAILED, '', 'error'],
  ['a success, a warning and a failure on stderr', OK_EMPTY, WARN_KV + FAILED, 'error'],
  [
    'a success on stdout and a warning plus failure on stderr',
    OK_EMPTY,
    `${WARN_D1}\n${FAILED}`,
    'error',
  ],
  ['a warning and two successful results', `${WARN_D1}${OK_EMPTY}\n${OK_ROWS}`, '', 'error'],
  [
    'a warning on stderr and two successful results on stdout',
    `${OK_EMPTY}\n${OK_ROWS}`,
    WARN_R2,
    'error',
  ],
  ['a warning and an error object', `${WARN_D1}${REAL_FAILURE_STDOUT}`, '', 'error'],
  ['two successful results in one stream', `${OK_EMPTY}\n${OK_ROWS}`, '', 'error'],
  ['a successful result on each stream', OK_EMPTY, OK_EMPTY, 'error'],
  [
    'one failed entry among successful ones',
    JSON.stringify([
      { results: [], success: true },
      { results: [], success: false },
    ]),
    '',
    'error',
  ],
  [
    'two successful entries in one result list',
    JSON.stringify([
      { results: [], success: true },
      { results: [], success: true },
    ]),
    '',
    'error',
  ],
];

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

describe('D1 query output is read strictly', () => {
  const tempDirs: string[] = [];
  const originalEnv = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    d1Token: process.env.CLOUDFLARE_D1_API_TOKEN,
  };

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeEach(() => {
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_D1_API_TOKEN;
  });

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
    restore('CLOUDFLARE_ACCOUNT_ID', originalEnv.accountId);
    restore('CLOUDFLARE_API_TOKEN', originalEnv.apiToken);
    restore('CLOUDFLARE_D1_API_TOKEN', originalEnv.d1Token);
    vi.unstubAllGlobals();
  });

  describe('queryD1Rows through Wrangler', () => {
    it.each(CASES)('%s', async (_name, stdout, stderr, expected) => {
      execaMock.mockResolvedValue({ exitCode: 0, stdout, stderr });

      const result = queryD1Rows('test-db', 'SELECT 1');
      if (expected === 'error') await expect(result).rejects.toThrow();
      else await expect(result).resolves.toEqual(expected);
    });

    it.each(CASES)('%s (local target)', async (_name, stdout, stderr, expected) => {
      execaMock.mockResolvedValue({ exitCode: 0, stdout, stderr });

      const result = queryD1Rows('test-db', 'SELECT 1', {
        target: {
          configPath: '/nonexistent/wrangler.toml',
          persistTo: '/nonexistent/state',
          cwd: '/nonexistent',
        },
      });
      if (expected === 'error') await expect(result).rejects.toThrow();
      else await expect(result).resolves.toEqual(expected);
    });
  });

  describe('parseD1RowsFromWranglerJson', () => {
    it.each(CASES.filter(([, , stderr]) => stderr === ''))(
      '%s',
      (_name, stdout, _stderr, expected) => {
        if (expected === 'error') expect(() => parseD1RowsFromWranglerJson(stdout)).toThrow();
        else expect(parseD1RowsFromWranglerJson(stdout)).toEqual(expected);
      }
    );
  });

  describe('queryD1Rows through the Cloudflare API fallback', () => {
    const API_CASES: ReadonlyArray<readonly [string, unknown, unknown[] | 'error']> = [
      [
        'a successful empty result',
        { success: true, result: [{ success: true, results: [] }] },
        [],
      ],
      [
        'a successful result with rows',
        { success: true, result: [{ success: true, results: [{ id: 'a' }] }] },
        [{ id: 'a' }],
      ],
      [
        'a failed result entry',
        { success: true, result: [{ success: false, results: [] }] },
        'error',
      ],
      [
        'an entry that does not report success',
        { success: true, result: [{ results: [] }] },
        'error',
      ],
      ['an empty result list', { success: true, result: [] }, 'error'],
      ['a failure envelope', { success: false, result: [{ success: true, results: [] }] }, 'error'],
      ['a failure envelope with an empty result list', { success: false, result: [] }, 'error'],
      ['a lone empty list', [], 'error'],
      [
        'two successful results',
        {
          success: true,
          result: [
            { success: true, results: [] },
            { success: true, results: [] },
          ],
        },
        'error',
      ],
      [
        'a failed entry among successful ones',
        {
          success: true,
          result: [
            { success: true, results: [] },
            { success: false, results: [] },
          ],
        },
        'error',
      ],
    ];

    it.each(API_CASES)('%s', async (_name, queryPayload, expected) => {
      process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
      process.env.CLOUDFLARE_API_TOKEN = 'test-token';
      // Wrangler gives nothing usable, so the API is asked.
      execaMock.mockResolvedValue({ exitCode: 0, stdout: 'no json here', stderr: '' });
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ name: 'test-db', uuid: 'database-id' }],
            result_info: { total_count: 1 },
          }),
        })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => queryPayload });

      const result = queryD1Rows('test-db', 'SELECT 1');
      if (expected === 'error') await expect(result).rejects.toThrow();
      else await expect(result).resolves.toEqual(expected);
    });
  });

  describe('callers that read "no rows" as "nothing is there"', () => {
    function createMigrationFixture(): string {
      const directory = mkdtempSync(join(tmpdir(), 'authrim-d1-output-parser-'));
      tempDirs.push(directory);
      writeFileSync(
        join(directory, '001_existing_schema.sql'),
        'CREATE TABLE existing_schema (id TEXT PRIMARY KEY);'
      );
      return directory;
    }

    function wranglerAnswering(historyStdout: string) {
      return async (_command: string, args: string[]) => {
        if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
          return { exitCode: 0, stdout: historyStdout, stderr: '' };
        }
        // Tracking-table preparation and the migration itself succeed quietly.
        return { exitCode: 0, stdout: '', stderr: '' };
      };
    }

    function ranMigrationFile(): boolean {
      return execaMock.mock.calls.some(([, args]) => (args as string[]).includes('--file'));
    }

    it('applies no migration when the history query failed', async () => {
      execaMock.mockImplementation(wranglerAnswering(FAILED));

      // A failed read taken as an empty history would apply every migration again.
      const result = await runD1Migrations('test-db', createMigrationFixture());

      expect(result.success).toBe(false);
      expect(ranMigrationFile()).toBe(false);
    });

    it('still applies pending migrations when the history query succeeded and was empty', async () => {
      execaMock.mockImplementation(wranglerAnswering(OK_EMPTY));

      const result = await runD1Migrations('test-db', createMigrationFixture());

      expect(result.success).toBe(true);
      expect(ranMigrationFile()).toBe(true);
    });
  });
});

describe('inventory list output is not read out of a failure response', () => {
  // `wrangler d1 list --json` prints a bare array, and an account with none prints `[]`. That is
  // a real answer. An error object that merely holds an empty list somewhere inside it is not.
  const FAILURE_WITH_EMPTY_LIST = JSON.stringify({
    success: false,
    errors: [{ code: 10000, message: 'Authentication error', error_chain: [] }],
    result: null,
  });

  it.each([
    ['d1 databases', parseD1DatabaseListOutput],
    ['KV namespaces', parseKVNamespaceListOutput],
  ] as const)('%s: a failure response holding an empty list is an error', (_name, parse) => {
    expect(() => parse(FAILURE_WITH_EMPTY_LIST)).toThrow();
    expect(() => parse(`banner\n${FAILURE_WITH_EMPTY_LIST}`)).toThrow();
  });

  it.each([
    ['d1 databases', parseD1DatabaseListOutput],
    ['KV namespaces', parseKVNamespaceListOutput],
  ] as const)('%s: an empty list is still an empty inventory', (_name, parse) => {
    expect(parse('[]')).toEqual([]);
    expect(parse('[wrangler:notice] hello\n[]')).toEqual([]);
  });

  it.each([
    ['d1 databases', parseD1DatabaseListOutput],
    ['KV namespaces', parseKVNamespaceListOutput],
  ] as const)('%s: indexes in a configuration warning are not a list', (_name, parse) => {
    expect(() => parse(WARN_MULTI)).toThrow();
    expect(parse(`${WARN_D1}[]`)).toEqual([]);
    expect(parse(`${REAL_WARNING}[]`)).toEqual([]);
  });

  it('reads a list that follows a configuration warning', () => {
    const list = JSON.stringify([{ name: 'db-a', uuid: 'id-a' }]);
    expect(parseD1DatabaseListOutput(`${REAL_WARNING}${list}`)).toEqual([
      { name: 'db-a', uuid: 'id-a' },
    ]);
  });

  it('keeps reading a list from noisy output', () => {
    const list = JSON.stringify([{ name: 'db-a', uuid: 'id-a' }]);
    expect(parseD1DatabaseListOutput(`banner\n${list}\nfooter`)).toEqual([
      { name: 'db-a', uuid: 'id-a' },
    ]);
  });
});

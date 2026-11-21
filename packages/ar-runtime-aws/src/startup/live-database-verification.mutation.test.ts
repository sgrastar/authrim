/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { verifyActivatedDatabaseRows } from './live-database-verification';

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{
    config: unknown;
    queries: Array<{ sql: string; params?: unknown[] }>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }>,
  verifyStaging: vi.fn(),
  readRows: vi.fn(),
  projections: vi.fn(),
  responder: { current: undefined as undefined | ((sql: string, params?: unknown[]) => unknown) },
}));
vi.mock('pg', () => ({
  Client: class {
    queries: Array<{ sql: string; params?: unknown[] }> = [];
    connect = vi.fn(async () => undefined);
    end = vi.fn(async () => undefined);
    query = vi.fn(async (sql: string, params?: unknown[]) => {
      this.queries.push({ sql, params });
      return mocks.responder.current!(sql, params);
    });
    constructor(public config: unknown) {
      mocks.clients.push(this);
    }
  },
}));
vi.mock('../import/postgres-restore', () => ({
  verifyPostgresFamilyStagingRows: mocks.verifyStaging,
}));
vi.mock('../import/verified-rows', () => ({ readVerifiedRows: mocks.readRows }));
vi.mock('./live-login-projections', () => ({ verifyActivatedLoginProjections: mocks.projections }));

const TENANT = 'tenant-a';
const ACTIVATED = 5_000;
const spec = (id: string) => POSTGRES_RESTORE_TABLE_CONTRACTS.find((s) => s.datasetId === id)!;
const ACCOUNT = spec('core.identity_accounts');
const PASSKEY = spec('core.passkeys');

type Values = Record<string, string | null>;
type Tagged = Record<string, unknown>;
const accountDefaults = (id: string): Values => ({
  id,
  tenant_id: TENANT,
  metadata_json: '{"k":1}',
  created_at: '100',
  updated_at: '1000',
  deleted_at: null,
  account_route_generation: '1',
  legacy_user_id: `legacy-${id}`,
});
const passkeyDefaults = (id: string): Values => ({
  id,
  tenant_id: TENANT,
  user_id: `user-${id}`,
  counter: '5',
  last_used_at: '4000',
  created_at: '100',
});
function values(s: typeof ACCOUNT, defaults: Values, over: Values = {}): Values {
  const out: Values = {};
  for (const c of s.columns) {
    const base =
      c in defaults ? defaults[c] : s.sqliteIntegerColumns.includes(c) ? '1' : `${c}-value`;
    out[c] = c in over ? over[c] : base;
  }
  return out;
}
function tagged(s: typeof ACCOUNT, v: Values): Tagged {
  const row: Tagged = {};
  for (const c of s.columns)
    row[c] =
      v[c] === null
        ? ['null', null]
        : [s.sqliteIntegerColumns.includes(c) ? 'integer' : 'text', v[c]];
  return row;
}
function live(s: typeof ACCOUNT, v: Values, numbers = true): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of s.columns)
    row[c] =
      v[c] === null ? null : numbers && s.sqliteIntegerColumns.includes(c) ? Number(v[c]) : v[c];
  return row;
}

interface World {
  accounts: Values[];
  passkeys: Values[];
  liveAccounts: Array<Record<string, unknown>>;
  livePasskeys: Array<Record<string, unknown>>;
  sourceAccounts?: unknown[];
  sourcePasskeys?: unknown[];
  counters: Array<{ user_id: string; credential_id: string; counter: string }>;
  accountCount?: string;
  passkeyCount?: string;
  stateQuery: ReturnType<typeof vi.fn>;
  readPasskeyCounters?: () => Promise<
    Array<{ user_id: string; credential_id: string; counter: string }>
  >;
  activatedAtMs: number;
  rollbackFails?: boolean;
}
function baseWorld(): World {
  const accounts = [
    values(ACCOUNT, accountDefaults('acct-1')),
    values(ACCOUNT, accountDefaults('acct-2')),
  ];
  const passkeys = [
    values(PASSKEY, passkeyDefaults('pk-1')),
    values(PASSKEY, passkeyDefaults('pk-2')),
  ];
  return {
    accounts,
    passkeys,
    liveAccounts: accounts.map((v) => live(ACCOUNT, v)),
    livePasskeys: passkeys.map((v) => live(PASSKEY, v)),
    counters: passkeys.map((v) => ({
      user_id: v.user_id!,
      credential_id: v.id!,
      counter: v.counter!,
    })),
    stateQuery: vi.fn(),
    activatedAtMs: ACTIVATED,
  };
}
const backup = {
  manifest: { source: { tenantId: TENANT }, datasets: [{ id: 'core.identity_accounts' }] },
};
async function run(w: World, over: Record<string, unknown> = {}) {
  mocks.clients.length = 0;
  mocks.readRows.mockImplementation(async (_b: unknown, id: string) =>
    id === 'core.identity_accounts'
      ? (w.sourceAccounts ?? w.accounts.map((v) => tagged(ACCOUNT, v)))
      : (w.sourcePasskeys ?? w.passkeys.map((v) => tagged(PASSKEY, v)))
  );
  mocks.responder.current = (sql) => {
    if (sql === 'ROLLBACK' && w.rollbackFails) throw new Error('rollback failed');
    if (sql.startsWith('SELECT count(*)'))
      return {
        rows: [
          {
            count: sql.includes('"identity_accounts"')
              ? (w.accountCount ?? String(w.accounts.length))
              : (w.passkeyCount ?? String(w.passkeys.length)),
          },
        ],
      };
    if (sql.includes('FROM "identity_accounts"')) return { rows: w.liveAccounts };
    if (sql.includes('FROM "passkeys"')) return { rows: w.livePasskeys };
    return { rows: [] };
  };
  w.stateQuery.mockResolvedValue({ rows: w.counters });
  return verifyActivatedDatabaseRows({
    backup: backup as never,
    core: { connectionString: 'postgres://core', targetId: 'core-target' },
    pii: { connectionString: 'postgres://pii', targetId: 'pii-target' },
    stateDb: { query: w.stateQuery } as never,
    readPasskeyCounters: w.readPasskeyCounters,
    activatedAtMs: w.activatedAtMs,
    ...over,
  });
}
const ok = (w: World) => expect(run(w)).resolves.toBeUndefined();
const bad = (w: World) => expect(run(w)).rejects.toThrow(new Error('aws_live_database_invalid'));
const core = () => mocks.clients[0];
const sqls = () => core().queries.map((q) => q.sql);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyStaging.mockResolvedValue(undefined);
  mocks.projections.mockResolvedValue(undefined);
});

describe('live database verification (mutation hardening)', () => {
  it('commits a read-only repeatable-read snapshot when everything matches', async () => {
    const w = baseWorld();
    await ok(w);
    expect(sqls()[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(sqls().at(-1)).toBe('COMMIT');
    expect(sqls()).not.toContain('ROLLBACK');
    expect(core().config).toEqual({
      connectionString: 'postgres://core',
      connectionTimeoutMillis: 5000,
    });
    expect(core().connect).toHaveBeenCalledTimes(1);
    expect(core().end).toHaveBeenCalledTimes(1);
    expect(mocks.verifyStaging).toHaveBeenCalledTimes(2);
    const [coreCall, piiCall] = mocks.verifyStaging.mock.calls.map(([c]) => c);
    expect(coreCall).toMatchObject({
      connectionString: 'postgres://core',
      targetId: 'core-target',
      skipDatasetIds: [
        'core.identity_accounts',
        'core.passkeys',
        'core.service_group_inputs',
        'core.account_webhook_outbox',
      ],
    });
    expect(piiCall).toMatchObject({ connectionString: 'postgres://pii', targetId: 'pii-target' });
    expect(piiCall).not.toHaveProperty('skipDatasetIds');
    // the staging clients use the same bounded connection settings
    const factoryClient = coreCall.clientFactory('postgres://x');
    expect(factoryClient.config).toEqual({
      connectionString: 'postgres://x',
      connectionTimeoutMillis: 5000,
    });
    expect(piiCall.clientFactory('postgres://y').config).toEqual({
      connectionString: 'postgres://y',
      connectionTimeoutMillis: 5000,
    });
    // login projections run against the same snapshot with the live accounts
    const projection = mocks.projections.mock.calls[0][0];
    expect(projection.backup).toBe(backup);
    expect(projection.core).toBe(core());
    expect(projection.activatedAtMs).toBe(ACTIVATED);
    expect([...projection.accounts.keys()].sort()).toEqual(['acct-1', 'acct-2']);
    // table counts and tenant-scoped reads
    const reads = core().queries.filter((q) => q.sql.includes('WHERE tenant_id=$1'));
    expect(reads.map((q) => q.params)).toEqual([
      [TENANT, 3],
      [TENANT, 3],
    ]);
    expect(reads[0].sql).toContain('FROM "identity_accounts"');
    expect(reads[1].sql).toContain('FROM "passkeys"');
    expect(core().queries.filter((q) => q.sql.startsWith('SELECT count(*)'))).toHaveLength(2);
  });

  it('reads counters from the state database unless an authority reader is supplied', async () => {
    const w = baseWorld();
    await ok(w);
    expect(w.stateQuery).toHaveBeenCalledTimes(1);
    expect(w.stateQuery.mock.calls[0][0]).toContain('FROM authrim_aws_passkey_counters');
    expect(w.stateQuery.mock.calls[0][0]).toContain('WHERE tenant_id=$1');
    expect(w.stateQuery.mock.calls[0][1]).toEqual([TENANT]);
    const w2 = baseWorld();
    const reader = vi.fn(async () => w2.counters);
    w2.readPasskeyCounters = reader;
    await ok(w2);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(w2.stateQuery).not.toHaveBeenCalled();
    // the reader runs after the Core snapshot began and its rows are the ones verified
    const w3 = baseWorld();
    w3.readPasskeyCounters = async () => w3.counters.map((c) => ({ ...c, user_id: 'other' }));
    await bad(w3);
  });

  it('refuses an invalid activation time before any database work', async () => {
    for (const activatedAtMs of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const w = baseWorld();
      w.activatedAtMs = activatedAtMs;
      await bad(w);
      expect(mocks.verifyStaging).not.toHaveBeenCalled();
      expect(mocks.clients).toHaveLength(0);
    }
    const w = baseWorld();
    w.activatedAtMs = 1;
    await ok(w);
  });

  it('rolls back, closes the client and reports a fixed error for any failed verification', async () => {
    const w = baseWorld();
    w.liveAccounts[0].display_label = 'changed';
    await bad(w);
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(core().end).toHaveBeenCalledTimes(1);
    const w2 = baseWorld();
    w2.liveAccounts[0].display_label = 'changed';
    w2.rollbackFails = true;
    await bad(w2);
    expect(core().end).toHaveBeenCalledTimes(1);
    mocks.verifyStaging.mockRejectedValueOnce(new Error('private'));
    await bad(baseWorld());
    mocks.projections.mockRejectedValueOnce(new Error('private'));
    await bad(baseWorld());
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
  });

  describe('source rows', () => {
    it('require the exact column set, the tenant and unique non-empty ids', async () => {
      const cases: Array<(w: World) => void> = [
        (w) =>
          (w.sourceAccounts = [
            { ...(tagged(ACCOUNT, w.accounts[0]) as object), extra: ['text', 'x'] },
            tagged(ACCOUNT, w.accounts[1]),
          ]),
        (w) => {
          const row = tagged(ACCOUNT, w.accounts[0]) as Record<string, unknown>;
          delete row.display_label;
          w.sourceAccounts = [{ ...row, other: ['text', 'x'] }, tagged(ACCOUNT, w.accounts[1])];
        },
        (w) => (w.accounts[0].tenant_id = 'other'),
        (w) => (w.accounts[1].id = w.accounts[0].id),
        (w) => (w.accounts[0].id = ''),
        (w) => (w.accounts[0].id = null),
        (w) => (w.passkeys[1].id = w.passkeys[0].id),
      ];
      for (const mutate of cases) {
        const w = baseWorld();
        mutate(w);
        if (!w.sourceAccounts) w.sourceAccounts = w.accounts.map((v) => tagged(ACCOUNT, v));
        await bad(w);
      }
    });

    it('require every value to be a tagged text or integer string, or a tagged null', async () => {
      const tweak = (column: string, value: unknown, table: 'account' | 'passkey' = 'passkey') => {
        const w = baseWorld();
        if (table === 'passkey') {
          const rows = w.passkeys.map((v) => tagged(PASSKEY, v)) as Array<Record<string, unknown>>;
          rows[0][column] = value;
          w.sourcePasskeys = rows;
        } else {
          const rows = w.accounts.map((v) => tagged(ACCOUNT, v)) as Array<Record<string, unknown>>;
          rows[0][column] = value;
          w.sourceAccounts = rows;
        }
        return w;
      };
      // last_used_at and counter are mutable columns: only the value-shape check protects them
      for (const value of [
        ['blob', '4000'],
        ['text', 4000],
        ['integer', 4000],
        ['null', 'x'],
        null,
        'x',
        undefined,
        ['text'],
      ])
        await bad(tweak('last_used_at', value));
      for (const value of [
        ['blob', '5'],
        ['integer', 5],
        ['null', '0'],
      ])
        await bad(tweak('counter', value));
      for (const value of [
        ['blob', '{"k":1}'],
        ['integer', {}],
      ])
        await bad(tweak('metadata_json', value, 'account'));
      await ok(tweak('last_used_at', ['integer', '4000']));
      await ok(tweak('last_used_at', ['text', '4000']));
    });
  });

  describe('live rows', () => {
    it('must have the same number of rows as the source in the whole table and for the tenant', async () => {
      let w = baseWorld();
      w.accountCount = '3';
      await bad(w);
      w = baseWorld();
      w.passkeyCount = '3';
      await bad(w);
      w = baseWorld();
      w.accountCount = '1';
      await bad(w);
      w = baseWorld();
      w.passkeyCount = 'x';
      await bad(w);
      w = baseWorld();
      w.livePasskeys.pop();
      await bad(w);
      w = baseWorld();
      w.liveAccounts.push({ ...w.liveAccounts[0], id: 'acct-3' });
      await bad(w);
      w = baseWorld();
      w.livePasskeys[1] = { ...w.livePasskeys[1], id: 'pk-zzz' };
      await bad(w);
      w = baseWorld();
      w.liveAccounts[1] = { ...w.liveAccounts[0] };
      await bad(w);
    });

    it('accept strings or numbers but nothing else', async () => {
      let w = baseWorld();
      w.livePasskeys = w.passkeys.map((v) => live(PASSKEY, v, false));
      w.liveAccounts = w.accounts.map((v) => live(ACCOUNT, v, false));
      await ok(w);
      for (const patch of [
        { display_label: true },
        { display_label: { a: 1 } },
        { display_label: ['x'] },
        { display_label: undefined },
      ]) {
        w = baseWorld();
        w.sourceAccounts = w.accounts.map((v) => tagged(ACCOUNT, v));
        w.liveAccounts[0] = { ...w.liveAccounts[0], ...patch };
        await bad(w);
      }
      // a boolean must not be coerced into a matching string
      w = baseWorld();
      w.accounts[0].display_label = 'true';
      w.liveAccounts[0] = { ...live(ACCOUNT, w.accounts[0]), display_label: true };
      await bad(w);
    });

    it('require every immutable column to match', async () => {
      for (const column of ACCOUNT.columns.filter(
        (c) => !['metadata_json', 'updated_at'].includes(c)
      )) {
        const w = baseWorld();
        w.liveAccounts[1] = { ...w.liveAccounts[1], [column]: 'tampered' };
        await bad(w);
      }
      for (const column of PASSKEY.columns.filter(
        (c) => !['counter', 'last_used_at'].includes(c)
      )) {
        const w = baseWorld();
        w.livePasskeys[1] = { ...w.livePasskeys[1], [column]: 'tampered' };
        await bad(w);
      }
      const w = baseWorld();
      w.liveAccounts[0] = { ...w.liveAccounts[0], deleted_at: 7 };
      await bad(w);
    });
  });

  describe('account metadata', () => {
    const change = (
      w: World,
      before: string,
      after: string,
      updatedAfter: string | null = '6000',
      updatedBefore = '1000'
    ) => {
      w.accounts[0].metadata_json = before;
      w.accounts[0].updated_at = updatedBefore;
      w.liveAccounts[0] = {
        ...live(ACCOUNT, w.accounts[0]),
        metadata_json: after,
        updated_at: updatedAfter,
      };
      return w;
    };
    const login = (n: unknown) => JSON.stringify({ k: 1, last_login_at: n });

    it('allows only a forward last_login_at update with a newer updated_at', async () => {
      await ok(change(baseWorld(), '{"k":1}', login(6000)));
      await ok(change(baseWorld(), login(5500), login(6000)));
      await ok(change(baseWorld(), login(6000), login(6000), '6000'));
      // boundaries: login time == activation, previous login == new login
      await ok(change(baseWorld(), '{"k":1}', login(ACTIVATED), '5000'));
      await ok(change(baseWorld(), login(5200), login(5200), '5200', '1000'));
      // updated_at: equal to the max(original, activation) is accepted
      await ok(change(baseWorld(), '{"k":1}', login(6000), '5000'));
      await ok(change(baseWorld(), '{"k":1}', login(6000), '7000', '7000'));
      for (const [before, after, updated] of [
        ['{"k":1}', login(ACTIVATED - 1), '6000'],
        ['{"k":1}', login('6000'), '6000'],
        ['{"k":1}', login(6000.5), '6000'],
        ['{"k":1}', login(Number.MAX_SAFE_INTEGER + 1), '6000'],
        ['{"k":1}', login(null), '6000'],
        ['{"k":1}', '{"k":1}', '6000'],
        ['{"k":1}', login(6000), '4999'],
        [login(6500), login(6000), '6000'],
        [login('x'), login(6000), '6000'],
        [login(6000.5), login(6001), '6000'],
        [login(Number.MAX_SAFE_INTEGER + 1), login(6000), '6000'],
        ['{"k":1}', JSON.stringify({ k: 2, last_login_at: 6000 }), '6000'],
        ['{"k":1}', JSON.stringify({ last_login_at: 6000 }), '6000'],
        ['{"k":1}', JSON.stringify({ k: 1, extra: 1, last_login_at: 6000 }), '6000'],
      ] as const)
        await bad(change(baseWorld(), before, after, updated));
    });

    it('does not let an unchanged document hide an updated_at change', async () => {
      await bad(change(baseWorld(), '{"k":1}', '{"k":1}', '6000'));
      await ok(change(baseWorld(), '{"k":1}', '{"k":1}', '1000'));
    });

    it('rejects an update that precedes the original updated_at', async () => {
      await bad(change(baseWorld(), '{"k":1}', login(9000), '8000', '8500'));
      await ok(change(baseWorld(), '{"k":1}', login(9000), '8500', '8500'));
    });

    it('validates the updated_at representation', async () => {
      for (const updated of [
        '01',
        '1e3',
        '-5',
        '5.5',
        '',
        ' 6000',
        '6000 ',
        'x',
        '9007199254740993',
      ])
        await bad(change(baseWorld(), '{"k":1}', login(6000), updated));
      await bad(change(baseWorld(), '{"k":1}', login(6000), null));
      // zero is a valid original timestamp
      await ok(change(baseWorld(), '{"k":1}', login(6000), '6000', '0'));
    });

    it('rejects metadata that is not a JSON object', async () => {
      for (const doc of ['null', '5', '"str"', '[]', '[1]', '{bad', 'true', '']) {
        await bad(change(baseWorld(), '{"k":1}', doc));
        await bad(change(baseWorld(), doc, login(6000)));
      }
      const w = baseWorld();
      w.accounts[0].metadata_json = null;
      w.liveAccounts[0] = {
        ...live(ACCOUNT, w.accounts[0]),
        metadata_json: JSON.stringify({ last_login_at: 6000 }),
        updated_at: 6000,
      };
      await ok(w);
    });
  });

  describe('passkeys and counters', () => {
    const advance = (
      w: World,
      patch: {
        counter?: string;
        last_used_at?: string | null;
        stateCounter?: string;
        oldUsed?: string | null;
        user?: string;
        stateKey?: string;
      }
    ) => {
      if ('oldUsed' in patch) w.passkeys[0].last_used_at = patch.oldUsed!;
      const base = { ...w.passkeys[0] };
      w.sourcePasskeys = w.passkeys.map((v) => tagged(PASSKEY, v));
      w.livePasskeys[0] = {
        ...live(PASSKEY, base),
        counter: patch.counter ?? '5',
        last_used_at: 'last_used_at' in patch ? patch.last_used_at : base.last_used_at,
      };
      w.counters[0] = {
        user_id: patch.user ?? base.user_id!,
        credential_id: patch.stateKey ?? base.id!,
        counter: patch.stateCounter ?? patch.counter ?? '5',
      };
      return w;
    };

    it('accepts an unchanged counter or a verified forward advance', async () => {
      await ok(advance(baseWorld(), {}));
      await ok(advance(baseWorld(), { counter: '6', last_used_at: '6000' }));
      await ok(advance(baseWorld(), { counter: '6', last_used_at: '5000' }));
      await ok(advance(baseWorld(), { counter: '6', stateCounter: '9', last_used_at: '6000' }));
      await ok(advance(baseWorld(), { counter: '5', last_used_at: '6000' }));
      await ok(
        advance(baseWorld(), {
          counter: '9223372036854775807',
          last_used_at: '6000',
          stateCounter: '9223372036854775807',
        })
      );
      await ok(advance(baseWorld(), { counter: '6', last_used_at: '6000', oldUsed: null }));
      await ok(advance(baseWorld(), { counter: '6', last_used_at: '9000', oldUsed: '8000' }));
      await ok(advance(baseWorld(), { counter: '6', last_used_at: '8000', oldUsed: '8000' }));
    });

    it('rejects counter rollback, counters ahead of the authority, and unbound state rows', async () => {
      for (const patch of [
        { counter: '4', last_used_at: '6000' },
        { counter: '7', stateCounter: '6', last_used_at: '6000' },
        { counter: '6', user: 'someone-else', last_used_at: '6000' },
        { counter: '6', stateKey: 'unrelated-id', last_used_at: '6000' },
      ])
        await bad(advance(baseWorld(), patch));
    });

    it('requires a plausible last_used_at whenever the counter or the timestamp changed', async () => {
      for (const patch of [
        { counter: '6', last_used_at: null },
        { counter: '6', last_used_at: '4999' },
        { counter: '6', last_used_at: '9007199254740993' },
        { counter: '6', last_used_at: '01' },
        { counter: '5', last_used_at: '4500' },
        { counter: '5', last_used_at: null },
        { counter: '6', last_used_at: '7000', oldUsed: '7500' },
        { counter: '6', last_used_at: '5000', oldUsed: '7500' },
      ])
        await bad(advance(baseWorld(), patch));
      // an unchanged null timestamp with an unchanged counter is fine
      await ok(advance(baseWorld(), { counter: '5', last_used_at: null, oldUsed: null }));
    });

    it('rejects malformed counter values', async () => {
      for (const counter of ['01', '-1', '', 'x', '1.5', '9223372036854775808', '+5'])
        await bad(advance(baseWorld(), { counter, stateCounter: '9223372036854775807' }));
      const w = baseWorld();
      w.passkeys[0].counter = '9223372036854775808';
      await bad(
        advance(w, { counter: '9223372036854775808', stateCounter: '9223372036854775807' })
      );
      const w2 = baseWorld();
      w2.passkeys[0].counter = '01';
      await bad(advance(w2, { counter: '1', stateCounter: '1', last_used_at: '6000' }));
      const w3 = baseWorld();
      w3.passkeys[0].counter = '5';
      await bad(advance(w3, { counter: '5', stateCounter: '9223372036854775808' }));
    });

    it('requires one authority row per passkey', async () => {
      let w = baseWorld();
      w.counters.push({ user_id: 'x', credential_id: 'pk-3', counter: '1' });
      await bad(w);
      w = baseWorld();
      w.counters.pop();
      await bad(w);
      w = baseWorld();
      w.counters[1] = { ...w.counters[0] };
      await bad(w);
    });
  });
});

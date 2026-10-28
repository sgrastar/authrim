import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from './test-sqlite';
import {
  executeLogQuery,
  LogQueryEngineError,
  type LogQueryRow,
  type LogQueryTable,
  type LogQueryValue,
} from '../log-iceberg-query-engine';

const schema = [
  'id',
  'tenant_id',
  'client_id',
  'result',
  'action',
  'details_json',
  'created_at',
  'allowed',
];
const rows: LogQueryRow[] = [
  {
    id: 'd',
    tenant_id: 't',
    client_id: 'c1',
    result: 'success',
    action: 'auth.success',
    details_json: '{"grant_type":"code","country":"JP","yes":true,"missing":null}',
    created_at: 1704067200000,
    allowed: 1,
  },
  {
    id: 'c',
    tenant_id: 't',
    client_id: 'c1',
    result: 'failure',
    action: 'auth.password.failed',
    details_json: '{"grantType":"code","country":"US"}',
    created_at: 1704067200000,
    allowed: 0,
  },
  {
    id: 'b',
    tenant_id: 't',
    client_id: null,
    result: 'failure',
    action: 'auth.mfa.failed',
    details_json: null,
    created_at: 1704153600123,
    allowed: 0,
  },
  {
    id: 'a',
    tenant_id: 't',
    client_id: 'c2',
    result: 'success',
    action: 'token.issued',
    details_json: '{"grant_type":"client_credentials","country":"JP"}',
    created_at: 1704240000999,
    allowed: 1,
  },
];
const table: LogQueryTable = { columns: schema, rows };

/** A real SQLite oracle exercises the application's fixed dialect without a network or database binding. */
async function agreesWithSqlite(
  sql: string,
  params: readonly LogQueryValue[] = [],
  tables: Record<string, LogQueryTable> = { event_log: table }
) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [name, source] of Object.entries(tables)) {
      db.exec(`CREATE TABLE ${name} (${source.columns.join(',')})`);
      const insert = db.prepare(
        `INSERT INTO ${name} VALUES (${source.columns.map(() => '?').join(',')})`
      );
      for (const row of source.rows)
        insert.run(
          ...source.columns.map((c) => {
            const value = row[c];
            return typeof value === 'boolean' ? Number(value) : value;
          })
        );
    }
    const expected = db
      .prepare(sql)
      .all(...(params.map((p) => (typeof p === 'boolean' ? Number(p) : p)) as SQLInputValue[]));
    const actual = await executeLogQuery({ sql, params, tables });
    expect(actual).toEqual(expected);
    return actual;
  } finally {
    db.close();
  }
}

describe('Worker-local fixed log query engine', () => {
  it('matches authentication grant/MFA aggregates, JSON aliases, CASE, null and DISTINCT', async () => {
    const result = await agreesWithSqlite(
      `
      WITH scoped AS (SELECT * FROM event_log WHERE tenant_id = ? AND created_at >= ?)
      SELECT COALESCE(json_extract(details_json,'$.grant_type'),json_extract(details_json,'$.grantType'),'unknown') AS grant_type,
        COUNT(*) AS total, COUNT(DISTINCT client_id) AS clients,
        SUM(CASE WHEN result='success' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN result='failure' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN action LIKE 'auth.mfa%' OR COALESCE(details_json,'') LIKE '%mfa%' THEN 1 ELSE 0 END) AS mfa
      FROM scoped GROUP BY grant_type ORDER BY total DESC, grant_type ASC`,
      ['t', 1704067200000]
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      grant_type: 'code',
      total: 2,
      clients: 1,
      successful: 1,
      failed: 1,
    });
  });

  it('matches filtered country/IP and administrator grouping, HAVING and fixed limits', async () => {
    await agreesWithSqlite(
      `SELECT COALESCE(json_extract(details_json,'$.country'),'unknown') AS country,
      COUNT(*) AS count FROM event_log WHERE tenant_id=? AND result IN ('failure','success')
      GROUP BY country HAVING COUNT(*) >= ? ORDER BY count DESC, country LIMIT ? OFFSET ?`,
      ['t', 1, 2, 1]
    );
    await agreesWithSqlite(
      `SELECT client_id,result,COUNT(*) AS count FROM event_log
      WHERE tenant_id=? AND client_id IS NOT NULL GROUP BY client_id,result ORDER BY count DESC,client_id,result`,
      ['t']
    );
  });

  it('matches compound key cursors when timestamps tie', async () => {
    const result = await agreesWithSqlite(
      `SELECT id,created_at FROM event_log WHERE tenant_id=?
      AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC,id DESC LIMIT ?`,
      ['t', 1704067200000, 1704067200000, 'd', 2]
    );
    expect(result).toEqual([{ id: 'c', created_at: 1704067200000 }]);
  });

  it('matches typed binding without interpolating strings into SQL, including LIMIT/OFFSET', async () => {
    const value = "t' OR 1=1 -- ?";
    const source = {
      columns: ['id', 'tenant_id'],
      rows: [
        { id: 'one', tenant_id: value },
        { id: 'two', tenant_id: 'other' },
      ],
    };
    await agreesWithSqlite(
      `SELECT id, '?' AS question FROM event_log /* ? */
      WHERE tenant_id = ? -- ?
      ORDER BY id LIMIT ? OFFSET ?`,
      [value, 1, 0],
      { event_log: source }
    );
    await agreesWithSqlite(`SELECT ? AS value,? AS flag,? AS missing`, [
      "' ); DROP TABLE event_log; --",
      true,
      null,
    ]);
  });

  it('matches JSON scalars, null vs absent, arrays/objects and lazy validity guards', async () => {
    await agreesWithSqlite(`SELECT id,json_extract(details_json,'$.yes') AS yes,
      json_type(details_json,'$.missing') AS null_type,json_type(details_json,'$.absent') AS missing_type,
      json_valid(details_json) AS valid FROM event_log ORDER BY id`);
    await agreesWithSqlite(
      `SELECT json_extract(?,'$.items[1]') AS item,
      json_extract(?,'$.obj') AS object,json_type(?,'$.items') AS type`,
      ['{"items":[false,true]}', '{"obj":{"safe":1}}', '{"items":[]}']
    );
    await agreesWithSqlite(
      `SELECT CASE WHEN json_valid(?) THEN json_extract(?,'$.v') ELSE 'invalid' END AS value`,
      ['{broken', '{broken']
    );
    await agreesWithSqlite(`SELECT json_extract(?,'$.toString') AS inherited`, ['{}']);
    await agreesWithSqlite(
      `SELECT json_extract(?,'$.length') AS array_property,
      json_extract(?,'$[0]') AS object_index`,
      ['[1,2]', '{"0":"object"}']
    );
  });

  it('matches SQLite ASCII LIKE without Unicode case folding or regexp interpretation', async () => {
    const cases = [
      ['Auth.MFA.failed', 'auth.%failed%'],
      ['Ä', 'ä'],
      ['a.b', 'a.b'],
      ['axb', 'a.b'],
      ['a\nb', 'a_b'],
      ['😀', '_'],
      ['anything', null],
      [null, '%'],
    ];
    for (const [value, pattern] of cases) {
      await agreesWithSqlite('SELECT ? LIKE ? AS matched,NOT (? LIKE ?) AS inverted', [
        value,
        pattern,
        value,
        pattern,
      ]);
    }
  });

  it('matches UTC seconds/milliseconds day/hour/week boundaries, including week 00', async () => {
    for (const format of ['%Y-%m-%d', '%Y-%m-%d %H:00:00', '%Y-%W']) {
      await agreesWithSqlite(`SELECT strftime('${format}',datetime(created_at / 1000.0,'unixepoch')) AS bucket,
        COUNT(*) AS count FROM event_log GROUP BY bucket ORDER BY bucket`);
      for (const time of ['2021-01-01T00:00:00Z', '2021-01-04T00:00:00Z', '2024-12-31T23:59:59Z']) {
        await agreesWithSqlite(`SELECT strftime('${format}',datetime(?,'unixepoch')) AS bucket`, [
          Date.parse(time) / 1000,
        ]);
      }
    }
    await agreesWithSqlite(
      `SELECT FLOOR(created_at / ?) * ? AS bucket,COUNT(*) AS count,
      SUM(CASE WHEN allowed=1 THEN 1 ELSE 0 END) AS allowed FROM event_log
      GROUP BY bucket ORDER BY bucket`,
      [86_400_000, 86_400_000]
    );
  });

  it('uses an explicitly frozen now without mutable request state', async () => {
    const results = await Promise.all(
      [0, 1704067200000].map((now) =>
        executeLogQuery({
          sql: "SELECT strftime('%Y-%m-%d',datetime('now')) AS day",
          tables: {},
          now,
        })
      )
    );
    expect(results).toEqual([[{ day: '1970-01-01' }], [{ day: '2024-01-01' }]]);
  });

  it('handles empty authorized tables with an explicit schema and correct aggregate nulls', async () => {
    const empty = { event_log: { columns: schema, rows: [] } };
    const aggregate = await agreesWithSqlite(
      'SELECT COUNT(*) AS n,SUM(allowed) AS sum,COUNT(DISTINCT client_id) AS distinct_count FROM event_log',
      [],
      empty
    );
    expect(aggregate).toEqual([{ n: 0, sum: null, distinct_count: 0 }]);
    await agreesWithSqlite('SELECT id FROM event_log WHERE tenant_id=? LIMIT ?', ['t', 5], empty);
  });

  it('supports bounded CTE joins and LEFT JOIN nulls against provided scoped metadata', async () => {
    const sources: Record<string, LogQueryTable> = {
      event_log: table,
      clients: { columns: ['id', 'name'], rows: [{ id: 'c1', name: 'one' }] },
    };
    await agreesWithSqlite(
      `WITH failures AS (SELECT client_id,COUNT(*) AS n FROM event_log
      WHERE result='failure' GROUP BY client_id)
      SELECT c.id,f.n FROM clients c JOIN failures f ON f.client_id=c.id ORDER BY c.id`,
      [],
      sources
    );
    await agreesWithSqlite(
      `SELECT e.id,c.name FROM event_log e LEFT JOIN clients c ON c.id=e.client_id ORDER BY e.id`,
      [],
      sources
    );
  });

  it('supports compound SELECT and preserves null three-valued logic', async () => {
    await agreesWithSqlite(
      `SELECT id FROM event_log WHERE NOT (client_id=?)
      UNION SELECT id FROM event_log WHERE client_id IS NULL ORDER BY id`,
      ['c1']
    );
    await agreesWithSqlite(
      `SELECT NULL = ? AS comparison, NOT(NULL = ?) AS negated,
      NULL AND 0 AS false_and,NULL OR 1 AS true_or`,
      [null, 1]
    );
  });

  it('rejects an empty outer-join side whose schema the upstream executor cannot preserve', async () => {
    await expect(
      executeLogQuery({
        sql: 'SELECT e.id,c.id AS client_id FROM event_log e LEFT JOIN clients c ON c.id=e.client_id',
        tables: { event_log: table, clients: { columns: ['id'], rows: [] } },
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('keeps concurrent bound values and sources isolated and snapshots input before awaiting', async () => {
    const mutable = { columns: ['id'], rows: [{ id: 'first' }] };
    const pending = executeLogQuery({
      sql: 'SELECT id,? AS bound FROM log',
      params: ['one'],
      tables: { log: mutable },
    });
    mutable.rows[0].id = 'changed';
    const other = executeLogQuery({
      sql: 'SELECT id,? AS bound FROM log',
      params: ['two'],
      tables: { log: mutable },
    });
    expect(await pending).toEqual([{ id: 'first', bound: 'one' }]);
    expect(await other).toEqual([{ id: 'changed', bound: 'two' }]);
  });

  it.each([
    'DELETE FROM event_log',
    'SELECT * FROM unprovided',
    'SHOW TABLES',
    'SELECT RANDOM() AS unsafe',
    'SELECT REGEXP_LIKE(id,?) FROM event_log',
    'SELECT ROW_NUMBER() OVER (ORDER BY id) FROM event_log',
    "SELECT * FROM JSON_EACH('[1,2]')",
    'SELECT (SELECT id FROM event_log LIMIT 1)',
    'WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r',
    'SELECT AUTHRIM_LIKE(id,?) FROM event_log',
    'SELECT json_extract(details_json,?) FROM event_log',
  ])('rejects unsupported SQL explicitly rather than reporting empty success: %s', async (sql) => {
    const params = sql.includes('json_extract')
      ? ['$..unsupported']
      : sql.includes('?')
        ? ['x']
        : [];
    await expect(
      executeLogQuery({ sql, params, tables: { event_log: table } })
    ).rejects.toBeInstanceOf(LogQueryEngineError);
  });

  it('never interpolates a bound table name or accepts missing/extra/numbered parameters', async () => {
    for (const [sql, params] of [
      ['SELECT * FROM ?', ['event_log']],
      ['SELECT ?', []],
      ['SELECT 1', ['extra']],
      ['SELECT ?1', [1]],
      ['SELECT 1 LIMIT ?', [-1]],
      ['SELECT 1 LIMIT ?', [1.5]],
    ] as const) {
      await expect(
        executeLogQuery({ sql, params, tables: { event_log: table } })
      ).rejects.toBeInstanceOf(LogQueryEngineError);
    }
  });

  it('enforces rows, bytes, groups, intermediate joins, output and work budgets without partial results', async () => {
    const common = { tables: { event_log: table } };
    const attempts = [
      { sql: 'SELECT COUNT(*) AS n FROM event_log', limits: { inputRows: 3 } },
      { sql: 'SELECT COUNT(*) AS n FROM event_log', limits: { inputBytes: 10 } },
      { sql: 'SELECT result,COUNT(*) FROM event_log GROUP BY result', limits: { groups: 1 } },
      { sql: 'SELECT * FROM event_log', limits: { outputRows: 3 } },
      { sql: 'SELECT * FROM event_log', limits: { outputBytes: 10 } },
      { sql: 'SELECT id FROM event_log', limits: { scannedRows: 1 } },
      { sql: 'SELECT id FROM event_log', limits: { operations: 4 } },
      {
        sql: 'SELECT a.id FROM event_log a JOIN event_log b ON 1=1',
        limits: { intermediateRows: 10 },
      },
      { sql: 'SELECT id FROM event_log', limits: { intermediateBytes: 10 } },
    ];
    for (const attempt of attempts) {
      await expect(executeLogQuery({ ...common, ...attempt })).rejects.toMatchObject({
        code: 'budget',
      });
    }
    await expect(
      executeLogQuery({ ...common, sql: 'SELECT 1', limits: { inputRows: 10001 } })
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('bounds join payload amplification even when an aggregate would return only one row', async () => {
    await expect(
      executeLogQuery({
        sql: 'SELECT COUNT(DISTINCT l.body) AS n FROM logs l JOIN metadata m ON l.id=m.log_id',
        tables: {
          logs: { columns: ['id', 'body'], rows: [{ id: 'one', body: 's'.repeat(512 * 1024) }] },
          metadata: {
            columns: ['id', 'log_id'],
            rows: Array.from({ length: 40 }, (_, i) => ({ id: String(i), log_id: 'one' })),
          },
        },
      })
    ).rejects.toMatchObject({ code: 'budget' });
    await expect(
      executeLogQuery({
        sql: 'SELECT COUNT(DISTINCT ?) AS n FROM event_log',
        params: ['s'.repeat(100000)],
        tables: { event_log: table },
        limits: { intermediateBytes: 100000 },
      })
    ).rejects.toMatchObject({ code: 'budget' });
  });

  it('rejects numeric JSON precision loss and non-scalar bind values', async () => {
    await expect(
      executeLogQuery({
        sql: "SELECT json_extract(?,'$.v') AS value",
        params: ['{"v":9007199254740993}'],
        tables: {},
      })
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      executeLogQuery({ sql: 'SELECT ?', params: [{} as LogQueryValue], tables: {} })
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('processes the bounded 10,000-row vector source without truncating aggregates', async () => {
    const many = Array.from({ length: 10000 }, (_, i) => ({
      id: String(i),
      result: i % 3 === 0 ? 'failure' : 'success',
      details_json: JSON.stringify({ grant_type: i % 2 === 0 ? 'code' : 'client_credentials' }),
    }));
    const result = await executeLogQuery({
      sql: "SELECT json_extract(details_json,'$.grant_type') AS grant_type,COUNT(*) AS n,SUM(CASE WHEN result='failure' THEN 1 ELSE 0 END) AS failed FROM logs GROUP BY grant_type ORDER BY grant_type",
      tables: { logs: { columns: ['id', 'result', 'details_json'], rows: many } },
    });
    expect(result).toEqual([
      { grant_type: 'client_credentials', n: 5000, failed: 1667 },
      { grant_type: 'code', n: 5000, failed: 1667 },
    ]);
  });

  it('bounds LIKE work and masks malformed JSON and unsupported SQL errors', async () => {
    await expect(
      executeLogQuery({
        sql: 'SELECT ? LIKE ? AS match',
        params: ['a'.repeat(10000), '%a'.repeat(1000) + 'b'],
        tables: {},
        limits: { operations: 1000 },
      })
    ).rejects.toMatchObject({ code: 'budget' });
    const secret = 'private-body-that-must-not-appear';
    const error = await executeLogQuery({
      sql: "SELECT json_extract(?,'$.x') AS x",
      params: [secret],
      tables: {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LogQueryEngineError);
    expect(String(error)).not.toContain(secret);
  });

  it('rejects invalid input types/numbers/schemas and respects cancellation and deadlines', async () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      9007199254740992,
      {},
      ['x'],
      undefined,
    ]) {
      await expect(
        executeLogQuery({
          sql: 'SELECT id FROM log',
          tables: { log: { columns: ['id'], rows: [{ id: bad as LogQueryValue }] } },
        })
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(
      executeLogQuery({
        sql: 'SELECT 1',
        tables: { log: { columns: ['id'], rows: [{ other: 'wrong' }] } },
      })
    ).rejects.toMatchObject({ code: 'invalid' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeLogQuery({ sql: 'SELECT 1', tables: {}, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'budget' });
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(5001);
    try {
      await expect(executeLogQuery({ sql: 'SELECT 1', tables: {} })).rejects.toMatchObject({
        code: 'budget',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('performs no fetch or remote binding calls while evaluating authorized plaintext', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network forbidden');
    });
    try {
      await executeLogQuery({
        sql: "SELECT json_extract(details_json,'$.country') AS country FROM event_log",
        tables: { event_log: table },
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

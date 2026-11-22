/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- mock call inspection */
import { describe, expect, it, vi } from 'vitest';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import {
  assertReplicationAuthorityBootstrapRoles,
  initializeReplicationAuthorityDatabase,
  readReplicationAuthoritySchema,
} from './initialize';

const roles = { serviceRole: 'svc_role', journalRole: 'jrn_role' };

describe('readReplicationAuthoritySchema', () => {
  it('reads the four schema files in order and digests exactly those sources', async () => {
    const { sources, digest } = await readReplicationAuthoritySchema();
    expect(sources.map((s) => s.name)).toEqual([
      'authority-schema.sql',
      'generation-catalog-schema.sql',
      'journal-schema.sql',
      'environment-authority-schema.sql',
    ]);
    for (const s of sources) expect(s.sql.length).toBeGreaterThan(10);
    expect(digest).toBe(restoreEvidenceDigest(sources));
  });
});

describe('assertReplicationAuthorityBootstrapRoles', () => {
  it('accepts a valid pair', () => {
    expect(() => assertReplicationAuthorityBootstrapRoles(roles)).not.toThrow();
    expect(() =>
      assertReplicationAuthorityBootstrapRoles({ serviceRole: 'a', journalRole: 'b' })
    ).not.toThrow();
    expect(() =>
      assertReplicationAuthorityBootstrapRoles({
        serviceRole: 'a' + '1'.repeat(62),
        journalRole: 'b_9',
      })
    ).not.toThrow();
  });
  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['string', 'x'],
    ['number', 5],
    ['array', [roles.serviceRole, roles.journalRole]],
    ['missing key', { serviceRole: 'a' }],
    ['extra key', { ...roles, extra: 'x' }],
    ['wrong keys', { serviceRole: 'a', other: 'b' }],
    ['non-string', { serviceRole: 1, journalRole: 'b' }],
    ['non-string journal', { serviceRole: 'a', journalRole: 2 }],
    ['uppercase', { serviceRole: 'Abc', journalRole: 'b' }],
    ['digit start', { serviceRole: '1abc', journalRole: 'b' }],
    ['underscore start', { serviceRole: '_abc', journalRole: 'b' }],
    ['hyphen', { serviceRole: 'a-b', journalRole: 'b' }],
    ['quote', { serviceRole: 'a"b', journalRole: 'b' }],
    ['too long', { serviceRole: 'a' + '1'.repeat(63), journalRole: 'b' }],
    ['empty', { serviceRole: '', journalRole: 'b' }],
    ['pg_ prefix service', { serviceRole: 'pg_x', journalRole: 'b' }],
    ['pg_ prefix journal', { serviceRole: 'a', journalRole: 'pg_x' }],
    ['journal bad chars', { serviceRole: 'a', journalRole: 'b c' }],
    ['prefix junk', { serviceRole: 'a\nb', journalRole: 'c' }],
    ['identical', { serviceRole: 'same', journalRole: 'same' }],
  ];
  for (const [name, value] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => assertReplicationAuthorityBootstrapRoles(value)).toThrow(
        'replication_bootstrap_roles_invalid'
      );
    });
  }
});

interface Script {
  ssl?: unknown;
  actor?: { rows: unknown[] };
  schemaOwner?: { rows: unknown[] };
  found?: { rows: unknown[] };
  prior?: { rows: unknown[] };
  receipt?: { rows: unknown[] };
  digestRows?: unknown[];
  count?: unknown;
  dbName?: string;
  failOn?: string;
  rollbackFails?: boolean;
}

function makeClient(script: Script = {}) {
  const log: Array<{ sql: string; params?: unknown[] }> = [];
  const digestRows =
    script.digestRows ??
    Array.from({ length: 40 }, (_, i) => ({ kind: 'k', name: `n${i}`, definition: 'd' }));
  const release = vi.fn();
  const client = {
    release,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      if (script.failOn && sql.includes(script.failOn)) throw new Error('fail');
      if (sql === 'ROLLBACK' && script.rollbackFails) throw new Error('rb');
      if (sql.includes('FROM pg_stat_ssl')) return { rows: [{ ssl: script.ssl ?? true }] };
      if (sql.includes('current_user AS username'))
        return script.actor ?? { rows: [{ username: 'owner', owner: 'owner' }] };
      if (sql.includes('pg_get_userbyid(nspowner)'))
        return script.schemaOwner ?? { rows: [{ owner: 'owner' }] };
      if (sql.includes('r.rolname=ANY'))
        return (
          script.found ?? {
            rows: [
              { rolname: roles.serviceRole, safe: true },
              { rolname: roles.journalRole, safe: true },
            ],
          }
        );
      if (sql.includes("to_regclass('public.authrim_replication_schema')"))
        return script.prior ?? { rows: [{ present: false }] };
      if (sql.includes('FROM public.authrim_replication_schema'))
        return script.receipt ?? { rows: [] };
      if (sql.includes('WITH namespaces AS')) return { rows: digestRows };
      if (sql.includes('SELECT current_database() AS name'))
        return { rows: [{ name: script.dbName ?? 'authority_db' }] };
      if (sql.includes('AS count'))
        return { rows: [{ count: 'count' in script ? script.count : '0' }] };
      return { rows: [] };
    }),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { client, pool, log, release, digestRows };
}

async function source() {
  return (await readReplicationAuthoritySchema()).digest;
}
const sqls = (log: Array<{ sql: string }>) => log.map((l) => l.sql);

describe('initializeReplicationAuthorityDatabase', () => {
  it('validates bootstrap roles before connecting', async () => {
    const { pool } = makeClient();
    await expect(
      initializeReplicationAuthorityDatabase(pool as any, await source(), { a: 1 } as any)
    ).rejects.toThrow('replication_bootstrap_roles_invalid');
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('rejects a changed schema source digest before connecting', async () => {
    const { pool } = makeClient();
    await expect(
      initializeReplicationAuthorityDatabase(pool as any, 'f'.repeat(64))
    ).rejects.toThrow('replication_schema_source_changed');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('installs the schema in a transaction with exact statement order', async () => {
    const { pool, log, release, digestRows } = makeClient();
    const digest = await source();
    const { sources } = await readReplicationAuthoritySchema();
    const result = await initializeReplicationAuthorityDatabase(pool as any, digest);
    const expectedSchemaDigest = restoreEvidenceDigest(digestRows);
    expect(result).toEqual({ schemaSha256: expectedSchemaDigest });
    const s = sqls(log);
    expect(s[0]).toBe('BEGIN');
    expect(s[1]).toBe(
      "SELECT pg_advisory_xact_lock(hashtextextended('authrim:replication:schema',0))"
    );
    expect(s[2]).toBe('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    expect(s[3]).toBe('SET LOCAL search_path TO public');
    expect(s[4]).toBe(
      "SELECT to_regclass('public.authrim_replication_schema') IS NOT NULL AS present"
    );
    expect(s[5]).toContain('AS count');
    expect(s[6]).toBe('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    expect(s[7]).toBe(sources.map((x) => x.sql).join('\n'));
    expect(s[8]).toBe(
      'CREATE TABLE authrim_replication_schema (source_sha256 text NOT NULL, schema_sha256 text NOT NULL, bootstrap_json text)'
    );
    expect(s[9]).toContain('WITH namespaces AS');
    expect(s[10]).toBe('INSERT INTO authrim_replication_schema VALUES ($1,$2,$3)');
    expect(log[10].params).toEqual([digest, expectedSchemaDigest, null]);
    expect(s[11]).toBe('COMMIT');
    expect(s).toHaveLength(12);
    expect(release).toHaveBeenCalledWith(true);
    expect(s).not.toContain('ROLLBACK');
  });

  it('uses a bootstrap-aware flow: role checks, grants, and recorded roles', async () => {
    const { pool, log } = makeClient();
    const digest = await source();
    await initializeReplicationAuthorityDatabase(pool as any, digest, { ...roles });
    const s = sqls(log);
    expect(s.some((x) => x.includes('current_user AS username'))).toBe(true);
    const insert = log.find((l) => l.sql.startsWith('INSERT INTO'))!;
    expect(insert.params![2]).toBe(canonicalRestoreJson(roles));
    const grants = s.filter((x) => /^(REVOKE|GRANT)/.test(x) && !x.includes('FROM PUBLIC;'));
    expect(grants).toContain('REVOKE ALL ON DATABASE "authority_db" FROM PUBLIC');
    expect(grants).toContain('REVOKE ALL ON DATABASE "authority_db" FROM "svc_role","jrn_role"');
    expect(grants).toContain('REVOKE ALL ON SCHEMA public FROM "svc_role","jrn_role"');
    expect(grants).toContain('GRANT CONNECT ON DATABASE "authority_db" TO "svc_role","jrn_role"');
    expect(grants).toContain('GRANT USAGE ON SCHEMA public TO "svc_role","jrn_role"');
    const svcUpdate = grants.find(
      (x) => x.includes('TO "svc_role"') && x.includes('SELECT,INSERT,UPDATE')
    )!;
    for (const t of [
      'authrim_replication_authorities',
      'authrim_replication_permits',
      'authrim_replication_operations',
      'authrim_replication_generation_locations',
      'authrim_replication_environment_authorities',
      'authrim_replication_environment_permits',
      'authrim_replication_environment_operations',
    ])
      expect(svcUpdate).toContain(t);
    const svcInsert = grants.find((x) => x.startsWith('GRANT SELECT,INSERT ON TABLE'))!;
    expect(svcInsert).toMatch(/TO "svc_role"$/);
    for (const t of [
      'authrim_replication_members',
      'authrim_replication_standby_generations',
      'authrim_replication_environment_reservations',
      'authrim_replication_environment_generations',
    ])
      expect(svcInsert).toContain(t);
    expect(grants).toContain(
      'GRANT SELECT,INSERT,UPDATE ON TABLE authrim_replication_journal,authrim_replication_environment_journal TO "jrn_role"'
    );
    // grants occur after table creation and before the receipt insert
    const create = s.findIndex((x) => x.startsWith('CREATE TABLE authrim_replication_schema'));
    const firstGrant = s.findIndex((x) => x.startsWith('REVOKE ALL ON DATABASE'));
    const insertIdx = s.findIndex((x) => x.startsWith('INSERT INTO'));
    expect(create).toBeLessThan(firstGrant);
    expect(firstGrant).toBeLessThan(insertIdx);
  });
  it('quotes embedded double quotes in the database name', async () => {
    const { pool, log } = makeClient({ dbName: 'we"ird' });
    await initializeReplicationAuthorityDatabase(pool as any, await source(), { ...roles });
    expect(sqls(log)).toContain('REVOKE ALL ON DATABASE "we""ird" FROM PUBLIC');
  });
  it('does not mutate the caller roles object', async () => {
    const { pool } = makeClient();
    const given = { ...roles };
    await initializeReplicationAuthorityDatabase(pool as any, await source(), given);
    expect(given).toEqual(roles);
  });

  it('requires TLS', async () => {
    for (const ssl of [false, undefined, 'true', 1]) {
      const { pool, log, release } = makeClient({ ssl });
      // makeClient defaults undefined to true, so force explicit value
      const client = await pool.connect();
      const orig = client.query.getMockImplementation()!;
      client.query.mockImplementation(async (sql: string, p?: unknown[]) =>
        sql.includes('pg_stat_ssl') ? { rows: [{ ssl }] } : orig(sql, p)
      );
      await expect(
        initializeReplicationAuthorityDatabase(pool as any, await source())
      ).rejects.toThrow('replication_authority_initialization_failed');
      expect(sqls(log)).toContain('ROLLBACK');
      expect(sqls(log)).not.toContain('SET LOCAL search_path TO public');
      expect(release).toHaveBeenCalledWith(true);
    }
  });
  it('rejects missing ssl row', async () => {
    const { pool, client, log } = makeClient();
    const orig = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql: string, p?: unknown[]) =>
      sql.includes('pg_stat_ssl') ? { rows: [] } : orig(sql, p)
    );
    await expect(
      initializeReplicationAuthorityDatabase(pool as any, await source())
    ).rejects.toThrow('replication_authority_initialization_failed');
    expect(sqls(log)).toContain('ROLLBACK');
  });

  describe('bootstrap owner / role verification', () => {
    const run = async (script: Script) => {
      const c = makeClient(script);
      const p = initializeReplicationAuthorityDatabase(c.pool as any, await source(), { ...roles });
      return { c, p };
    };
    const fails = async (script: Script) => {
      const { c, p } = await run(script);
      await expect(p).rejects.toThrow('replication_authority_initialization_failed');
      const s = sqls(c.log);
      expect(s).toContain('ROLLBACK');
      expect(s).not.toContain('COMMIT');
      expect(s.some((x) => x.startsWith('CREATE TABLE'))).toBe(false);
      expect(c.release).toHaveBeenCalledWith(true);
    };
    it('requires exactly one actor row', async () => {
      await fails({ actor: { rows: [] } });
      await fails({
        actor: {
          rows: [
            { username: 'o', owner: 'o' },
            { username: 'o', owner: 'o' },
          ],
        },
      });
    });
    it('requires the actor to own the database', async () => {
      await fails({ actor: { rows: [{ username: 'a', owner: 'b' }] } });
    });
    it('refuses the service or journal role as actor', async () => {
      await fails({ actor: { rows: [{ username: roles.serviceRole, owner: roles.serviceRole }] } });
      await fails({ actor: { rows: [{ username: roles.journalRole, owner: roles.journalRole }] } });
    });
    it('requires exactly one schema owner row owned by actor or pg_database_owner', async () => {
      await fails({ schemaOwner: { rows: [] } });
      await fails({ schemaOwner: { rows: [{ owner: 'o' }, { owner: 'o' }] } });
      await fails({ schemaOwner: { rows: [{ owner: 'someone_else' }] } });
      const ok1 = makeClient({ schemaOwner: { rows: [{ owner: 'pg_database_owner' }] } });
      await expect(
        initializeReplicationAuthorityDatabase(ok1.pool as any, await source(), { ...roles })
      ).resolves.toBeTruthy();
    });
    it('requires both roles to exist and be safe', async () => {
      await fails({ found: { rows: [{ rolname: roles.serviceRole, safe: true }] } });
      await fails({
        found: {
          rows: [
            { rolname: roles.serviceRole, safe: true },
            { rolname: roles.journalRole, safe: true },
            { rolname: 'x', safe: true },
          ],
        },
      });
      await fails({
        found: {
          rows: [
            { rolname: roles.serviceRole, safe: true },
            { rolname: roles.journalRole, safe: false },
          ],
        },
      });
      await fails({
        found: {
          rows: [
            { rolname: roles.serviceRole, safe: true },
            { rolname: roles.journalRole, safe: null },
          ],
        },
      });
    });
    it('passes both roles as the lookup parameter', async () => {
      const c = makeClient();
      await initializeReplicationAuthorityDatabase(c.pool as any, await source(), { ...roles });
      const lookup = c.log.find((l) => l.sql.includes('r.rolname=ANY'))!;
      expect(lookup.params).toEqual([['svc_role', 'jrn_role']]);
    });
  });

  describe('existing installation', () => {
    async function existing(
      over: Partial<{ source: string; roles: string | null; schema: string }>,
      withRoles = false
    ) {
      const digest = await source();
      const digestRows = Array.from({ length: 40 }, (_, i) => ({
        kind: 'k',
        name: `n${i}`,
        definition: 'd',
      }));
      const actual = restoreEvidenceDigest(digestRows);
      const c = makeClient({
        digestRows,
        prior: { rows: [{ present: true }] },
        receipt: {
          rows: [
            {
              source_sha256: over.source ?? digest,
              schema_sha256: over.schema ?? actual,
              bootstrap_json:
                over.roles !== undefined
                  ? over.roles
                  : withRoles
                    ? canonicalRestoreJson(roles)
                    : null,
            },
          ],
        },
      });
      return { c, digest, actual };
    }
    it('verifies and commits without installing', async () => {
      const { c, digest, actual } = await existing({});
      const r = await initializeReplicationAuthorityDatabase(c.pool as any, digest);
      expect(r).toEqual({ schemaSha256: actual });
      const s = sqls(c.log);
      expect(s.at(-1)).toBe('COMMIT');
      expect(s.some((x) => x.startsWith('CREATE TABLE'))).toBe(false);
      expect(s.some((x) => x.startsWith('REVOKE'))).toBe(false);
      expect(s).toContain(
        'SELECT source_sha256,schema_sha256,bootstrap_json FROM public.authrim_replication_schema'
      );
      expect(c.release).toHaveBeenCalledWith(true);
    });
    it('verifies matching bootstrap roles', async () => {
      const { c, digest } = await existing({}, true);
      await expect(
        initializeReplicationAuthorityDatabase(c.pool as any, digest, { ...roles })
      ).resolves.toBeTruthy();
    });
    it('detects source, role and schema drift', async () => {
      for (const over of [
        { source: 'x'.repeat(64) },
        { schema: 'y'.repeat(64) },
        { roles: 'zzz' },
      ]) {
        const { c, digest } = await existing(over);
        await expect(initializeReplicationAuthorityDatabase(c.pool as any, digest)).rejects.toThrow(
          'replication_authority_initialization_failed'
        );
        expect(sqls(c.log)).toContain('ROLLBACK');
        expect(sqls(c.log)).not.toContain('COMMIT');
      }
    });
    it('rejects roles recorded when none requested, and vice versa', async () => {
      const a = await existing({}, true);
      await expect(
        initializeReplicationAuthorityDatabase(a.c.pool as any, a.digest)
      ).rejects.toThrow();
      const b = await existing({});
      await expect(
        initializeReplicationAuthorityDatabase(b.c.pool as any, b.digest, { ...roles })
      ).rejects.toThrow();
    });
    it('requires exactly one receipt row', async () => {
      const digest = await source();
      for (const rows of [[], [{}, {}]]) {
        const c = makeClient({ prior: { rows: [{ present: true }] }, receipt: { rows } });
        await expect(
          initializeReplicationAuthorityDatabase(c.pool as any, digest)
        ).rejects.toThrow();
      }
    });
  });

  describe('schema digest bounds', () => {
    it('accepts 30 and 1000 rows, rejects 29 and 1001', async () => {
      const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}` }));
      for (const n of [30, 1000]) {
        const c = makeClient({ digestRows: mk(n) });
        await expect(
          initializeReplicationAuthorityDatabase(c.pool as any, await source())
        ).resolves.toBeTruthy();
      }
      for (const n of [29, 1001, 0]) {
        const c = makeClient({ digestRows: mk(n) });
        await expect(
          initializeReplicationAuthorityDatabase(c.pool as any, await source())
        ).rejects.toThrow();
        expect(sqls(c.log)).not.toContain('COMMIT');
      }
    });
    it('digest query covers every object category', async () => {
      const c = makeClient();
      await initializeReplicationAuthorityDatabase(c.pool as any, await source());
      const q = c.log.find((l) => l.sql.includes('WITH namespaces AS'))!.sql;
      for (const kind of [
        'namespace',
        'database',
        'relation',
        'column',
        'constraint',
        'index',
        'trigger',
        'policy',
        'rule',
        'routine',
        'type',
        'sequence',
        'default_acl',
        'extension',
        'event_trigger',
        'foreign_server',
      ])
        expect(q).toContain(`'${kind}'`);
      expect(q).toContain('ORDER BY 1,2,3');
    });
  });

  describe('empty database check', () => {
    it('rejects any non-"0" object count', async () => {
      for (const count of ['1', '12', 0, undefined as unknown as string, '']) {
        const c = makeClient({ count: count === undefined ? null : count });
        await expect(
          initializeReplicationAuthorityDatabase(c.pool as any, await source())
        ).rejects.toThrow('replication_authority_initialization_failed');
        expect(sqls(c.log).some((x) => x.startsWith('CREATE TABLE'))).toBe(false);
        expect(sqls(c.log)).toContain('ROLLBACK');
      }
    });
    it('count query excludes system schemas and tolerates plpgsql', async () => {
      const c = makeClient();
      await initializeReplicationAuthorityDatabase(c.pool as any, await source());
      const q = c.log.find((l) => l.sql.includes('AS count'))!.sql;
      expect(q).toContain("extname<>'plpgsql'");
      expect(q).toContain("nspname NOT IN ('public','information_schema')");
      expect(q).toContain('pg_default_acl');
      expect(q).toContain('pg_event_trigger');
      expect(q).toContain('pg_foreign_server');
    });
  });

  it('masks any failure with a fixed error and tolerates failing ROLLBACK', async () => {
    const c = makeClient({ failOn: 'CREATE TABLE authrim', rollbackFails: true });
    await expect(
      initializeReplicationAuthorityDatabase(c.pool as any, await source())
    ).rejects.toThrow(new Error('replication_authority_initialization_failed'));
    expect(c.release).toHaveBeenCalledWith(true);
  });
  it('releases (destroying) the client on success', async () => {
    const c = makeClient();
    await initializeReplicationAuthorityDatabase(c.pool as any, await source());
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.release).toHaveBeenCalledWith(true);
  });
});

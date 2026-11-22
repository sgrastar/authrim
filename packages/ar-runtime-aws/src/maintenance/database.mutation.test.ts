import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AWS_RUNTIME_SCHEMA_FILES } from '../import/aws-schema-bootstrap';
import {
  countMaintenanceRows,
  DATABASE_FAMILIES,
  initializeMaintenanceDatabases,
  inspectMaintenanceTargets,
  loadMaintenanceMigrations,
  maintenanceDatabaseUrl,
  type MaintenanceSqlClient,
} from './database';

const INVALID = 'aws_database_initialization_invalid';
const id = '01234567-89ab-cdef-0123-456789abcdef';
const marker = `authrim-initialization:${id}`;
const password = 'a'.repeat(43);

function fake(run: (sql: string, values?: unknown[]) => object[] = () => []) {
  const calls: string[] = [];
  const client: MaintenanceSqlClient = {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      const rows = run(sql, values);
      return { rows, rowCount: rows.length };
    }) as MaintenanceSqlClient['query'],
  };
  return { client, calls };
}

const databases = (overrides: Record<string, Partial<Record<string, string>>> = {}) =>
  Object.fromEntries(
    DATABASE_FAMILIES.map((family) => [
      family,
      {
        name: `test_${family}`,
        user: `test_${family}`,
        password,
        connectionString: `postgresql://x@db.example/${family}?sslmode=verify-full`,
        ...overrides[family],
      },
    ])
  ) as Parameters<typeof initializeMaintenanceDatabases>[0]['databases'];
const migrations = Object.fromEntries(
  DATABASE_FAMILIES.map((family) => [
    family,
    { files: ['001.sql'], digest: `${family}-digest`, sql: `CREATE TABLE ${family}_data(id text)` },
  ])
) as Parameters<typeof initializeMaintenanceDatabases>[0]['migrations'];

interface MasterOptions {
  roles?: object[];
  dbs?: object[];
  identity?: object[];
  failOn?: string;
}
function master(options: MasterOptions = {}) {
  return fake((sql) => {
    if (options.failOn && sql.startsWith(options.failOn)) throw new Error('synthetic failure');
    if (sql.includes('FROM pg_database')) return options.dbs ?? [];
    if (sql.includes('FROM pg_roles')) return options.roles ?? [];
    if (sql.includes('SELECT current_user')) return options.identity ?? [{ name: 'admin' }];
    return [];
  });
}
const existingDbs = DATABASE_FAMILIES.map((family) => ({
  name: `test_${family}`,
  owner: `test_${family}`,
  marker,
}));
const existingRoles = DATABASE_FAMILIES.map((family) => ({
  name: `test_${family}`,
  marker,
  safe: true,
}));

function initialize(
  m: ReturnType<typeof master>,
  extra: {
    initializationId?: string;
    dbs?: ReturnType<typeof databases>;
    target?: (sql: string) => object[] | undefined;
  } = {}
) {
  const target = fake((sql) => {
    const custom = extra.target?.(sql);
    if (custom) return custom;
    if (sql.includes('pg_stat_ssl')) return [{ ssl: true }];
    if (sql.includes('nspname NOT LIKE')) return [{ count: '0' }];
    if (sql.includes('FROM pg_class')) return [];
    if (sql.includes('FROM pg_proc') || sql.includes('FROM pg_type')) return [{ count: '0' }];
    return [];
  });
  const promise = initializeMaintenanceDatabases({
    master: m.client,
    initializationId: extra.initializationId ?? id,
    databases: extra.dbs ?? databases(),
    migrations,
    clientFactory: () => target.client,
  });
  return { promise, target };
}
const noDdl = (m: ReturnType<typeof master>) =>
  expect(
    m.calls.some((sql) => /^(CREATE|ALTER|REVOKE|GRANT|BEGIN|COMMENT|SET ROLE)/u.test(sql))
  ).toBe(false);

describe('inspectMaintenanceTargets identifiers', () => {
  it.each(['Upper', '1abc', 'a-b', '', 'a'.repeat(64), 'ok\nnl'])(
    'rejects the name %j before querying',
    async (name) => {
      const m = master();
      await expect(inspectMaintenanceTargets(m.client, ['valid_name', name])).rejects.toThrow(
        INVALID
      );
      expect(m.calls).toEqual([]);
    }
  );
  it('accepts a 63 character identifier and passes the names array', async () => {
    const m = master();
    const names = ['a'.repeat(63), 'b_1'];
    await expect(inspectMaintenanceTargets(m.client, names)).resolves.toEqual({
      databases: [],
      roles: [],
    });
    expect(vi.mocked(m.client.query).mock.calls.map(([, values]) => values)).toEqual([
      [names],
      [names],
    ]);
  });
});

describe('maintenanceDatabaseUrl validation', () => {
  const valid = {
    host: 'db.example.ap-northeast-1.rds.amazonaws.com',
    port: 5432,
    database: 'postgres',
    username: 'bootstrap_admin',
    password: 'p'.repeat(16),
  };
  it('accepts password lengths of exactly 16 and 256 and rejects 15 and 257', () => {
    expect(() => maintenanceDatabaseUrl(valid)).not.toThrow();
    expect(() => maintenanceDatabaseUrl({ ...valid, password: 'p'.repeat(256) })).not.toThrow();
    expect(() => maintenanceDatabaseUrl({ ...valid, password: 'p'.repeat(15) })).toThrow(INVALID);
    expect(() => maintenanceDatabaseUrl({ ...valid, password: 'p'.repeat(257) })).toThrow(INVALID);
  });
  it('rejects ports other than 5432', () => {
    expect(() => maintenanceDatabaseUrl({ ...valid, port: 5433 })).toThrow(INVALID);
  });
  it.each(['a_b.rds.amazonaws.com', 'x.rds.amazonaws.com.evil.test', 'x.rds.amazonaws.org', ''])(
    'rejects the host %j',
    (host) => {
      expect(() => maintenanceDatabaseUrl({ ...valid, host })).toThrow(INVALID);
    }
  );
  it.each(['1db', 'Db', 'db-x', 'db\nx', '', 'a'.repeat(64)])(
    'rejects the database name %j',
    (database) => {
      expect(() => maintenanceDatabaseUrl({ ...valid, database })).toThrow(INVALID);
    }
  );
  it.each(['1user', 'user-x', 'user x', '', 'a'.repeat(64)])(
    'rejects the username %j',
    (username) => {
      expect(() => maintenanceDatabaseUrl({ ...valid, username })).toThrow(INVALID);
    }
  );
  it('accepts mixed case usernames and a 63 character database name', () => {
    expect(() => maintenanceDatabaseUrl({ ...valid, username: 'MixedUser9' })).not.toThrow();
    expect(() => maintenanceDatabaseUrl({ ...valid, database: 'a'.repeat(63) })).not.toThrow();
  });
});

describe('loadMaintenanceMigrations', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function root() {
    const dir = await mkdtemp(join(tmpdir(), 'maint-migrations-'));
    roots.push(dir);
    return dir;
  }
  const url = (dir: string) => pathToFileURL(`${dir}/`);

  it('rejects a family directory with no migration files', async () => {
    const dir = await root();
    await mkdir(join(dir, 'migrations/core/postgresql'), { recursive: true });
    await writeFile(join(dir, 'migrations/core/postgresql/README.md'), 'not sql');
    await expect(loadMaintenanceMigrations('core', url(dir))).rejects.toThrow(INVALID);
  });
  it('rejects a blank migration file', async () => {
    const dir = await root();
    await mkdir(join(dir, 'migrations/pii/postgresql'), { recursive: true });
    await writeFile(join(dir, 'migrations/pii/postgresql/001_a.sql'), ' \n\t ');
    await expect(loadMaintenanceMigrations('pii', url(dir))).rejects.toThrow(INVALID);
  });
  it('rejects a blank runtime schema file for the state family', async () => {
    const dir = await root();
    await mkdir(join(dir, 'storage'), { recursive: true });
    for (const file of AWS_RUNTIME_SCHEMA_FILES)
      await writeFile(join(dir, 'storage', file), 'SELECT 1;');
    await writeFile(join(dir, 'storage', AWS_RUNTIME_SCHEMA_FILES[2]), '   ');
    await expect(loadMaintenanceMigrations('state', url(dir))).rejects.toThrow(INVALID);
  });
  it('concatenates sources with search_path resets and digests the sources', async () => {
    const dir = await root();
    await mkdir(join(dir, 'migrations/core/postgresql'), { recursive: true });
    await writeFile(join(dir, 'migrations/core/postgresql/002_b.sql'), 'SELECT 2;');
    await writeFile(join(dir, 'migrations/core/postgresql/001_a.sql'), 'SELECT 1;');
    const loaded = await loadMaintenanceMigrations('core', url(dir));
    expect(loaded.files).toEqual(['001_a.sql', '002_b.sql']);
    expect(loaded.sql).toBe(
      'SET search_path TO public;\nSELECT 1;\nSET search_path TO public;\nSELECT 2;\nSET search_path TO public;'
    );
    expect(loaded.digest).toMatch(/^[a-f0-9]{64}$/u);
    await writeFile(join(dir, 'migrations/core/postgresql/001_a.sql'), 'SELECT 3;');
    expect((await loadMaintenanceMigrations('core', url(dir))).digest).not.toBe(loaded.digest);
  });
  it('uses the storage directory and fixed file list for the state family', async () => {
    const dir = await root();
    await mkdir(join(dir, 'storage'), { recursive: true });
    for (const file of AWS_RUNTIME_SCHEMA_FILES)
      await writeFile(join(dir, 'storage', file), `-- ${file}`);
    const loaded = await loadMaintenanceMigrations('state', url(dir));
    expect(loaded.files).toEqual([...AWS_RUNTIME_SCHEMA_FILES]);
    expect(
      loaded.sql.startsWith(`SET search_path TO public;\n-- ${AWS_RUNTIME_SCHEMA_FILES[0]}`)
    ).toBe(true);
  });
});

describe('initializeMaintenanceDatabases preflight', () => {
  it.each([
    'G1234567-89ab-cdef-0123-456789abcdef',
    `x${id}`,
    `${id}x`,
    '01234567-89ab-cdef-0123-456789abcde',
    '',
  ])('rejects the initialization id %j before any query', async (bad) => {
    const m = master();
    await expect(initialize(m, { initializationId: bad }).promise).rejects.toThrow(INVALID);
    expect(m.calls).toEqual([]);
  });
  it('rejects duplicate database names before any query', async () => {
    const m = master();
    const dbs = databases({ pii: { name: 'test_core', user: 'test_core' } });
    await expect(initialize(m, { dbs }).promise).rejects.toThrow(INVALID);
    expect(m.calls).toEqual([]);
  });
  it('rejects a name that differs from the role name', async () => {
    const m = master();
    await expect(
      initialize(m, { dbs: databases({ state: { user: 'test_other' } }) }).promise
    ).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it.each(['Test_core', 'test-core'])('rejects the invalid identifier %s', async (name) => {
    const m = master();
    await expect(
      initialize(m, { dbs: databases({ core: { name, user: name } }) }).promise
    ).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it.each([
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(42)}!`,
    `!${'a'.repeat(43)}`,
    `${'a'.repeat(43)}!`,
    `${'a'.repeat(43)}\n`,
  ])('rejects the generated password %j', async (bad) => {
    const m = master();
    await expect(
      initialize(m, { dbs: databases({ pii: { password: bad } }) }).promise
    ).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it('rejects an existing role that is unsafe even when its marker matches', async () => {
    const m = master({ roles: [{ name: 'test_core', marker, safe: false }] });
    await expect(initialize(m).promise).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it('rejects an existing role with a missing marker', async () => {
    const m = master({ roles: [{ name: 'test_core', marker: null, safe: true }] });
    await expect(initialize(m).promise).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it('rejects an existing database without its role', async () => {
    const m = master({ dbs: [existingDbs[0]] });
    await expect(initialize(m).promise).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it('rejects an existing database owned by another role', async () => {
    const m = master({
      roles: [existingRoles[0]],
      dbs: [{ ...existingDbs[0], owner: 'someone_else' }],
    });
    await expect(initialize(m).promise).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it('rejects an existing database with a different non-null marker', async () => {
    const m = master({
      roles: [existingRoles[0]],
      dbs: [{ ...existingDbs[0], marker: 'authrim-initialization:other' }],
    });
    await expect(initialize(m).promise).rejects.toThrow(INVALID);
    noDdl(m);
  });
  it('rejects a missing master identity before any change', async () => {
    const m = master({ identity: [] });
    await expect(initialize(m).promise).rejects.toThrow(INVALID);
    expect(m.calls.some((sql) => /^(CREATE|GRANT|COMMENT|BEGIN)/u.test(sql))).toBe(false);
  });
  it('rejects an empty master identity name', async () => {
    const m = master({ identity: [{ name: '' }] });
    await expect(initialize(m).promise).rejects.toThrow(INVALID);
    expect(m.calls.some((sql) => /^(CREATE|GRANT|COMMENT|BEGIN)/u.test(sql))).toBe(false);
  });
});

describe('initializeMaintenanceDatabases existing schema checks', () => {
  const existing = () => master({ roles: existingRoles, dbs: existingDbs });
  it('rejects a database containing an extra namespace', async () => {
    const m = existing();
    const { promise, target } = initialize(m, {
      target: (sql) => (sql.includes('nspname NOT LIKE') ? [{ count: '1' }] : undefined),
    });
    await expect(promise).rejects.toThrow(INVALID);
    expect(target.client.end).toHaveBeenCalledOnce();
    noDdl(m);
  });
  it('rejects a database whose namespace count row is missing', async () => {
    const m = existing();
    const { promise } = initialize(m, {
      target: (sql) => (sql.includes('nspname NOT LIKE') ? [] : undefined),
    });
    await expect(promise).rejects.toThrow(INVALID);
  });
  it('rejects public objects that are not the initialization marker table', async () => {
    const m = existing();
    const { promise } = initialize(m, {
      target: (sql) => (sql.includes('FROM pg_class') ? [{ name: 'customer' }] : undefined),
    });
    await expect(promise).rejects.toThrow(INVALID);
  });
  it.each([
    [
      'another initialization',
      { initialization_id: 'other', family: 'core', digest: 'core-digest' },
    ],
    ['another family', { initialization_id: id, family: 'pii', digest: 'core-digest' }],
    ['another digest', { initialization_id: id, family: 'core', digest: 'changed' }],
  ])('rejects a receipt from %s', async (_label, prior) => {
    const m = existing();
    const { promise } = initialize(m, {
      target: (sql) => {
        if (sql.includes('FROM pg_class')) return [{ name: 'authrim_aws_schema_initialization' }];
        if (sql.includes('FROM authrim_aws_schema_initialization')) return [prior];
        return undefined;
      },
    });
    await expect(promise).rejects.toThrow(INVALID);
  });
  it('rejects zero or several receipts', async () => {
    for (const rows of [[], [{}, {}]]) {
      const { promise } = initialize(existing(), {
        target: (sql) => {
          if (sql.includes('FROM pg_class')) return [{ name: 'authrim_aws_schema_initialization' }];
          if (sql.includes('FROM authrim_aws_schema_initialization')) return rows;
          return undefined;
        },
      });
      await expect(promise).rejects.toThrow(INVALID);
    }
  });
  it('rejects standalone functions and standalone types independently', async () => {
    for (const needle of ['FROM pg_proc', 'FROM pg_type']) {
      const m = existing();
      const { promise } = initialize(m, {
        target: (sql) => (sql.includes(needle) ? [{ count: '2' }] : undefined),
      });
      await expect(promise).rejects.toThrow(INVALID);
      noDdl(m);
    }
  });
  it('rejects a missing function or type count row', async () => {
    for (const needle of ['FROM pg_proc', 'FROM pg_type']) {
      const { promise } = initialize(existing(), {
        target: (sql) => (sql.includes(needle) ? [] : undefined),
      });
      await expect(promise).rejects.toThrow(INVALID);
    }
  });
});

describe('initializeMaintenanceDatabases role creation failure', () => {
  it('rolls the role transaction back, rethrows, and creates nothing else', async () => {
    const m = master({ failOn: 'CREATE ROLE' });
    await expect(initialize(m).promise).rejects.toThrow('synthetic failure');
    const begin = m.calls.indexOf('BEGIN');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(m.calls.indexOf('ROLLBACK')).toBeGreaterThan(begin);
    expect(m.calls).not.toContain('COMMIT');
    expect(m.calls.some((sql) => sql.startsWith('CREATE DATABASE'))).toBe(false);
  });
  it('rolls back when the grant fails after the role was created', async () => {
    const m = master({ failOn: 'GRANT' });
    await expect(initialize(m).promise).rejects.toThrow('synthetic failure');
    expect(m.calls).toContain('ROLLBACK');
    expect(m.calls).not.toContain('COMMIT');
  });
});

describe('countMaintenanceRows', () => {
  const tables = {
    core: ['users_core', 'identity_accounts', 'passkeys', 'identity_providers'],
    pii: ['users_pii', 'identity_sensitive_values'],
    state: [
      'authrim_aws_account_auth_state',
      'authrim_aws_passkey_counters',
      'authrim_aws_saml_persistent_nameids',
      'authrim_aws_restore_activations',
    ],
  };
  function world(count: (table: string) => string | undefined = () => '3', ssl = true) {
    const clients = new Map<string, ReturnType<typeof fake>>();
    const queries: Array<{ family: string; sql: string; values?: unknown[] }> = [];
    const factory = (url: string) => {
      const family = DATABASE_FAMILIES.find((candidate) => url.includes(`/${candidate}`)) as string;
      const made = fake((sql, values) => {
        queries.push({ family, sql, values });
        if (sql.includes('pg_stat_ssl')) return [{ ssl }];
        const table = /FROM "([a-z_]+)"/u.exec(sql)?.[1] ?? '';
        const value = count(table);
        return value === undefined ? [] : [{ count: value }];
      });
      clients.set(family, made);
      return made.client;
    };
    return { factory, clients, queries };
  }
  const dbs = databases();

  it('reads every table of every family with the tenant bound and returns family-qualified counts', async () => {
    const w = world((table) => String(table.length));
    const counts = await countMaintenanceRows(dbs, 'tenant-x', w.factory);
    const expected: Record<string, number> = {};
    for (const family of DATABASE_FAMILIES)
      for (const table of tables[family]) expected[`${family}.${table}`] = table.length;
    expect(counts).toEqual(expected);
    const reads = w.queries.filter((query) => !query.sql.includes('pg_stat_ssl'));
    expect(reads).toHaveLength(10);
    for (const family of DATABASE_FAMILIES)
      expect(reads.filter((query) => query.family === family).map((query) => query.sql)).toEqual(
        tables[family].map(
          (table) => `SELECT count(*)::text AS count FROM "${table}" WHERE tenant_id=$1`
        )
      );
    for (const query of reads) expect(query.values).toEqual(['tenant-x']);
    for (const made of w.clients.values()) {
      expect(made.client.connect).toHaveBeenCalledOnce();
      expect(made.client.end).toHaveBeenCalledOnce();
    }
  });
  it('accepts a zero count', async () => {
    const counts = await countMaintenanceRows(dbs, 't', world(() => '0').factory);
    expect(counts['core.passkeys']).toBe(0);
  });
  it.each([['-1'], ['1.5'], ['abc'], ['9007199254740993'], [undefined]])(
    'rejects the count %j and still releases the connection',
    async (bad) => {
      const w = world((table) => (table === 'passkeys' ? bad : '1'));
      await expect(countMaintenanceRows(dbs, 't', w.factory)).rejects.toThrow(INVALID);
      expect(w.clients.get('core')?.client.end).toHaveBeenCalledOnce();
      expect(w.clients.has('pii')).toBe(false);
    }
  );
  it('requires TLS before counting', async () => {
    const w = world(() => '1', false);
    await expect(countMaintenanceRows(dbs, 't', w.factory)).rejects.toThrow(
      'aws_database_tls_required'
    );
    expect(w.queries.filter((query) => !query.sql.includes('pg_stat_ssl'))).toEqual([]);
    expect(w.clients.get('core')?.client.end).toHaveBeenCalledOnce();
  });
});

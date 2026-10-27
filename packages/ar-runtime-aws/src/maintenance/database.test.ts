import { describe, expect, it, vi } from 'vitest';
import {
  assertMaintenanceTls,
  DATABASE_FAMILIES,
  initializeMaintenanceDatabases,
  maintenanceDatabaseUrl,
  withMaintenanceLock,
  type MaintenanceSqlClient,
} from './database';
import {
  handler,
  parseMaintenanceAction,
  parseMaintenanceConfiguration,
} from './db-bootstrap-handler';

const initializationId = '01234567-89ab-cdef-0123-456789abcdef';
const marker = `authrim-initialization:${initializationId}`;
const dbs = Object.fromEntries(
  DATABASE_FAMILIES.map((family) => [
    family,
    {
      name: `test_${family}`,
      user: `test_${family}`,
      password: 'a'.repeat(43),
      connectionString: `postgresql://test_${family}:password@db.example/${family}?sslmode=verify-full`,
    },
  ])
) as Parameters<typeof initializeMaintenanceDatabases>[0]['databases'];
const migrations = Object.fromEntries(
  DATABASE_FAMILIES.map((family) => [
    family,
    {
      files: ['001.sql'],
      digest: `${family}-digest`,
      sql: `CREATE TABLE ${family}_data(id text)`,
    },
  ])
) as Parameters<typeof initializeMaintenanceDatabases>[0]['migrations'];
function fakeClient(
  run: (sql: string, values?: unknown[]) => object[] = () => []
): MaintenanceSqlClient {
  return {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      const rows = run(sql, values);
      return { rows, rowCount: rows.length };
    }) as MaintenanceSqlClient['query'],
  };
}
function masterWith(options: { existing?: boolean; foreign?: boolean } = {}) {
  return fakeClient((sql) => {
    if (sql.includes('FROM pg_database'))
      return options.existing
        ? DATABASE_FAMILIES.map((family) => ({
            name: `test_${family}`,
            owner: `test_${family}`,
            marker,
          }))
        : [];
    if (sql.includes('FROM pg_roles'))
      return options.existing || options.foreign
        ? DATABASE_FAMILIES.map((family) => ({
            name: `test_${family}`,
            marker: options.foreign ? 'somebody-else' : marker,
            safe: true,
          }))
        : [];
    if (sql.includes('SELECT current_user')) return [{ name: 'bootstrap_admin' }];
    return [];
  });
}
function targetFor(
  family: string,
  options: { initialized?: boolean; nonempty?: boolean; staleDigest?: boolean } = {}
) {
  return fakeClient((sql) => {
    if (sql.includes('FROM pg_stat_ssl')) return [{ ssl: true }];
    if (sql.includes('FROM pg_class'))
      return options.initialized
        ? [{ name: 'authrim_aws_schema_initialization' }]
        : options.nonempty
          ? [{ name: 'customer_data' }]
          : [];
    if (sql.includes('FROM authrim_aws_schema_initialization'))
      return [
        {
          initialization_id: initializationId,
          family,
          digest: options.staleDigest ? 'changed' : `${family}-digest`,
        },
      ];
    if (
      sql.includes('FROM pg_proc') ||
      sql.includes('FROM pg_type') ||
      sql.includes('FROM pg_namespace')
    )
      return [{ count: '0' }];
    return [];
  });
}

describe('AWS maintenance database boundary', () => {
  it('uses TLS verification with escaped credentials and rejects alternate database hosts', () => {
    const result = maintenanceDatabaseUrl({
      host: 'db.example.ap-northeast-1.rds.amazonaws.com',
      port: 5432,
      username: 'bootstrap_admin',
      password: 'a/secret:@value-1234',
      database: 'postgres',
    });
    const parsed = new URL(result);
    expect(decodeURIComponent(parsed.password)).toBe('a/secret:@value-1234');
    expect(parsed.search).toBe('?sslmode=verify-full');
    expect(() =>
      maintenanceDatabaseUrl({
        host: 'localhost',
        port: 5432,
        username: 'u',
        password: 'a'.repeat(32),
        database: 'postgres',
      })
    ).toThrow('aws_database_initialization_invalid');
  });
  it('rejects a plaintext connection and releases a connection when the lock is busy', async () => {
    await expect(assertMaintenanceTls(fakeClient(() => [{ ssl: false }]))).rejects.toThrow(
      'aws_database_tls_required'
    );
    const client = fakeClient((sql) =>
      sql.includes('pg_stat_ssl') ? [{ ssl: true }] : [{ acquired: false }]
    );
    const run = vi.fn();
    await expect(withMaintenanceLock('test', initializationId, run, () => client)).rejects.toThrow(
      'aws_database_maintenance_busy'
    );
    expect(run).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });
  it('refuses an existing unrelated role before any DDL', async () => {
    const master = masterWith({ foreign: true });
    await expect(
      initializeMaintenanceDatabases({ master, initializationId, databases: dbs, migrations })
    ).rejects.toThrow('aws_database_initialization_invalid');
    expect(
      vi.mocked(master.query).mock.calls.some(([sql]) => /CREATE|ALTER|REVOKE|GRANT/.test(sql))
    ).toBe(false);
  });
  it('creates three separate owners and schemas with no public database access', async () => {
    const master = masterWith();
    const clients = DATABASE_FAMILIES.map((family) => targetFor(family));
    const receipt = await initializeMaintenanceDatabases({
      master,
      initializationId,
      databases: dbs,
      migrations,
      clientFactory: (url) =>
        clients[DATABASE_FAMILIES.findIndex((family) => url.includes(`/${family}?`))],
    });
    expect(receipt).toEqual(
      DATABASE_FAMILIES.map((family) => ({
        family,
        database: `test_${family}`,
        schemaSha256: `${family}-digest`,
      }))
    );
    const queries = vi.mocked(master.query).mock.calls.map(([sql]) => sql);
    for (const family of DATABASE_FAMILIES) {
      expect(queries).toContain(
        `GRANT "test_${family}" TO "bootstrap_admin" WITH SET TRUE, INHERIT FALSE`
      );
      expect(queries).toContain(`SET ROLE "test_${family}"`);
      expect(queries).toContain(`REVOKE ALL ON DATABASE "test_${family}" FROM PUBLIC`);
    }
    expect(queries.filter((sql) => sql.startsWith('RESET ROLE'))).toHaveLength(3);
    expect(queries.some((sql) => sql.startsWith('DROP'))).toBe(false);
    for (const client of clients) {
      expect(client.end).toHaveBeenCalledOnce();
    }
  });
  it('resumes only a matching initialization receipt and never reruns migrations', async () => {
    const master = masterWith({ existing: true });
    const clients = DATABASE_FAMILIES.map((family) => targetFor(family, { initialized: true }));
    await initializeMaintenanceDatabases({
      master,
      initializationId,
      databases: dbs,
      migrations,
      clientFactory: (url) =>
        clients[DATABASE_FAMILIES.findIndex((family) => url.includes(`/${family}?`))],
    });
    expect(vi.mocked(master.query).mock.calls.some(([sql]) => sql.startsWith('CREATE'))).toBe(
      false
    );
    for (const client of clients) {
      expect(vi.mocked(client.query).mock.calls.some(([sql]) => sql.startsWith('CREATE'))).toBe(
        false
      );
    }
  });
  it.each([{ nonempty: true }, { initialized: true, staleDigest: true }])(
    'rejects nonempty or changed schema and rolls back (%j)',
    async (options) => {
      const target = targetFor('core', options);
      await expect(
        initializeMaintenanceDatabases({
          master: masterWith({ existing: true }),
          initializationId,
          databases: dbs,
          migrations,
          clientFactory: () => target,
        })
      ).rejects.toThrow('aws_database_initialization_invalid');
      expect(vi.mocked(target.query).mock.calls.map(([sql]) => sql)).not.toContain('BEGIN');
      expect(vi.mocked(target.query).mock.calls.some(([sql]) => sql.startsWith('CREATE'))).toBe(
        false
      );
      expect(target.end).toHaveBeenCalledOnce();
    }
  );
  it('rolls back failed DDL without hiding the failure inside the initialization engine', async () => {
    const target = targetFor('core');
    const query = target.query;
    target.query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('CREATE TABLE core_data')) throw new Error('synthetic SQL failure');
      return query(sql, values);
    }) as MaintenanceSqlClient['query'];
    await expect(
      initializeMaintenanceDatabases({
        master: masterWith(),
        initializationId,
        databases: dbs,
        migrations,
        clientFactory: () => target,
      })
    ).rejects.toThrow('synthetic SQL failure');
    expect(vi.mocked(target.query).mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(target.end).toHaveBeenCalledOnce();
  });
});

const environment = {
  AWS_REGION: 'ap-northeast-1',
  NODE_EXTRA_CA_CERTS: '/var/task/certs/rds-ca.pem',
  AUTHRIM_AWS_DB_HOST: 'db.example.ap-northeast-1.rds.amazonaws.com',
  AUTHRIM_AWS_DB_PORT: '5432',
  AUTHRIM_AWS_MASTER_SECRET_ARN: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:master',
  AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN:
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:config',
  AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: initializationId,
  AUTHRIM_AWS_RUNTIME_SECRET_ARN:
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:runtime',
  AUTHRIM_AWS_INITIALIZATION_ID: initializationId,
  AUTHRIM_AWS_DATABASE_PREFIX: 'authrim_dr_rehearsal',
  AUTHRIM_AWS_ASSETS_BUCKET: 'bucket-example',
  AUTHRIM_AWS_BUCKET_OWNER: '123456789012',
  AUTHRIM_AWS_ASSET_PREFIX: 'rehearsal/1/',
  AUTHRIM_AWS_FIXTURE_KEY: 'rehearsal/1/fixture.json',
  AUTHRIM_AWS_FIXTURE_VERSION_ID: 'version-1',
  AUTHRIM_AWS_FIXTURE_SHA256: 'a'.repeat(64),
};
describe('manual maintenance entry', () => {
  it('pins account, secret versions, asset prefix, database destination and CA configuration', () => {
    expect(parseMaintenanceConfiguration(environment).databasePrefix).toBe('authrim_dr_rehearsal');
    for (const changed of [
      { AUTHRIM_AWS_DB_HOST: 'other.example.test' },
      {
        AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN:
          'arn:aws:secretsmanager:ap-northeast-1:999999999999:secret:other',
      },
      { AUTHRIM_AWS_FIXTURE_KEY: 'different/fixture.json' },
      { AUTHRIM_AWS_FIXTURE_VERSION_ID: 'null' },
      { NODE_EXTRA_CA_CERTS: '' },
    ])
      expect(() => parseMaintenanceConfiguration({ ...environment, ...changed })).toThrow(
        'aws_maintenance_configuration_invalid'
      );
  });
  it('rejects arbitrary SQL and altered destinations in invocation payloads', () => {
    expect(parseMaintenanceAction({ action: 'initialize' })).toEqual({ action: 'initialize' });
    expect(() =>
      parseMaintenanceAction({ action: 'initialize', database: 'production' })
    ).toThrow();
    expect(() =>
      parseMaintenanceAction({ action: 'query', sql: 'DROP DATABASE production' })
    ).toThrow();
    expect(() => parseMaintenanceAction({ action: 'verify' })).toThrow();
    expect(() => parseMaintenanceAction({ action: 'authenticate' })).toThrow();
    expect(() => parseMaintenanceAction({ action: 'prepare-browser-sp' })).toThrow();
    expect(() =>
      parseMaintenanceConfiguration({
        ...environment,
        AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: environment.AUTHRIM_AWS_MASTER_SECRET_ARN,
      })
    ).toThrow();
    expect(() =>
      parseMaintenanceAction({ action: 'authenticate', evidence: {}, credential: 'injected' })
    ).toThrow();
    expect(parseMaintenanceAction({ action: 'authenticate', evidence: {} })).toEqual({
      action: 'authenticate',
      evidence: {},
    });
  });
  it('never exposes malformed input or an underlying secret in public errors', async () => {
    await expect(handler({ action: 'secret-value-should-not-appear' })).rejects.toThrow(
      /^aws_database_maintenance_failed:validate$/u
    );
  });
});

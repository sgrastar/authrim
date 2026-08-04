import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  listProviderReprojectionStatus,
  markGlobalProviderDesiredRevision,
  processProviderReprojectionJobs,
} from '../provider-reprojection-jobs';

const { listEnvironmentTenantDefaultStoresMock } = vi.hoisted(() => ({
  listEnvironmentTenantDefaultStoresMock: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  listEnvironmentTenantDefaultStores: listEnvironmentTenantDefaultStoresMock,
}));

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, values.map(sqlValue));
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.values) as T[] };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

function sqlValue(value: unknown): SqlValue {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    value === null ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error('unsupported_test_sqlite_value');
}

class Session {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    return new BoundStatement(this.database.prepare(sql), []);
  }

  async batch(statements: BoundStatement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
    batch: (statements: BoundStatement[]) => session.batch(statements),
  } as unknown as D1Database;
}

function kv(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values));
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  } as unknown as KVNamespace;
}

describe('provider reprojection jobs', () => {
  let core: DatabaseSync;
  let admin: DatabaseSync;
  let configureHumanVerificationInstallation: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    listEnvironmentTenantDefaultStoresMock.mockReset();
    listEnvironmentTenantDefaultStoresMock.mockImplementation(
      async (_env: Env, options: { afterTenantId?: string }) =>
        ['tenant-a', 'tenant-b']
          .filter((tenantId) => tenantId > (options.afterTenantId ?? ''))
          .map((tenantId) => ({ tenantId, store: {} }))
    );
    core = new DatabaseSync(':memory:');
    core.exec(
      `CREATE TABLE tenants (
         id TEXT PRIMARY KEY,
         lifecycle_state TEXT NOT NULL
       );
       INSERT INTO tenants (id, lifecycle_state) VALUES
         ('tenant-a', 'active'), ('tenant-b', 'active');`
    );
    admin = new DatabaseSync(':memory:');
    admin.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/admin/031_provider_reprojection_jobs.sql'),
        'utf8'
      )
    );
    configureHumanVerificationInstallation = vi.fn(async (input) => ({
      installationId: input.installationId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      state: input.enabled ? ('enabled' as const) : ('disabled' as const),
      configVersion: 2,
    }));
    env = {
      DB: d1(core),
      DB_ADMIN: d1(admin),
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      SETTINGS: kv({
        'plugins:config:human-verification-cloudflare-turnstile': JSON.stringify({
          siteKey: 'site-key',
          secretKey: 'secret-key',
          failurePolicy: 'fail_closed',
        }),
        'plugins:enabled:human-verification-cloudflare-turnstile': 'true',
        'settings:tenant:tenant-a:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider':
            'human-verification-cloudflare-turnstile',
          'authentication-methods.human_verification.login_enabled': true,
        }),
        'settings:tenant:tenant-b:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider':
            'human-verification-cloudflare-turnstile',
          'authentication-methods.human_verification.login_enabled': true,
        }),
      }),
      PLUGIN_RUNNER: { configureHumanVerificationInstallation },
    } as unknown as Env;
  });

  afterEach(() => {
    core.close();
    admin.close();
  });

  const logger = { info: vi.fn(), warn: vi.fn() };

  it('automatically projects the global revision and exposes completed progress', async () => {
    const revision = await markGlobalProviderDesiredRevision(
      env,
      'human-verification-cloudflare-turnstile',
      1_000
    );
    await expect(processProviderReprojectionJobs(env, logger, { now: 1_001 })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      superseded: 0,
    });
    expect(configureHumanVerificationInstallation).toHaveBeenCalledTimes(2);
    expect(configureHumanVerificationInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', enabled: true })
    );
    await expect(listProviderReprojectionStatus(env)).resolves.toEqual([
      expect.objectContaining({
        pluginId: 'human-verification-cloudflare-turnstile',
        revision,
        status: 'completed',
        total: 2,
        processed: 2,
        succeeded: 2,
        failed: 0,
      }),
    ]);
  });

  it('fails closed without projecting when the signed tenant directory is unavailable', async () => {
    listEnvironmentTenantDefaultStoresMock.mockRejectedValueOnce(
      new Error('environment_tenant_directory_unavailable')
    );
    await markGlobalProviderDesiredRevision(env, 'human-verification-cloudflare-turnstile', 1_500);

    await expect(processProviderReprojectionJobs(env, logger, { now: 1_501 })).rejects.toThrow(
      'environment_tenant_directory_unavailable'
    );
    expect(configureHumanVerificationInstallation).not.toHaveBeenCalled();
  });

  it('skips explicit tenant config overrides without copying global credentials', async () => {
    await env.SETTINGS!.put(
      'plugins:config:human-verification-cloudflare-turnstile:tenant:tenant-b',
      JSON.stringify({ siteKey: 'tenant-site', secretKey: 'tenant-secret' })
    );
    await markGlobalProviderDesiredRevision(env, 'human-verification-cloudflare-turnstile', 2_000);
    await processProviderReprojectionJobs(env, logger, { now: 2_001 });
    expect(configureHumanVerificationInstallation).toHaveBeenCalledTimes(1);
    await expect(listProviderReprojectionStatus(env)).resolves.toEqual([
      expect.objectContaining({ processed: 2, succeeded: 1, skipped: 1 }),
    ]);
  });

  it('disables an inherited provider that is no longer selected', async () => {
    await env.SETTINGS!.put(
      'settings:tenant:tenant-b:authentication-methods',
      JSON.stringify({
        'authentication-methods.human_verification.provider': 'human-verification-hcaptcha',
        'authentication-methods.human_verification.login_enabled': true,
      })
    );
    await markGlobalProviderDesiredRevision(env, 'human-verification-cloudflare-turnstile', 2_500);
    await processProviderReprojectionJobs(env, logger, { now: 2_501 });

    expect(configureHumanVerificationInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-b', enabled: false })
    );
  });

  it('retries the same failed tenant without advancing the durable cursor', async () => {
    configureHumanVerificationInstallation
      .mockRejectedValueOnce(new Error('runner_unavailable'))
      .mockRejectedValueOnce(new Error('runner_unavailable'));
    await markGlobalProviderDesiredRevision(env, 'human-verification-cloudflare-turnstile', 3_000);
    await expect(
      processProviderReprojectionJobs(env, logger, { now: 3_001 })
    ).resolves.toMatchObject({
      retried: 1,
    });
    expect(
      admin
        .prepare(
          `SELECT cursor_tenant_id, status, failed_tenants, last_error_code
             FROM provider_reprojection_jobs`
        )
        .get()
    ).toEqual({
      cursor_tenant_id: null,
      status: 'pending',
      failed_tenants: 1,
      last_error_code: 'runner_unavailable',
    });

    await processProviderReprojectionJobs(env, logger, { now: 3_004 });
    expect(
      admin
        .prepare(
          `SELECT cursor_tenant_id, status, failed_tenants, last_error_code
             FROM provider_reprojection_jobs`
        )
        .get()
    ).toEqual({
      cursor_tenant_id: null,
      status: 'pending',
      failed_tenants: 1,
      last_error_code: 'runner_unavailable',
    });

    await processProviderReprojectionJobs(env, logger, { now: 3_009 });
    expect(configureHumanVerificationInstallation.mock.calls[2]?.[0]).toMatchObject({
      tenantId: 'tenant-a',
    });
    await expect(listProviderReprojectionStatus(env)).resolves.toEqual([
      expect.objectContaining({ status: 'completed', processed: 2 }),
    ]);
  });

  it('selects the latest same-second job by insertion order', async () => {
    admin
      .prepare(
        `INSERT INTO provider_reprojection_jobs (
           job_id, plugin_id, desired_revision, status, total_tenants,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'superseded', 2, 4000, 4000)`
      )
      .run('job-z-older', 'notifier-resend', 'revision-older');
    admin
      .prepare(
        `INSERT INTO provider_reprojection_jobs (
           job_id, plugin_id, desired_revision, status, total_tenants,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 2, 4000, 4000)`
      )
      .run('job-a-newer', 'notifier-resend', 'revision-newer');

    await expect(listProviderReprojectionStatus(env)).resolves.toEqual([
      expect.objectContaining({
        pluginId: 'notifier-resend',
        revision: 'revision-newer',
        status: 'pending',
      }),
    ]);
  });
});

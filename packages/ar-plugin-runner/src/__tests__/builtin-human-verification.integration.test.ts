import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinHumanVerificationRegistry } from '../builtin-human-verification';
import { D1HumanVerificationInstallationStore } from '../human-verification-installations';
import { SyncHookBackendRouter } from '../sync-hook-backend-router';
import { SyncHookService } from '../sync-hook-service';
import type { SyncHookBackend } from '../sync-hooks';
import type { PluginRunnerEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENCRYPTION_SECRET = 'human-verification-encryption-secret-value';
const MUTATION_SECRET = 'human-verification-mutation-secret-value';

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

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

class Session {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      bind: (...values: unknown[]) =>
        new BoundStatement(
          statement,
          values.map((value) => {
            if (
              typeof value === 'string' ||
              typeof value === 'number' ||
              value === null ||
              value instanceof Uint8Array
            ) {
              return value;
            }
            throw new Error('unsupported_test_sqlite_value');
          })
        ),
    };
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
  } as unknown as D1Database;
}

describe('built-in human-verification Runner execution', () => {
  let database: DatabaseSync;
  let env: PluginRunnerEnv;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['001_pre_1_0_plugin_runner_baseline.sql']) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migration), 'utf8')
      );
    }
    env = {
      PLUGIN_RUNNER_DB: d1(database),
      PLUGIN_ENCRYPTION_KEY: ENCRYPTION_SECRET,
      PLUGIN_MUTATION_HMAC_KEY: MUTATION_SECRET,
    } as PluginRunnerEnv;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
  });

  async function configureTurnstile() {
    await new D1HumanVerificationInstallationStore(
      env.PLUGIN_RUNNER_DB,
      ENCRYPTION_SECRET,
      MUTATION_SECRET,
      () => 1_000
    ).configure({
      operationId: 'turnstile-config-a',
      installationId: 'turnstile-installation-a',
      tenantId: 'tenant-a',
      pluginId: 'human-verification-cloudflare-turnstile',
      enabled: true,
      config: {
        siteKey: 'public-site-key',
        secretKey: 'private-siteverify-secret',
        expectedHostname: 'login.example.com',
        widgetMode: 'managed',
      },
    });
  }

  function service() {
    const dynamicBackend: SyncHookBackend = {
      async invoke() {
        throw new Error('unexpected_dynamic_backend');
      },
    };
    return new SyncHookService(
      env.PLUGIN_RUNNER_DB,
      new SyncHookBackendRouter(dynamicBackend, createBuiltinHumanVerificationRegistry(env)),
      () => 1_001
    );
  }

  const input = {
    tenantId: 'tenant-a',
    pluginInstallationId: 'turnstile-installation-a',
    requestId: 'request-a',
    action: 'login' as const,
    responseToken: 'browser-token',
    remoteIp: '203.0.113.7',
  };

  it('injects the secret in Runner and allows only a matching Turnstile response', async () => {
    await configureTurnstile();
    const externalFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      await expect(request.json()).resolves.toMatchObject({
        secret: 'private-siteverify-secret',
        response: 'browser-token',
        remoteip: '203.0.113.7',
      });
      return new Response(
        JSON.stringify({
          success: true,
          hostname: 'login.example.com',
          action: 'authrim-login',
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', externalFetch);

    await expect(service().runHumanVerification(input)).resolves.toEqual({
      decision: 'allow',
      reasonCode: 'verification_succeeded',
    });
    expect(externalFetch).toHaveBeenCalledTimes(1);
  });

  it('denies mismatched action and cross-tenant installation use', async () => {
    await configureTurnstile();
    const externalFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: 'login.example.com',
            action: 'authrim-signup',
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', externalFetch);

    await expect(service().runHumanVerification(input)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'verification_failed',
    });
    await expect(
      service().runHumanVerification({ ...input, tenantId: 'tenant-b' })
    ).resolves.toEqual({ decision: 'deny', reasonCode: 'plugin_unavailable' });
    expect(externalFetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes provider outages to fail-closed unavailability', async () => {
    await configureTurnstile();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );

    await expect(service().runHumanVerification(input)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'plugin_unavailable',
    });
  });
});

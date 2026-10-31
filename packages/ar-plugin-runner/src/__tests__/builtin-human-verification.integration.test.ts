import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { humanVerificationConfigValid } from '@authrim/ar-lib-core';
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
    for (const migration of ['001_0_5_0_plugin_runner_baseline.sql']) {
      database.exec(
        readRenderedMigrationSql(resolve(REPO_ROOT, 'migrations/plugin-runner/d1'), migration)
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

  // The settings API, the admin guards and the projection call a configuration usable by
  // humanVerificationConfigValid; the Runner must accept exactly those (and nothing else).
  const TURNSTILE = 'human-verification-cloudflare-turnstile';
  const HCAPTCHA = 'human-verification-hcaptcha';
  const RECAPTCHA = 'human-verification-google-recaptcha';
  const keys = { siteKey: 'site', secretKey: 'secret' };
  it.each([
    ['plain keys', TURNSTILE, keys],
    ['site key at its limit', TURNSTILE, { ...keys, siteKey: 'a'.repeat(2_048) }],
    ['site key over its limit', TURNSTILE, { ...keys, siteKey: 'a'.repeat(2_049) }],
    ['secret key at its limit', TURNSTILE, { ...keys, secretKey: 'a'.repeat(8_192) }],
    ['secret key over its limit', TURNSTILE, { ...keys, secretKey: 'a'.repeat(8_193) }],
    ['a hostname', TURNSTILE, { ...keys, expectedHostname: 'Login.Example.com' }],
    ['a malformed hostname', TURNSTILE, { ...keys, expectedHostname: 'not a host' }],
    ['a hostname with a scheme', TURNSTILE, { ...keys, expectedHostname: 'https://a.example.com' }],
    ['a single-label hostname', TURNSTILE, { ...keys, expectedHostname: 'localhost' }],
    ['a widget mode Turnstile lacks', TURNSTILE, { ...keys, widgetMode: 'checkbox' }],
    ['hCaptcha invisible', HCAPTCHA, { ...keys, widgetMode: 'invisible' }],
    ['hCaptcha score (unsupported)', HCAPTCHA, { ...keys, widgetMode: 'score' }],
    ['reCAPTCHA score', RECAPTCHA, { ...keys, widgetMode: 'score', scoreThreshold: 0.7 }],
    ['a score threshold above 1', RECAPTCHA, { ...keys, scoreThreshold: 1.5 }],
    ['a negative score threshold', RECAPTCHA, { ...keys, scoreThreshold: -0.1 }],
  ])('accepts a configuration exactly when it is valid: %s', async (_name, pluginId, config) => {
    const valid = humanVerificationConfigValid(pluginId, config);
    // What the projection sends: trimmed keys, only the fields that are set.
    const store = new D1HumanVerificationInstallationStore(
      env.PLUGIN_RUNNER_DB,
      ENCRYPTION_SECRET,
      MUTATION_SECRET,
      () => 1_000
    );
    const run = store.configure({
      operationId: 'limits-config-a',
      installationId: 'limits-installation-a',
      tenantId: 'tenant-a',
      pluginId,
      enabled: true,
      config: config as never,
    });
    if (valid) await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toThrow('plugin_human_verification_config_invalid');
  });

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

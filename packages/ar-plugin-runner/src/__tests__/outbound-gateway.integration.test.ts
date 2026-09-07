import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deriveEncryptionKey, encryptValue } from '@authrim/ar-lib-plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginOutboundGateway } from '../outbound-gateway';
import type { PluginEgressContext, PluginRunnerEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENCRYPTION_SECRET = 'phase-2b-test-encryption-secret-value';

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
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

function aad(input: {
  tenantId: string;
  pluginId: string;
  configKey: string;
  configVersion: number;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([input.tenantId, input.pluginId, input.configKey, input.configVersion])
  );
}

const invocation: PluginEgressContext = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  capability: 'notifier.send',
  requestId: 'event/account-created#1',
};

describe('PluginOutboundGateway', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['001_0_4_0_plugin_runner_baseline.sql']) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner/d1', migration), 'utf8')
      );
    }
    database.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, config_version, platform_rate_per_minute, created_at, updated_at
       ) VALUES (
         'installation-a', 'tenant-a', 'notifier-plugin', 'in_process',
         NULL, 'enabled', 1, 60, 1, 1
       );`
    );
  });

  afterEach(() => database.close());

  function environment(): PluginRunnerEnv {
    return {
      PLUGIN_RUNNER_DB: d1(database),
      PLUGIN_ENCRYPTION_KEY: ENCRYPTION_SECRET,
      AUTHRIM_PLUGIN_EGRESS_CONTEXT: invocation,
    } as unknown as PluginRunnerEnv;
  }

  function allowExactHost(host = 'hooks.example.com') {
    database
      .prepare(
        `INSERT INTO plugin_runner_egress_allowed_hosts (
           plugin_id, rule_id, match_kind, host_pattern, created_at
         ) VALUES ('notifier-plugin', 'rule-1', 'exact', ?, 1)`
      )
      .run(host);
  }

  async function insertBearerCredential(options: { wrongAad?: boolean } = {}) {
    const key = await deriveEncryptionKey(ENCRYPTION_SECRET);
    const encrypted = await encryptValue(
      'server-owned-secret',
      key,
      aad({
        tenantId: options.wrongAad ? 'tenant-other' : 'tenant-a',
        pluginId: 'notifier-plugin',
        configKey: 'apiKey',
        configVersion: 1,
      })
    );
    database
      .prepare(
        `INSERT INTO plugin_runner_encrypted_configs (
           installation_id, config_key, config_version, injection_kind, injection_name,
           destination_host, encryption_key_id, encrypted_value, nonce_fingerprint,
           created_at, updated_at
         ) VALUES (
           'installation-a', 'apiKey', 1, 'bearer', 'Authorization',
           'hooks.example.com', 'v1', ?, ?, 1, 1
         )`
      )
      .run(encrypted, 'a'.repeat(64));
  }

  async function insertBodyCredential(injectionKind: 'json_field' | 'form_field') {
    const key = await deriveEncryptionKey(ENCRYPTION_SECRET);
    const encrypted = await encryptValue(
      'server-owned-secret',
      key,
      aad({
        tenantId: 'tenant-a',
        pluginId: 'notifier-plugin',
        configKey: 'secretKey',
        configVersion: 1,
      })
    );
    database
      .prepare(
        `INSERT INTO plugin_runner_encrypted_configs (
           installation_id, config_key, config_version, injection_kind, injection_name,
           destination_host, encryption_key_id, encrypted_value, nonce_fingerprint,
           created_at, updated_at
         ) VALUES (
           'installation-a', 'secretKey', 1, ?, 'secret',
           'hooks.example.com', 'v1', ?, ?, 1, 1
         )`
      )
      .run(
        injectionKind,
        encrypted,
        injectionKind === 'json_field' ? 'b'.repeat(64) : 'c'.repeat(64)
      );
  }

  it('injects only the host-owned credential and records a bounded successful attempt', async () => {
    allowExactHost();
    await insertBearerCredential();
    const externalFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.url).toBe('https://hooks.example.com/events');
      expect(request.headers.get('Authorization')).toBe('Bearer server-owned-secret');
      expect(request.headers.has('Cookie')).toBe(false);
      expect(request.headers.has('X-Api-Key')).toBe(false);
      expect(request.headers.has('Forwarded')).toBe(false);
      expect(request.headers.has('X-Forwarded-For')).toBe(false);
      expect(await request.text()).toBe('{"event":"created"}');
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': 'provider-session=secret', 'X-Provider': 'accepted' },
      });
    });
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);

    const response = await gateway.fetch(
      new Request('https://hooks.example.com/events', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer attacker-controlled',
          Cookie: 'session=attacker-controlled',
          Forwarded: 'for=127.0.0.1;host=internal',
          'X-Api-Key': 'attacker-controlled',
          'X-Forwarded-For': '127.0.0.1',
        },
        body: '{"event":"created"}',
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('X-Provider')).toBe('accepted');
    expect(externalFetch).toHaveBeenCalledTimes(1);
    expect(
      database
        .prepare(
          `SELECT tenant_id, request_id, destination_host, credential_injected, result_code
             FROM plugin_runner_egress_audit`
        )
        .get()
    ).toEqual({
      tenant_id: 'tenant-a',
      request_id: 'event/account-created#1',
      destination_host: 'hooks.example.com',
      credential_injected: 1,
      result_code: 'http_204',
    });
  });

  it('fails closed before external fetch when credential AAD does not match the tenant', async () => {
    allowExactHost();
    await insertBearerCredential({ wrongAad: true });
    const externalFetch = vi.fn();
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);

    await expect(gateway.fetch(new Request('https://hooks.example.com/events'))).rejects.toThrow(
      'plugin_egress_configuration_failed'
    );
    expect(externalFetch).not.toHaveBeenCalled();
    expect(
      database
        .prepare(`SELECT credential_injected, result_code FROM plugin_runner_egress_audit`)
        .get()
    ).toEqual({ credential_injected: 0, result_code: 'configuration_failure' });
  });

  it.each([
    {
      injectionKind: 'json_field' as const,
      contentType: 'application/json',
      body: '{"response":"token"}',
      read: async (request: Request) => JSON.parse(await request.text()) as Record<string, string>,
    },
    {
      injectionKind: 'form_field' as const,
      contentType: 'application/x-www-form-urlencoded',
      body: 'response=token',
      read: async (request: Request) =>
        Object.fromEntries(new URLSearchParams(await request.text()).entries()),
    },
  ])('injects a host-owned $injectionKind credential into a bounded body', async (testCase) => {
    allowExactHost();
    await insertBodyCredential(testCase.injectionKind);
    const externalFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input);
      await expect(testCase.read(request)).resolves.toEqual({
        response: 'token',
        secret: 'server-owned-secret',
      });
      return new Response('{}', { status: 200 });
    });
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);

    await expect(
      gateway.fetch(
        new Request('https://hooks.example.com/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': testCase.contentType },
          body: testCase.body,
        })
      )
    ).resolves.toMatchObject({ status: 200 });
  });

  it('rejects a plugin-supplied body field reserved for credential injection', async () => {
    allowExactHost();
    await insertBodyCredential('json_field');
    const externalFetch = vi.fn();
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);

    await expect(
      gateway.fetch(
        new Request('https://hooks.example.com/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: 'token', secret: 'attacker-controlled' }),
        })
      )
    ).rejects.toThrow('plugin_egress_configuration_failed');
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it('does not treat a wildcard as sufficient until a controlled DNS proxy exists', async () => {
    database.exec(
      `INSERT INTO plugin_runner_egress_allowed_hosts (
         plugin_id, rule_id, match_kind, host_pattern, created_at
       ) VALUES ('notifier-plugin', 'rule-1', 'suffix_wildcard', '*.example.com', 1)`
    );
    const externalFetch = vi.fn();
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);

    await expect(gateway.fetch(new Request('https://hooks.example.com/events'))).rejects.toThrow(
      'plugin_egress_wildcard_requires_controlled_proxy'
    );
    expect(externalFetch).not.toHaveBeenCalled();
    expect(database.prepare(`SELECT result_code FROM plugin_runner_egress_audit`).get()).toEqual({
      result_code: 'host_denied',
    });
  });

  it('enforces the platform rate limit before credential loading or external fetch', async () => {
    allowExactHost();
    database.exec(
      `UPDATE plugin_runner_installations
          SET platform_rate_per_minute = 1
        WHERE installation_id = 'installation-a'`
    );
    const externalFetch = vi.fn(
      async () =>
        new Response('ok', {
          headers: { 'Content-Length': '2', 'Set-Cookie': 'provider=secret' },
        })
    );
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);

    const response = await gateway.fetch(new Request('https://hooks.example.com/events'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('Set-Cookie')).toBeNull();
    await expect(gateway.fetch(new Request('https://hooks.example.com/events'))).rejects.toThrow(
      'plugin_egress_rate_limited'
    );
    expect(externalFetch).toHaveBeenCalledTimes(1);
    expect(
      database
        .prepare(
          `SELECT result_code, COUNT(*) AS count
             FROM plugin_runner_egress_audit GROUP BY result_code ORDER BY result_code`
        )
        .all()
    ).toEqual([
      { result_code: 'http_200', count: 1 },
      { result_code: 'rate_limited', count: 1 },
    ]);
  });

  it('preserves the caller deadline when it is shorter than the gateway timeout', async () => {
    allowExactHost();
    const controller = new AbortController();
    controller.abort();
    const externalFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.signal.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);

    await expect(
      gateway.fetch(
        new Request('https://hooks.example.com/events', {
          signal: controller.signal,
        })
      )
    ).rejects.toThrow('plugin_egress_transient_failure');
    expect(externalFetch).toHaveBeenCalledTimes(1);
    expect(database.prepare(`SELECT result_code FROM plugin_runner_egress_audit`).get()).toEqual({
      result_code: 'network_failure',
    });
  });

  it('cancels an undeclared oversized response without buffering it past the limit', async () => {
    allowExactHost();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gateway = new PluginOutboundGateway(
      environment(),
      vi.fn(async () => new Response(body, { status: 200 })),
      () => 1_000
    );

    await expect(gateway.fetch(new Request('https://hooks.example.com/events'))).rejects.toThrow(
      'plugin_egress_response_too_large'
    );
    expect(cancelled).toBe(true);
    expect(database.prepare(`SELECT result_code FROM plugin_runner_egress_audit`).get()).toEqual({
      result_code: 'response_too_large',
    });
  });

  it('cancels an undeclared oversized request before external dispatch', async () => {
    allowExactHost();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const externalFetch = vi.fn();
    const gateway = new PluginOutboundGateway(environment(), externalFetch, () => 1_000);
    const request = new Request('https://hooks.example.com/events', {
      method: 'POST',
      body,
      duplex: 'half',
    } as never);

    await expect(gateway.fetch(request)).rejects.toThrow('plugin_egress_request_too_large');
    expect(cancelled).toBe(true);
    expect(externalFetch).not.toHaveBeenCalled();
    expect(database.prepare(`SELECT result_code FROM plugin_runner_egress_audit`).get()).toEqual({
      result_code: 'request_too_large',
    });
  });
});

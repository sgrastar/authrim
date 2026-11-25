import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveEncryptionKey, encryptValue } from '@authrim/ar-lib-plugin';
import { PluginOutboundGateway } from '../outbound-gateway';
import type { PluginEgressContext, PluginRunnerEnv } from '../types';
import { must } from './helpers/mock-kit';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const SECRET = 'plugin-encryption-secret-with-32-chars!';
const CONTEXT: PluginEgressContext = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  capability: 'notifier.send',
  requestId: 'request-a',
};
const NOW = 1_000;
let database: DatabaseSync;

const aad = (configKey: string, version = 1, tenantId = 'tenant-a') =>
  new TextEncoder().encode(JSON.stringify([tenantId, 'notifier-plugin', configKey, version]));

async function credential(
  kind: 'header' | 'bearer' | 'json_field' | 'form_field',
  name: string,
  key: string,
  value = 'server-secret',
  over: { tenantId?: string; nonce?: string } = {}
) {
  const encrypted = await encryptValue(
    value,
    await deriveEncryptionKey(SECRET),
    aad(key, 1, over.tenantId)
  );
  database
    .prepare(
      `INSERT INTO plugin_runner_encrypted_configs (installation_id, config_key, config_version, injection_kind, injection_name, destination_host, encryption_key_id, encrypted_value, nonce_fingerprint, created_at, updated_at) VALUES ('installation-a', ?, 1, ?, ?, 'hooks.example.com', 'v1', ?, ?, 1, 1)`
    )
    .run(
      key,
      kind,
      name,
      encrypted,
      over.nonce ??
        `${key}`
          .padEnd(64, '0')
          .replaceAll(/[^0-9a-f]/gu, 'a')
          .slice(0, 64)
    );
}

function gateway(
  options: D1Options = {},
  fetcher = vi.fn(async (_request: Request) => new Response('ok')),
  now = NOW
) {
  const d1 = createD1(database, options);
  const env = {
    PLUGIN_RUNNER_DB: d1.db,
    PLUGIN_ENCRYPTION_KEY: SECRET,
  } as unknown as PluginRunnerEnv;
  return {
    gateway: new PluginOutboundGateway(env, fetcher as never, () => now, CONTEXT),
    fetcher,
    calls: d1.calls,
  };
}
const send = (g: ReturnType<typeof gateway>, init: RequestInit & { url?: string } = {}) =>
  g.gateway.fetch(
    new Request(init.url ?? 'https://hooks.example.com/events', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  );
const audit = () =>
  database.prepare('SELECT * FROM plugin_runner_egress_audit').all() as Array<
    Record<string, unknown>
  >;

beforeEach(() => {
  database = openRunnerDatabase();
  database.exec(
    `INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, platform_rate_per_minute, created_at, updated_at) VALUES ('installation-a', 'tenant-a', 'notifier-plugin', 'in_process', NULL, 'enabled', 1, 60, 1, 1);
     INSERT INTO plugin_runner_egress_allowed_hosts (plugin_id, rule_id, match_kind, host_pattern, created_at) VALUES ('notifier-plugin', 'rule-1', 'exact', 'hooks.example.com', 1);`
  );
});

describe('installation resolution', () => {
  it('needs the sessions API', async () => {
    await expect(send(gateway({ withoutSession: true }))).rejects.toThrow(
      /^plugin_egress_d1_session_required$/u
    );
  });
  it.each([
    ['a disabled installation', "UPDATE plugin_runner_installations SET state = 'disabled'"],
    ['a blocked installation', "UPDATE plugin_runner_installations SET state = 'blocked'"],
    ['another tenant', "UPDATE plugin_runner_installations SET tenant_id = 'tenant-b'"],
  ])('refuses %s', async (_label, sql) => {
    database.exec(sql);
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_installation_unavailable$/u);
    expect(audit()).toEqual([]);
  });
  it('refuses a plugin id the store would not accept', async () => {
    await expect(
      send(
        gateway({
          rewrite: (call, value) =>
            call.kind === 'first' ? { ...(value as object), plugin_id: 'bad id' } : value,
        })
      )
    ).rejects.toThrow(/^plugin_egress_installation_unavailable$/u);
  });
  it.each([
    [
      'an unreadable config version',
      { config_version: 'x' },
      'plugin_egress_config_version_invalid',
    ],
    ['a zero config version', { config_version: 0 }, 'plugin_egress_config_version_invalid'],
    ['a zero rate limit', { platform_rate_per_minute: 0 }, 'plugin_egress_rate_limit_invalid'],
    [
      'an oversized rate limit',
      { platform_rate_per_minute: 10_001 },
      'plugin_egress_rate_limit_invalid',
    ],
    [
      'an unreadable rate limit',
      { platform_rate_per_minute: 'x' },
      'plugin_egress_rate_limit_invalid',
    ],
  ])('refuses %s', async (_label, patch, code) => {
    await expect(
      send(
        gateway({
          rewrite: (call, value) =>
            call.kind === 'first' && call.sql.includes('platform_rate_per_minute')
              ? { ...(value as object), ...patch }
              : value,
        })
      )
    ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });
  it.each([1, 10_000])('accepts a rate limit of %i', async (rate) => {
    database.exec(`UPDATE plugin_runner_installations SET platform_rate_per_minute = ${rate}`);
    await expect(send(gateway())).resolves.toBeInstanceOf(Response);
  });
  it('refuses more than 100 egress rules', async () => {
    await expect(
      send(
        gateway({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('plugin_runner_egress_allowed_hosts')
              ? {
                  ...(value as object),
                  results: Array.from({ length: 101 }, () => ({
                    match_kind: 'exact',
                    host_pattern: 'a.example.com',
                  })),
                }
              : value,
        })
      )
    ).rejects.toThrow(/^plugin_egress_rule_limit_exceeded$/u);
  });
  it('accepts exactly 100 egress rules', async () => {
    await expect(
      send(
        gateway({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('plugin_runner_egress_allowed_hosts')
              ? {
                  ...(value as object),
                  results: [
                    { match_kind: 'exact', host_pattern: 'hooks.example.com' },
                    ...Array.from({ length: 99 }, (_, i) => ({
                      match_kind: 'exact',
                      host_pattern: `h${i}.example.com`,
                    })),
                  ],
                }
              : value,
        })
      )
    ).resolves.toBeInstanceOf(Response);
  });
});

describe('destination and method policy', () => {
  it.each([
    [
      'a host that is not approved',
      'https://other.example.com/x',
      'host_denied',
      'plugin_egress_host_denied',
      'other.example.com',
    ],
    [
      'a plain-HTTP URL',
      'http://hooks.example.com/x',
      'host_denied',
      'plugin_egress_host_denied',
      'hooks.example.com',
    ],
  ])('audits and refuses %s', async (_label, url, result, code, host) => {
    await expect(send(gateway(), { url, body: undefined, method: 'GET' })).rejects.toThrow(
      new RegExp(`^${code}$`, 'u')
    );
    expect(audit()).toMatchObject([
      {
        result_code: result,
        destination_host: host,
        credential_injected: 0,
        request_id: 'request-a',
        capability: 'notifier.send',
        installation_id: 'installation-a',
        tenant_id: 'tenant-a',
        created_at: NOW,
      },
    ]);
  });
  it('refuses a host approved only by a wildcard rule', async () => {
    database.exec(
      "DELETE FROM plugin_runner_egress_allowed_hosts; INSERT INTO plugin_runner_egress_allowed_hosts (plugin_id, rule_id, match_kind, host_pattern, created_at) VALUES ('notifier-plugin', 'rule-1', 'suffix_wildcard', '*.example.com', 1)"
    );
    await expect(send(gateway(), { method: 'GET', body: undefined })).rejects.toThrow(
      /^plugin_egress_wildcard_requires_controlled_proxy$/u
    );
    expect(audit()).toMatchObject([
      { result_code: 'host_denied', destination_host: 'hooks.example.com' },
    ]);
  });
  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'allows the %s method',
    async (method) => {
      const withBody = ['POST', 'PUT', 'PATCH'].includes(method);
      const g = gateway();
      await send(g, { method, body: withBody ? '{}' : undefined });
      expect(must(g.fetcher.mock.calls[0])[0].method).toBe(method);
    }
  );
  it('refuses an unknown method with an audit trail', async () => {
    await expect(send(gateway(), { method: 'PROPFIND', body: undefined })).rejects.toThrow(
      /^plugin_egress_method_denied$/u
    );
    expect(audit()).toMatchObject([
      { result_code: 'method_denied', destination_host: 'hooks.example.com' },
    ]);
  });
});

describe('rate limiting', () => {
  it('lets the configured number of requests through per minute window and then refuses', async () => {
    database.exec('UPDATE plugin_runner_installations SET platform_rate_per_minute = 2');
    await send(gateway());
    await send(gateway());
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_rate_limited$/u);
    expect(audit().map((row) => row.result_code)).toEqual(['http_200', 'http_200', 'rate_limited']);
    await expect(send(gateway({}, undefined, NOW + 19))).rejects.toThrow(
      /^plugin_egress_rate_limited$/u
    );
    await expect(send(gateway({}, undefined, NOW + 20))).resolves.toBeInstanceOf(Response);
  });
  it('counts per destination host window starting at the minute boundary', async () => {
    database.exec('UPDATE plugin_runner_installations SET platform_rate_per_minute = 1');
    await send(gateway({}, undefined, 960));
    await expect(send(gateway({}, undefined, 1_019))).rejects.toThrow(
      /^plugin_egress_rate_limited$/u
    );
    await expect(send(gateway({}, undefined, 1_020))).resolves.toBeInstanceOf(Response);
    expect(
      database
        .prepare('SELECT window_started_at, used_count FROM plugin_runner_rate_limit_buckets')
        .get()
    ).toEqual({ window_started_at: 1_020, used_count: 1 });
  });
  it('audits a failing limiter and refuses the call', async () => {
    await expect(
      send(
        gateway({
          intercept: (call) => {
            if (call.kind === 'run' && call.sql.includes('rate_limit_buckets'))
              throw new Error('d1 down');
            return undefined;
          },
        })
      )
    ).rejects.toThrow(/^plugin_egress_rate_limit_failed$/u);
    expect(audit()).toMatchObject([{ result_code: 'rate_limit_failure' }]);
  });
});

describe('credential injection', () => {
  it('injects header and bearer credentials over caller-supplied ones', async () => {
    await credential('bearer', 'Authorization', 'bearerKey', 'bearer-secret');
    await credential('header', 'X-Provider-Key', 'headerKey', 'header-secret');
    const g = gateway();
    await send(g, {
      headers: {
        'Content-Type': 'application/json',
        'X-Provider-Key': 'attacker',
        Authorization: 'Bearer attacker',
      },
    });
    const request = must(g.fetcher.mock.calls[0])[0];
    expect(request.headers.get('Authorization')).toBe('Bearer bearer-secret');
    expect(request.headers.get('X-Provider-Key')).toBe('header-secret');
    expect(audit()).toMatchObject([{ result_code: 'http_200', credential_injected: 1 }]);
  });
  it('writes a JSON field into a JSON object body', async () => {
    await credential('json_field', 'secret', 'jsonKey', 'json-secret');
    const g = gateway();
    await send(g);
    expect(await must(g.fetcher.mock.calls[0])[0].text()).toBe('{"a":1,"secret":"json-secret"}');
  });
  it('writes a form field into a form body', async () => {
    await credential('form_field', 'secret', 'formKey', 'form secret');
    const g = gateway();
    await send(g, {
      body: 'a=1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    });
    expect(await must(g.fetcher.mock.calls[0])[0].text()).toBe('a=1&secret=form+secret');
  });
  it.each([
    [
      'a JSON field into a non-JSON request',
      'json_field',
      { body: 'x', headers: { 'Content-Type': 'text/plain' } },
    ],
    [
      'a JSON field into a request without a body',
      'json_field',
      { method: 'GET', body: undefined, headers: { 'Content-Type': 'application/json' } },
    ],
    ['a JSON field into an array body', 'json_field', { body: '[1]' }],
    ['a JSON field into a scalar body', 'json_field', { body: '5' }],
    ['a JSON field into invalid JSON', 'json_field', { body: '{nope' }],
    ['a JSON field over an existing key', 'json_field', { body: '{"secret":"x"}' }],
    ['a form field into a JSON request', 'form_field', {}],
    [
      'a form field over an existing key',
      'form_field',
      { body: 'secret=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    ],
    [
      'a form field into a request without a body',
      'form_field',
      {
        method: 'GET',
        body: undefined,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    ],
  ])('refuses %s and sends nothing', async (_label, kind, init) => {
    await credential(kind as 'json_field', 'secret', 'someKey');
    const g = gateway();
    await expect(send(g, init as RequestInit)).rejects.toThrow(
      /^plugin_egress_configuration_failed$/u
    );
    expect(g.fetcher).not.toHaveBeenCalled();
    expect(audit()).toMatchObject([
      { result_code: 'configuration_failure', credential_injected: 0 },
    ]);
  });
  it('refuses to mix JSON and form injection in one request', async () => {
    await credential('json_field', 'jsonSecret', 'jsonKey');
    await credential('form_field', 'formSecret', 'formKey');
    const g = gateway();
    await expect(send(g)).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    await expect(
      send(g, { body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    ).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
  });
  it('refuses a ciphertext that was sealed for another tenant', async () => {
    await credential('bearer', 'Authorization', 'bearerKey', 'x', { tenantId: 'tenant-z' });
    const g = gateway();
    await expect(send(g)).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    expect(g.fetcher).not.toHaveBeenCalled();
  });
  it('refuses an unknown key id and a malformed credential row', async () => {
    await credential('bearer', 'Authorization', 'bearerKey');
    await expect(
      send(
        gateway({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('encrypted_value')
              ? {
                  ...(value as { results: object[] }),
                  results: (value as { results: object[] }).results.map((row) => ({
                    ...row,
                    encryption_key_id: 'v9',
                  })),
                }
              : value,
        })
      )
    ).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    for (const patch of [
      { config_key: '1bad' },
      { injection_name: 'bad name' },
      { injection_kind: 'cookie' },
      { config_version: 0 },
      { injection_kind: 'header', injection_name: 'Content-Type' },
      { injection_kind: 'bearer', injection_name: 'X-Other' },
    ]) {
      await expect(
        send(
          gateway({
            rewrite: (call, value) =>
              call.kind === 'all' && call.sql.includes('encrypted_value')
                ? {
                    ...(value as { results: object[] }),
                    results: (value as { results: object[] }).results.map((row) => ({
                      ...row,
                      ...patch,
                    })),
                  }
                : value,
          })
        )
      ).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    }
  });
  it('refuses more than sixteen credentials for one destination', async () => {
    await credential('bearer', 'Authorization', 'bearerKey');
    await expect(
      send(
        gateway({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('encrypted_value')
              ? { ...(value as object), results: Array.from({ length: 17 }, () => ({})) }
              : value,
        })
      )
    ).rejects.toThrow(/^plugin_egress_credential_limit_exceeded$/u);
  });
  it('refuses a body grown past 64 KiB by an injected field', async () => {
    await credential('json_field', 'secret', 'jsonKey', 'x'.repeat(100));
    const filler = JSON.stringify({ pad: 'x'.repeat(64 * 1024 - 20) });
    expect(filler.length).toBeLessThanOrEqual(64 * 1024);
    await expect(send(gateway(), { body: filler })).rejects.toThrow(
      /^plugin_egress_configuration_failed$/u
    );
  });
  it('binds the credential query to the installation, config version and destination', async () => {
    const g = gateway();
    await send(g);
    const query = must(g.calls.find((c) => c.kind === 'all' && c.sql.includes('encrypted_value')));
    expect(query.values).toEqual(['installation-a', 1, 'hooks.example.com', 17]);
  });
  it('only uses credentials of the current config version in a usable re-encryption state', async () => {
    await credential('bearer', 'Authorization', 'bearerKey', 'bearer-secret');
    database.exec("UPDATE plugin_runner_encrypted_configs SET reencrypt_state = 'pending'");
    const g = gateway();
    await send(g);
    expect(must(g.fetcher.mock.calls[0])[0].headers.has('Authorization')).toBe(false);
    database.exec("UPDATE plugin_runner_encrypted_configs SET reencrypt_state = 'verified'");
    const second = gateway();
    await send(second);
    expect(must(second.fetcher.mock.calls[0])[0].headers.get('Authorization')).toBe(
      'Bearer bearer-secret'
    );
  });
});

describe('request and response bounds', () => {
  it('refuses a request body above 64 KiB, audits it and sends nothing', async () => {
    const g = gateway();
    await expect(send(g, { body: 'x'.repeat(64 * 1024 + 1) })).rejects.toThrow(
      /^plugin_egress_request_too_large$/u
    );
    expect(audit()).toMatchObject([{ result_code: 'request_too_large' }]);
    expect(g.fetcher).not.toHaveBeenCalled();
    await expect(send(gateway(), { body: 'x'.repeat(64 * 1024) })).resolves.toBeInstanceOf(
      Response
    );
  });
  it('reports an unreadable request body as a transient failure', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('broken'));
      },
    });
    await expect(send(gateway(), { body, duplex: 'half' } as RequestInit)).rejects.toThrow(
      /^plugin_egress_transient_failure$/u
    );
    expect(audit()).toMatchObject([{ result_code: 'network_failure' }]);
  });
  it('turns a network failure into a transient one', async () => {
    const g = gateway(
      {},
      vi.fn(() => Promise.reject(new Error('dns')))
    );
    await expect(send(g)).rejects.toThrow(/^plugin_egress_transient_failure$/u);
    expect(audit()).toMatchObject([{ result_code: 'network_failure' }]);
  });
  it('limits the response to 1 MiB', async () => {
    const big = gateway(
      {},
      vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1)))
    );
    await expect(send(big)).rejects.toThrow(/^plugin_egress_response_too_large$/u);
    expect(audit()).toMatchObject([{ result_code: 'response_too_large' }]);
    const exact = gateway(
      {},
      vi.fn(async () => new Response('x'.repeat(1024 * 1024)))
    );
    await expect(send(exact).then((r) => r.text())).resolves.toHaveLength(1024 * 1024);
  });
  it('reports an unreadable response as a transient failure', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('broken'));
      },
    });
    await expect(
      send(
        gateway(
          {},
          vi.fn(async () => new Response(body))
        )
      )
    ).rejects.toThrow(/^plugin_egress_transient_failure$/u);
    expect(audit()).toMatchObject([{ result_code: 'network_failure' }]);
  });
  it('returns the provider status without hop-by-hop headers or cookies', async () => {
    const g = gateway(
      {},
      vi.fn(
        async () =>
          new Response('created', {
            status: 201,
            statusText: 'Created',
            headers: { 'Set-Cookie': 'a=b', 'X-Provider': 'ok', Connection: 'close' },
          })
      )
    );
    const response = await send(g);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('X-Provider')).toBe('ok');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(await response.text()).toBe('created');
    expect(audit()).toMatchObject([{ result_code: 'http_201' }]);
  });
  it.each([204, 205, 304])('returns no body for status %i', async (status) => {
    const response = await send(
      gateway(
        {},
        vi.fn(async () => new Response(null, { status }))
      )
    );
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
  });
  it('sends the request to the authorised destination without following redirects', async () => {
    const g = gateway();
    await send(g, { url: 'https://hooks.example.com/events?x=1' });
    const request = must(g.fetcher.mock.calls[0])[0];
    expect(request.url).toBe('https://hooks.example.com/events?x=1');
    expect(request.redirect).toBe('manual');
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });
  it('refuses a context that is not well-formed', async () => {
    const d1 = createD1(database);
    const env = {
      PLUGIN_RUNNER_DB: d1.db,
      PLUGIN_ENCRYPTION_KEY: SECRET,
    } as unknown as PluginRunnerEnv;
    await expect(
      new PluginOutboundGateway(env, vi.fn() as never, () => NOW).fetch(
        new Request('https://hooks.example.com/')
      )
    ).rejects.toThrow(/^plugin_egress_context_invalid$/u);
  });
});

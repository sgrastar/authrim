import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveEncryptionKey, encryptValue } from '@authrim/ar-lib-plugin';
import { PluginOutboundGateway } from '../outbound-gateway';
import type { PluginEgressContext, PluginRunnerEnv } from '../types';
import { must } from './helpers/mock-kit';
import {
  seedArtifact,
  seedInstallation,
  seedPlugin,
  VERSION_1,
} from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const SECRET = 'plugin-encryption-secret-with-32-chars!';
const CONTEXT: PluginEgressContext = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  capability: 'notifier.send',
  requestId: 'request-a',
};
const HOST = 'hooks.example.com';
let database: DatabaseSync;

async function credential(
  plugin: string,
  kind: string,
  name: string,
  key: string,
  value = 'server-secret',
  nonce = key
) {
  const encrypted = await encryptValue(
    value,
    await deriveEncryptionKey(SECRET),
    new TextEncoder().encode(JSON.stringify(['tenant-a', plugin, key, 1]))
  );
  database
    .prepare(
      `INSERT INTO plugin_runner_encrypted_configs (installation_id, config_key, config_version, injection_kind, injection_name, destination_host, encryption_key_id, encrypted_value, nonce_fingerprint, created_at, updated_at) VALUES ('installation-a', ?, 1, ?, ?, ?, 'v1', ?, ?, 1, 1)`
    )
    .run(
      key,
      kind,
      name,
      HOST,
      encrypted,
      nonce
        .padEnd(64, 'a')
        .replaceAll(/[^0-9a-f]/gu, 'b')
        .slice(0, 64)
    );
}
function gateway(
  options: D1Options = {},
  fetcher = vi.fn(async (_request: Request) => new Response('ok')),
  now: number | null = 1_000
) {
  const d1 = createD1(database, options);
  const env = {
    PLUGIN_RUNNER_DB: d1.db,
    PLUGIN_ENCRYPTION_KEY: SECRET,
  } as unknown as PluginRunnerEnv;
  return {
    gateway: new PluginOutboundGateway(
      env,
      fetcher as never,
      now === null ? undefined : () => now,
      CONTEXT
    ),
    fetcher,
    calls: d1.calls,
  };
}
const send = (g: ReturnType<typeof gateway>, init: RequestInit & { url?: string } = {}) =>
  g.gateway.fetch(
    new Request(init.url ?? `https://${HOST}/events`, {
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
const AUDIT_ID = /^egress-[0-9a-f-]{36}$/u;

async function builtin() {
  database.exec(
    `INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, platform_rate_per_minute, created_at, updated_at) VALUES ('installation-a', 'tenant-a', 'notifier-plugin', 'in_process', NULL, 'enabled', 1, 60, 1, 1);
     INSERT INTO plugin_runner_egress_allowed_hosts (plugin_id, rule_id, match_kind, host_pattern, created_at) VALUES ('notifier-plugin', 'rule-1', 'exact', '${HOST}', 1);`
  );
}
async function dynamic(gate = true) {
  seedPlugin(database, {
    pluginId: 'plugin-a',
    slots: [{ configKey: 'apiKey', required: true, destinationHost: HOST }],
  });
  const id = await seedInstallation(database, {
    installationId: 'installation-a',
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    state: 'enabled',
  });
  seedArtifact(database, id, VERSION_1, 'active', 'plugin-a');
  database.exec('UPDATE plugin_runner_installations SET platform_rate_per_minute = 60');
  if (gate)
    database.exec(
      "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1)"
    );
}

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('audit trail', () => {
  beforeEach(async () => {
    await builtin();
  });
  it('gives every audit row a unique id and records that no credential was injected when none was', async () => {
    await send(gateway());
    await expect(
      send(gateway(), { url: 'https://other.example.com/x', method: 'GET', body: undefined })
    ).rejects.toThrow(/host_denied/u);
    await expect(send(gateway(), { method: 'PROPFIND', body: undefined })).rejects.toThrow(
      /method_denied/u
    );
    const rows = audit();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.audit_id).toMatch(AUDIT_ID);
      expect(row.credential_injected).toBe(0);
    }
    expect(new Set(rows.map((row) => row.audit_id)).size).toBe(3);
  });
  it('records the rate-limit outcomes without a credential flag and with fresh ids', async () => {
    database.exec('UPDATE plugin_runner_installations SET platform_rate_per_minute = 1');
    await send(gateway());
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_rate_limited$/u);
    await expect(
      send(
        gateway({
          intercept: (call) => {
            if (call.kind === 'run' && call.sql.includes('rate_limit_buckets'))
              throw new Error('down');
            return undefined;
          },
        })
      )
    ).rejects.toThrow(/^plugin_egress_rate_limit_failed$/u);
    for (const row of audit()) {
      expect(row.audit_id).toMatch(AUDIT_ID);
      expect(row.credential_injected).toBe(0);
    }
  });
  it('records a wildcard-only approval without a credential flag', async () => {
    database.exec(
      "DELETE FROM plugin_runner_egress_allowed_hosts; INSERT INTO plugin_runner_egress_allowed_hosts (plugin_id, rule_id, match_kind, host_pattern, created_at) VALUES ('notifier-plugin', 'rule-1', 'suffix_wildcard', '*.example.com', 1)"
    );
    await expect(send(gateway())).rejects.toThrow(/wildcard/u);
    expect(audit()[0]).toMatchObject({ credential_injected: 0, result_code: 'host_denied' });
    expect(audit()[0]?.audit_id).toMatch(AUDIT_ID);
  });
  it.each([
    ['a host with an underscore', 'https://a_b.example.com/x', 'invalid'],
    ['a host with an unsupported label', 'https://UPPER.Example.COM/x', 'upper.example.com'],
    ['a plain host that is not approved', 'https://nope.example.com/x', 'nope.example.com'],
  ])('audits a denied destination with %s as %s', async (_label, url, host) => {
    await expect(send(gateway(), { url, method: 'GET', body: undefined })).rejects.toThrow(
      /^plugin_egress_host_denied$/u
    );
    expect(audit()[0]).toMatchObject({ destination_host: host });
  });
  it('stamps the audit with the clock in seconds when none is injected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_555_900);
    try {
      await send(gateway({}, undefined, null));
      expect(audit()[0]).toMatchObject({ created_at: 1_700_000_555, updated_at: 1_700_000_555 });
    } finally {
      vi.useRealTimers();
    }
  });
  it('fails when an audit row cannot be recorded or finished', async () => {
    await expect(
      send(
        gateway({
          intercept: (call) =>
            call.kind === 'run' && call.sql.includes('INSERT INTO plugin_runner_egress_audit')
              ? { value: { success: true, results: [], meta: { changes: 0 } } }
              : undefined,
        })
      )
    ).rejects.toThrow(/^plugin_egress_audit_failed$/u);
    await expect(
      send(
        gateway({
          intercept: (call) =>
            call.kind === 'run' && call.sql.includes('SET result_code')
              ? { value: { success: true, results: [], meta: { changes: 0 } } }
              : undefined,
        })
      )
    ).rejects.toThrow(/^plugin_egress_audit_finish_failed$/u);
  });
  it('refuses to send a credentialed request when the injection cannot be audited', async () => {
    await credential('notifier-plugin', 'bearer', 'Authorization', 'bearerKey');
    const g = gateway({
      intercept: (call) =>
        call.kind === 'run' && call.sql.includes('credential_injected = 1')
          ? { value: { success: true, results: [], meta: { changes: 0 } } }
          : undefined,
    });
    await expect(send(g)).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    expect(g.fetcher).not.toHaveBeenCalled();
  });
});

describe('credential bodies', () => {
  beforeEach(async () => {
    await builtin();
  });
  it('injects several JSON fields into one body', async () => {
    await credential('notifier-plugin', 'json_field', 'one', 'jsonOne', 'first');
    await credential('notifier-plugin', 'json_field', 'two', 'jsonTwo', 'second');
    const g = gateway();
    await send(g);
    expect(JSON.parse(await must(g.fetcher.mock.calls[0])[0].text())).toEqual({
      a: 1,
      one: 'first',
      two: 'second',
    });
  });
  it('injects several form fields into one body', async () => {
    await credential('notifier-plugin', 'form_field', 'one', 'formOne', 'first');
    await credential('notifier-plugin', 'form_field', 'two', 'formTwo', 'second');
    const g = gateway();
    await send(g, {
      body: 'a=1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(
      Object.fromEntries(new URLSearchParams(await must(g.fetcher.mock.calls[0])[0].text()))
    ).toEqual({ a: '1', one: 'first', two: 'second' });
  });
  it('tolerates whitespace before the parameters of the content type', async () => {
    await credential('notifier-plugin', 'json_field', 'secret', 'jsonKey');
    const g = gateway();
    await send(g, { headers: { 'Content-Type': 'application/json ; charset=utf-8' } });
    expect(await must(g.fetcher.mock.calls[0])[0].json()).toEqual({
      a: 1,
      secret: 'server-secret',
    });
  });
  it('refuses a JSON field when the request is not declared as JSON even if the body parses', async () => {
    await credential('notifier-plugin', 'json_field', 'secret', 'jsonKey');
    const g = gateway();
    await expect(send(g, { headers: { 'Content-Type': 'text/plain' } })).rejects.toThrow(
      /^plugin_egress_configuration_failed$/u
    );
    await expect(
      send(g, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    ).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    expect(g.fetcher).not.toHaveBeenCalled();
  });
  it('refuses a form field when the request is not declared as a form even if the body parses', async () => {
    await credential('notifier-plugin', 'form_field', 'secret', 'formKey');
    const g = gateway();
    await expect(send(g, { body: 'a=1' })).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    await expect(
      send(g, { body: 'a=1', headers: { 'Content-Type': 'text/plain' } })
    ).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    expect(g.fetcher).not.toHaveBeenCalled();
  });
  it('refuses a JSON body that is not valid UTF-8', async () => {
    await credential('notifier-plugin', 'json_field', 'secret', 'jsonKey');
    const g = gateway();
    await expect(
      send(g, { body: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) })
    ).rejects.toThrow(/^plugin_egress_configuration_failed$/u);
    expect(g.fetcher).not.toHaveBeenCalled();
  });
  it('accepts a body that is exactly 64 KiB after injection and refuses one byte more', async () => {
    await credential('notifier-plugin', 'json_field', 's', 'jsonKey', 'v');
    const overhead = JSON.stringify({ pad: '', s: 'v' }).length;
    const exact = JSON.stringify({ pad: 'x'.repeat(64 * 1024 - overhead) });
    const over = JSON.stringify({ pad: 'x'.repeat(64 * 1024 - overhead + 1) });
    const g = gateway();
    await expect(send(g, { body: exact })).resolves.toBeInstanceOf(Response);
    expect((await must(g.fetcher.mock.calls[0])[0].arrayBuffer()).byteLength).toBe(64 * 1024);
    await expect(send(gateway(), { body: over })).rejects.toThrow(
      /^plugin_egress_configuration_failed$/u
    );
  });
  it('propagates the caller abort signal to the outbound request', async () => {
    const controller = new AbortController();
    const g = gateway();
    await send(g, { signal: controller.signal });
    const outbound = must(g.fetcher.mock.calls[0])[0];
    expect(outbound.signal.aborted).toBe(false);
    const aborting = gateway(
      {},
      vi.fn(async (request: Request) => {
        controller.abort();
        return new Response(String(request.signal.aborted));
      })
    );
    await send(aborting, { signal: controller.signal });
    expect(must(aborting.fetcher.mock.calls[0])[0].signal.aborted).toBe(true);
  });
  it('derives each distinct key once and reuses it', async () => {
    await credential('notifier-plugin', 'header', 'X-One', 'headerOne', 'a');
    await credential('notifier-plugin', 'header', 'X-Two', 'headerTwo', 'b');
    const g = gateway();
    await send(g);
    const request = must(g.fetcher.mock.calls[0])[0];
    expect([request.headers.get('X-One'), request.headers.get('X-Two')]).toEqual(['a', 'b']);
  });
});

describe('Dynamic Worker installations', () => {
  it('reads rules and credentials of the pinned release and sends the request', async () => {
    await dynamic();
    await credential('plugin-a', 'bearer', 'Authorization', 'apiKey', 'dyn-secret');
    const g = gateway();
    await send(g);
    expect(must(g.fetcher.mock.calls[0])[0].headers.get('Authorization')).toBe('Bearer dyn-secret');
    const rules = must(
      g.calls.find(
        (c) =>
          c.kind === 'all' && c.sql.includes('plugin_runner_dynamic_worker_egress_allowed_hosts')
      )
    );
    expect(rules.values).toEqual(['plugin-a', VERSION_1, 101]);
    const credentials = must(
      g.calls.find(
        (c) => c.kind === 'all' && c.sql.includes('plugin_runner_dynamic_worker_credential_slots')
      )
    );
    expect(credentials.values).toEqual(['plugin-a', VERSION_1, 'installation-a', 1, HOST, 17]);
    expect(audit()).toMatchObject([{ result_code: 'http_200', credential_injected: 1 }]);
  });
  it('ignores a credential that no longer matches the release slot', async () => {
    await dynamic();
    await credential('plugin-a', 'header', 'X-Other', 'apiKey', 'dyn-secret');
    const g = gateway();
    await send(g);
    expect(must(g.fetcher.mock.calls[0])[0].headers.has('X-Other')).toBe(false);
  });
  it('refuses while the tenant gate is closed, without a pin or with a revoked release', async () => {
    await dynamic(false);
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_installation_unavailable$/u);
    database.exec(
      "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1)"
    );
    await expect(send(gateway())).resolves.toBeInstanceOf(Response);
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_installation_unavailable$/u);
    database.exec(
      "UPDATE plugin_runner_dynamic_worker_releases SET state = 'published'; UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'"
    );
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_installation_unavailable$/u);
    database.exec(
      "UPDATE plugin_runner_dynamic_worker_manifests SET state = 'active'; UPDATE plugin_runner_dynamic_worker_artifacts SET state = 'retired', activated_at = NULL"
    );
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_installation_unavailable$/u);
  });
  it('refuses more than sixteen credentials for the destination', async () => {
    await dynamic();
    await expect(
      send(
        gateway({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('credential_slots')
              ? { ...(value as object), results: Array.from({ length: 17 }, () => ({})) }
              : value,
        })
      )
    ).rejects.toThrow(/^plugin_egress_credential_limit_exceeded$/u);
  });
});

describe('rule and credential limits', () => {
  beforeEach(async () => {
    await builtin();
  });
  it('asks for at most 101 rules and reads from the primary', async () => {
    const g = gateway();
    await send(g);
    expect(
      must(
        g.calls.find(
          (c) => c.kind === 'all' && c.sql.includes('plugin_runner_egress_allowed_hosts')
        )
      ).values
    ).toEqual(['notifier-plugin', 101]);
    expect(g.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
  });
  it('does not treat a wildcard approval as an exact one because another exact rule exists', async () => {
    database.exec(
      "DELETE FROM plugin_runner_egress_allowed_hosts; INSERT INTO plugin_runner_egress_allowed_hosts (plugin_id, rule_id, match_kind, host_pattern, created_at) VALUES ('notifier-plugin', 'r1', 'exact', 'other.example.com', 1), ('notifier-plugin', 'r2', 'suffix_wildcard', '*.example.com', 1)"
    );
    const g = gateway();
    await expect(send(g)).rejects.toThrow(/^plugin_egress_wildcard_requires_controlled_proxy$/u);
    expect(g.fetcher).not.toHaveBeenCalled();
    await expect(send(gateway(), { url: 'https://other.example.com/x' })).resolves.toBeInstanceOf(
      Response
    );
  });
  it('injects exactly sixteen credentials and refuses a seventeenth', async () => {
    for (let index = 0; index < 16; index++) {
      await credential(
        'notifier-plugin',
        'header',
        `X-Key-${index}`,
        `headerKey${index}`,
        `value-${index}`,
        `${index.toString(16)}${index.toString(16)}`
      );
    }
    const g = gateway();
    await send(g);
    const request = must(g.fetcher.mock.calls[0])[0];
    expect(request.headers.get('X-Key-0')).toBe('value-0');
    expect(request.headers.get('X-Key-15')).toBe('value-15');
    await credential('notifier-plugin', 'header', 'X-Key-16', 'headerKey16', 'value-16', 'fe');
    await expect(send(gateway())).rejects.toThrow(/^plugin_egress_credential_limit_exceeded$/u);
  });
});

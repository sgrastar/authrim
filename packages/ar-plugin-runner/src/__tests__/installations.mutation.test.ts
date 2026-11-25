import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1PluginInstallationResolver } from '../installations';
import {
  basePolicy,
  seedArtifact,
  seedInstallation,
  seedPlugin,
  VERSION_1,
} from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function resolver(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { resolver: new D1PluginInstallationResolver(d1.db), calls: d1.calls };
}
const query = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-a',
  pluginInstallationId: 'dyn-installation',
  capability: 'notifier.send',
  ...over,
});
const LOOKUP = /^plugin_installation_lookup_invalid$/u;
const POLICY_LOOKUP = /^plugin_policy_lookup_invalid$/u;

const RESOURCE = {
  logicalResourceId: 'state',
  binding: 'PLUGIN_STATE',
  kind: 'd1',
  access: 'read_write',
};
const HOST_INTERFACE = {
  name: 'ACCOUNT_METADATA',
  interface: 'authrim.account_metadata.v1',
  scope: 'tenant',
};

function dynamicPolicy(
  capability: string,
  over: { timeout?: number; attempts?: number; budget?: number; failure?: string } = {}
) {
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_hook_policies (plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts, async_retry_budget_seconds, circuit_breaker_threshold, circuit_breaker_cooldown_seconds, updated_at) VALUES ('dyn-plugin', ?, ?, ?, ?, ?, ?, 5, 60, 1)`
    )
    .run(
      VERSION_1,
      capability,
      over.timeout ?? 900,
      over.failure ?? 'retry_async',
      over.attempts ?? 100,
      over.budget ?? 604_800
    );
}
async function dynamic(
  options: {
    policy?: unknown;
    gate?: boolean;
    capability?: string;
    state?: 'enabled' | 'disabled';
    caps?: [number, number];
    policyOver?: Parameters<typeof dynamicPolicy>[1];
  } = {}
) {
  seedPlugin(database, { pluginId: 'dyn-plugin', policy: options.policy ?? basePolicy() });
  dynamicPolicy(options.capability ?? 'notifier.send', options.policyOver);
  const id = await seedInstallation(database, {
    tenantId: 'tenant-a',
    pluginId: 'dyn-plugin',
    installationId: 'dyn-installation',
    state: options.state ?? 'enabled',
  });
  seedArtifact(database, id, VERSION_1, 'active', 'dyn-plugin');
  if (options.caps) {
    database.exec(
      `UPDATE plugin_runner_installations SET platform_concurrency_cap = ${options.caps[0]}, platform_rate_per_minute = ${options.caps[1]}`
    );
  }
  if (options.gate !== false) {
    database.exec(
      "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1)"
    );
  }
}
async function builtin(capability = 'notifier.send', failure = 'retry_async') {
  await seedInstallation(database, {
    installationId: 'builtin-installation',
    pluginId: 'builtin-plugin',
    backendKind: 'in_process',
    state: 'enabled',
  });
  database
    .prepare(
      `INSERT INTO plugin_runner_hook_policies (plugin_id, capability, timeout_ms, failure_policy, max_attempts, async_retry_budget_seconds, circuit_breaker_threshold, circuit_breaker_cooldown_seconds, updated_at) VALUES ('builtin-plugin', ?, 700, ?, 3, 120, 5, 60, 1)`
    )
    .run(capability, failure);
}
function resourceRow(over: Record<string, string> = {}) {
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_resources (installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name, host_binding_ref, resource_kind, access_mode, ownership_fingerprint, control_operation_id, state, updated_at) VALUES ('dyn-installation', 'tenant-a', 'dyn-plugin', ?, ?, ?, ?, ?, ?, 'op', 'active', 1)`
    )
    .run(
      over.logical ?? 'state',
      over.binding ?? 'PLUGIN_STATE',
      over.host ?? `PRES_D1_${'A'.repeat(24)}`,
      over.kind ?? 'd1',
      over.access ?? 'read_write',
      'a'.repeat(64)
    );
}

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('external gate', () => {
  it('reports the tenant gate as closed until it is opened', async () => {
    const { resolver: r } = resolver();
    await expect(r.isExternalGateOpen('tenant-a')).resolves.toBe(false);
    database.exec(
      "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1)"
    );
    await expect(r.isExternalGateOpen('tenant-a')).resolves.toBe(true);
    await expect(r.isExternalGateOpen('tenant-b')).resolves.toBe(false);
    database.exec('UPDATE plugin_runner_tenant_external_gates SET allowed = 0');
    await expect(r.isExternalGateOpen('tenant-a')).resolves.toBe(false);
  });
});

describe('resolveBackend', () => {
  it.each([
    ['an unsafe tenant', { tenantId: '' }],
    ['an unsafe installation', { pluginInstallationId: '-x' }],
    ['an unsafe capability', { capability: 'Notifier' }],
    ['a capability starting with a digit', { capability: '1x' }],
  ])('rejects %s', async (_label, over) => {
    const { resolver: r, calls } = resolver();
    await expect(r.resolveBackend(query(over))).rejects.toThrow(LOOKUP);
    expect(calls).toEqual([]);
  });
  it('resolves a pinned external installation with the policy timeout', async () => {
    await dynamic();
    await expect(resolver().resolver.resolveBackend(query())).resolves.toEqual({
      pluginId: 'dyn-plugin',
      backendKind: 'dynamic_worker',
      timeoutMs: 900,
    });
  });
  it('resolves a built-in installation regardless of the tenant gate', async () => {
    await builtin();
    await expect(
      resolver().resolver.resolveBackend(query({ pluginInstallationId: 'builtin-installation' }))
    ).resolves.toEqual({ pluginId: 'builtin-plugin', backendKind: 'in_process', timeoutMs: 700 });
  });
  it('binds the capability twice, then the installation and tenant', async () => {
    await dynamic();
    const { resolver: r, calls } = resolver();
    await r.resolveBackend(query());
    expect(calls.find((c) => c.kind === 'first')?.values).toEqual([
      'notifier.send',
      'notifier.send',
      'dyn-installation',
      'tenant-a',
    ]);
  });
  it.each([
    ['a disabled installation', () => dynamic({ state: 'disabled' })],
    ['a closed gate', () => dynamic({ gate: false })],
    ['another capability', () => dynamic({ capability: 'other.cap' })],
  ])('finds nothing for %s', async (_label, arrange) => {
    await arrange();
    await expect(resolver().resolver.resolveBackend(query())).resolves.toBeNull();
  });
  it('finds nothing for another tenant or a missing installation', async () => {
    await dynamic();
    await expect(
      resolver().resolver.resolveBackend(query({ tenantId: 'tenant-b' }))
    ).resolves.toBeNull();
    await expect(
      resolver().resolver.resolveBackend(query({ pluginInstallationId: 'none' }))
    ).resolves.toBeNull();
  });
  it.each([
    ['an unsafe plugin id', { plugin_id: 'Bad Plugin' }],
    ['an unknown backend kind', { backend_kind: 'wasm' }],
  ])('finds nothing for a stored row with %s', async (_label, patch) => {
    await dynamic();
    await expect(
      resolver({
        rewrite: (call, value) => (call.kind === 'first' && value ? { ...value, ...patch } : value),
      }).resolver.resolveBackend(query())
    ).resolves.toBeNull();
  });
  it.each([0, 30_001, 'x', 1.5])('refuses a timeout of %j', async (timeout) => {
    await dynamic();
    await expect(
      resolver({
        rewrite: (call, value) =>
          call.kind === 'first' && value ? { ...value, timeout_ms: timeout } : value,
      }).resolver.resolveBackend(query())
    ).rejects.toThrow(/^plugin_installation_timeout_invalid$/u);
  });
  it.each([1, 30_000])('accepts a timeout of %i ms', async (timeout) => {
    await dynamic({ policyOver: { timeout } });
    await expect(resolver().resolver.resolveBackend(query())).resolves.toMatchObject({
      timeoutMs: timeout,
    });
  });
});

describe('resolve', () => {
  it('resolves the pinned release with its code reference and an empty resource map', async () => {
    await dynamic();
    await expect(resolver().resolver.resolve(query())).resolves.toEqual({
      pluginId: 'dyn-plugin',
      scriptName: 'dyn-plugin',
      codeObjectKey: `plugins/dyn-plugin/${VERSION_1}.json`,
      codeSha256: 'b'.repeat(64),
      timeoutMs: 900,
      hostInterfaces: [],
      resources: [],
    });
  });
  it('returns the declared host interfaces and the provisioned resources', async () => {
    await dynamic({
      policy: basePolicy({
        hostInterfaces: [HOST_INTERFACE],
        resources: [
          { ...RESOURCE, provisioning: { defaultMode: 'managed', allowExisting: false } },
        ],
      }),
    });
    resourceRow();
    await expect(resolver().resolver.resolve(query())).resolves.toMatchObject({
      hostInterfaces: [HOST_INTERFACE],
      resources: [
        {
          logicalResourceId: 'state',
          binding: 'PLUGIN_STATE',
          hostBindingRef: `PRES_D1_${'A'.repeat(24)}`,
          kind: 'd1',
          access: 'read_write',
          ownershipFingerprint: 'a'.repeat(64),
        },
      ],
    });
  });
  it.each([
    ['an unsafe tenant', { tenantId: ' ' }],
    ['an unsafe installation', { pluginInstallationId: '' }],
    ['an unsafe capability', { capability: 'X' }],
  ])('rejects %s', async (_label, over) => {
    await expect(resolver().resolver.resolve(query(over))).rejects.toThrow(LOOKUP);
  });
  it.each([
    ['a disabled installation', () => dynamic({ state: 'disabled' })],
    ['a closed gate', () => dynamic({ gate: false })],
    ['a capability without a policy', () => dynamic({ capability: 'other.cap' })],
  ])('finds nothing for %s', async (_label, arrange) => {
    await arrange();
    await expect(resolver().resolver.resolve(query())).resolves.toBeNull();
  });
  it('finds nothing for a withdrawn manifest or a revoked release', async () => {
    await dynamic();
    database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'");
    await expect(resolver().resolver.resolve(query())).resolves.toBeNull();
    database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'active'");
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
    await expect(resolver().resolver.resolve(query())).resolves.toBeNull();
  });
  it('does not resolve a built-in installation', async () => {
    await builtin();
    await expect(
      resolver().resolver.resolve(query({ pluginInstallationId: 'builtin-installation' }))
    ).resolves.toBeNull();
  });
  it.each([
    ['an unsafe plugin id', { plugin_id: 'Bad Plugin' }],
    ['an unsafe script', { script_name: 'Bad Script' }],
    ['a missing code key', { code_object_key: null }],
    ['a missing digest', { code_sha256: null }],
  ])('refuses a stored row with %s', async (_label, patch) => {
    await dynamic();
    await expect(
      resolver({
        rewrite: (call, value) => (call.kind === 'first' && value ? { ...value, ...patch } : value),
      }).resolver.resolve(query())
    ).rejects.toThrow(/^plugin_installation_script_invalid$/u);
  });
  it.each([
    ['text that is not JSON', '{nope'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    [
      'a policy with invalid host interfaces',
      JSON.stringify({ hostInterfaces: 'x', resources: [] }),
    ],
  ])('refuses a policy that is %s', async (_label, policy) => {
    await dynamic();
    await expect(
      resolver({
        rewrite: (call, value) =>
          call.kind === 'first' && value ? { ...value, policy_json: policy } : value,
      }).resolver.resolve(query())
    ).rejects.toThrow(/^plugin_installation_host_interface_invalid$/u);
  });
  it.each([0, 30_001, 'x'])('refuses a timeout of %j', async (timeout) => {
    await dynamic();
    await expect(
      resolver({
        rewrite: (call, value) =>
          call.kind === 'first' && value ? { ...value, timeout_ms: timeout } : value,
      }).resolver.resolve(query())
    ).rejects.toThrow(/^plugin_installation_timeout_invalid$/u);
  });
  describe('resource map', () => {
    const declared = () =>
      dynamic({
        policy: basePolicy({
          resources: [
            { ...RESOURCE, provisioning: { defaultMode: 'managed', allowExisting: false } },
          ],
        }),
      });
    const INVALID = /^plugin_installation_resource_invalid$/u;
    it('refuses a declared resource that was not provisioned', async () => {
      await declared();
      await expect(resolver().resolver.resolve(query())).rejects.toThrow(INVALID);
    });
    it('refuses a provisioned resource that the manifest does not declare', async () => {
      await dynamic();
      resourceRow();
      await expect(resolver().resolver.resolve(query())).rejects.toThrow(INVALID);
    });
    it.each([
      ['another logical id', { logical_resource_id: 'other' }],
      ['another binding', { logical_binding_name: 'OTHER' }],
      ['another kind', { resource_kind: 'kv_namespace' }],
      ['another access', { access_mode: 'read_only' }],
      ['another plugin', { plugin_id: 'other-plugin' }],
      ['a lowercase binding', { logical_binding_name: 'plugin_state' }],
      ['a malformed host reference', { host_binding_ref: 'PRES_D1_short' }],
      ['a host reference of another kind', { host_binding_ref: `PRES_KV_${'A'.repeat(24)}` }],
      ['an unknown kind', { resource_kind: 'queue' }],
      ['a malformed fingerprint', { ownership_fingerprint: 'zz' }],
    ])('refuses a stored resource with %s', async (_label, patch) => {
      await declared();
      resourceRow();
      await expect(
        resolver({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('plugin_runner_dynamic_worker_resources')
              ? {
                  ...(value as { results: object[] }),
                  results: (value as { results: object[] }).results.map((row) => ({
                    ...row,
                    ...patch,
                  })),
                }
              : value,
        }).resolver.resolve(query())
      ).rejects.toThrow(INVALID);
    });
    it('refuses a resource map that repeats a binding or a host reference', async () => {
      const second = {
        ...RESOURCE,
        logicalResourceId: 'cache',
        binding: 'PLUGIN_CACHE',
        kind: 'kv_namespace',
        access: 'read_only',
      };
      await dynamic({
        policy: basePolicy({
          resources: [RESOURCE, second].map((resource) => ({
            ...resource,
            provisioning: { defaultMode: 'managed', allowExisting: false },
          })),
        }),
      });
      resourceRow();
      resourceRow({
        logical: 'cache',
        binding: 'PLUGIN_CACHE',
        host: `PRES_KV_${'B'.repeat(24)}`,
        kind: 'kv_namespace',
        access: 'read_only',
      });
      const first = {
        plugin_id: 'dyn-plugin',
        logical_resource_id: 'state',
        logical_binding_name: 'PLUGIN_STATE',
        host_binding_ref: `PRES_D1_${'A'.repeat(24)}`,
        resource_kind: 'd1',
        access_mode: 'read_write',
        ownership_fingerprint: 'a'.repeat(64),
      };
      const cache = {
        ...first,
        logical_resource_id: 'cache',
        logical_binding_name: 'PLUGIN_CACHE',
        host_binding_ref: `PRES_KV_${'B'.repeat(24)}`,
        resource_kind: 'kv_namespace',
        access_mode: 'read_only',
      };
      const withRows = (results: object[]) =>
        resolver({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('plugin_runner_dynamic_worker_resources')
              ? { ...(value as object), results }
              : value,
        }).resolver.resolve(query());
      await expect(withRows([first, cache])).resolves.toMatchObject({
        resources: [{ logicalResourceId: 'state' }, { logicalResourceId: 'cache' }],
      });
      await expect(withRows([first, first])).rejects.toThrow(INVALID);
      await expect(withRows([first, { ...cache, logical_resource_id: 'state' }])).rejects.toThrow(
        INVALID
      );
    });
    it('refuses two resources that share a host reference', async () => {
      const kv = (logicalResourceId: string, binding: string) => ({
        logicalResourceId,
        binding,
        kind: 'kv_namespace',
        access: 'read_only',
        provisioning: { defaultMode: 'managed', allowExisting: false },
      });
      await dynamic({
        policy: basePolicy({ resources: [kv('one', 'KV_ONE'), kv('two', 'KV_TWO')] }),
      });
      const row = (logical: string, binding: string) => ({
        plugin_id: 'dyn-plugin',
        logical_resource_id: logical,
        logical_binding_name: binding,
        host_binding_ref: `PRES_KV_${'C'.repeat(24)}`,
        resource_kind: 'kv_namespace',
        access_mode: 'read_only',
        ownership_fingerprint: 'a'.repeat(64),
      });
      await expect(
        resolver({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('plugin_runner_dynamic_worker_resources')
              ? { ...(value as object), results: [row('one', 'KV_ONE'), row('two', 'KV_TWO')] }
              : value,
        }).resolver.resolve(query())
      ).rejects.toThrow(INVALID);
    });
    it('refuses more than sixteen resources', async () => {
      await dynamic();
      await expect(
        resolver({
          rewrite: (call, value) =>
            call.kind === 'all' && call.sql.includes('plugin_runner_dynamic_worker_resources')
              ? { ...(value as object), results: Array.from({ length: 17 }, () => ({})) }
              : value,
        }).resolver.resolve(query())
      ).rejects.toThrow(INVALID);
    });
    it('ignores resources that are disabled or belong to another tenant', async () => {
      await dynamic();
      resourceRow();
      database.exec("UPDATE plugin_runner_dynamic_worker_resources SET state = 'disabled'");
      await expect(resolver().resolver.resolve(query())).resolves.toMatchObject({ resources: [] });
    });
  });
});

describe('resolveDispatchPolicy', () => {
  it.each([
    ['an unsafe tenant', { tenantId: '' }],
    ['an unsafe installation', { pluginInstallationId: '-x' }],
    ['an unsafe capability', { capability: '9' }],
  ])('rejects %s', async (_label, over) => {
    await expect(resolver().resolver.resolveDispatchPolicy(query(over))).rejects.toThrow(
      POLICY_LOOKUP
    );
  });
  it.each([
    [
      'notifier.send',
      { concurrencyCap: 8, ratePerMinute: 120, maxAttempts: 12, retryBudgetSeconds: 604_800 },
    ],
    [
      'webhook.deliver',
      { concurrencyCap: 4, ratePerMinute: 60, maxAttempts: 10, retryBudgetSeconds: 259_200 },
    ],
    [
      'hook.account.lifecycle',
      { concurrencyCap: 2, ratePerMinute: 30, maxAttempts: 8, retryBudgetSeconds: 86_400 },
    ],
  ])('caps the %s policy at its family defaults', async (capability, expected) => {
    await dynamic({
      capability,
      caps: [32, 10_000],
      policyOver: { attempts: 100, budget: 604_800 },
    });
    await expect(resolver().resolver.resolveDispatchPolicy(query({ capability }))).resolves.toEqual(
      { pluginId: 'dyn-plugin', ...expected }
    );
  });
  it('uses the stored values when they are lower than the defaults', async () => {
    await dynamic({ caps: [1, 5], policyOver: { attempts: 2, budget: 60 } });
    await expect(resolver().resolver.resolveDispatchPolicy(query())).resolves.toEqual({
      pluginId: 'dyn-plugin',
      concurrencyCap: 1,
      ratePerMinute: 5,
      maxAttempts: 2,
      retryBudgetSeconds: 60,
    });
  });
  it('resolves a built-in installation too', async () => {
    await builtin();
    await expect(
      resolver().resolver.resolveDispatchPolicy(
        query({ pluginInstallationId: 'builtin-installation' })
      )
    ).resolves.toMatchObject({
      pluginId: 'builtin-plugin',
      maxAttempts: 3,
      retryBudgetSeconds: 120,
    });
  });
  it('binds the capability twice, then the installation and tenant', async () => {
    await dynamic();
    const { resolver: r, calls } = resolver();
    await r.resolveDispatchPolicy(query());
    expect(calls.find((c) => c.kind === 'first')?.values).toEqual([
      'notifier.send',
      'notifier.send',
      'dyn-installation',
      'tenant-a',
    ]);
  });
  it('asks to retry while an enabled external installation has no gate row at all', async () => {
    await dynamic({ gate: false });
    await expect(resolver().resolver.resolveDispatchPolicy(query())).rejects.toThrow(
      /^plugin_gate_uninitialized$/u
    );
  });
  it('treats a closed gate as an unavailable policy, not as an uninitialised one', async () => {
    await dynamic({ gate: false });
    database.exec(
      "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 0, 1, 1)"
    );
    await expect(resolver().resolver.resolveDispatchPolicy(query())).rejects.toThrow(
      /^plugin_policy_unavailable$/u
    );
  });
  it('does not report an uninitialised gate for a disabled installation, another tenant or a built-in one', async () => {
    await dynamic({ gate: false, state: 'disabled' });
    await expect(resolver().resolver.resolveDispatchPolicy(query())).rejects.toThrow(
      /^plugin_policy_unavailable$/u
    );
    await expect(
      resolver().resolver.resolveDispatchPolicy(query({ tenantId: 'tenant-b' }))
    ).rejects.toThrow(/^plugin_policy_unavailable$/u);
  });
  it.each([
    ['a capability without a policy', () => dynamic({ capability: 'other.cap' })],
    ['a policy that is not retry_async', () => dynamic({ policyOver: { failure: 'fail_closed' } })],
    [
      'a built-in policy that is not retry_async',
      async () => {
        await builtin('notifier.send', 'fail_open');
      },
    ],
  ])('is unavailable for %s', async (_label, arrange) => {
    await arrange();
    const id = _label.startsWith('a built-in') ? 'builtin-installation' : 'dyn-installation';
    await expect(
      resolver().resolver.resolveDispatchPolicy(query({ pluginInstallationId: id }))
    ).rejects.toThrow(/^plugin_policy_unavailable$/u);
  });
  it('is unavailable for a stored row with an unsafe plugin id', async () => {
    await dynamic();
    await expect(
      resolver({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('platform_rate_per_minute') && value
            ? { ...value, plugin_id: 'bad id' }
            : value,
      }).resolver.resolveDispatchPolicy(query())
    ).rejects.toThrow(/^plugin_policy_unavailable$/u);
  });
  it.each([
    ['max_attempts', 0, 'plugin_policy_max_attempts_invalid'],
    ['max_attempts', 101, 'plugin_policy_max_attempts_invalid'],
    ['async_retry_budget_seconds', 59, 'plugin_policy_retry_budget_invalid'],
    ['async_retry_budget_seconds', 604_801, 'plugin_policy_retry_budget_invalid'],
    ['platform_concurrency_cap', 0, 'plugin_policy_concurrency_invalid'],
    ['platform_concurrency_cap', 33, 'plugin_policy_concurrency_invalid'],
    ['platform_rate_per_minute', 0, 'plugin_policy_rate_invalid'],
    ['platform_rate_per_minute', 10_001, 'plugin_policy_rate_invalid'],
    ['platform_rate_per_minute', 'x', 'plugin_policy_rate_invalid'],
  ])('refuses %s of %j', async (column, value, code) => {
    await dynamic();
    await expect(
      resolver({
        rewrite: (call, v) =>
          call.kind === 'first' && call.sql.includes('platform_rate_per_minute') && v
            ? { ...v, [column]: value }
            : v,
      }).resolver.resolveDispatchPolicy(query())
    ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });
  it('accepts the extreme stored values', async () => {
    await dynamic();
    for (const patch of [
      {
        max_attempts: 1,
        async_retry_budget_seconds: 60,
        platform_concurrency_cap: 1,
        platform_rate_per_minute: 1,
      },
      {
        max_attempts: 100,
        async_retry_budget_seconds: 604_800,
        platform_concurrency_cap: 32,
        platform_rate_per_minute: 10_000,
      },
    ]) {
      await expect(
        resolver({
          rewrite: (call, v) =>
            call.kind === 'first' && call.sql.includes('platform_rate_per_minute') && v
              ? { ...v, ...patch }
              : v,
        }).resolver.resolveDispatchPolicy(query())
      ).resolves.toBeTruthy();
    }
  });
});

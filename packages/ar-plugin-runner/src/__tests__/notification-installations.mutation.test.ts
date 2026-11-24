import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { D1NotificationInstallationStore } from '../notification-installations';
import { rows } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const INVALID = /^plugin_notification_installation_input_invalid$/u;
const REFLECTION = /^plugin_notification_installation_reflection_invalid$/u;
const BATCH = /^plugin_notification_installation_batch_failed$/u;
let database: DatabaseSync;

function store(options: D1Options = {}, now = 1_000) {
  const d1 = createD1(database, options);
  return { store: new D1NotificationInstallationStore(d1.db, () => now), calls: d1.calls };
}
const resend = (over: Record<string, unknown> = {}) => ({
  installationId: 'notifier-resend-tenant-a',
  tenantId: 'tenant-a',
  pluginId: 'notifier-resend',
  backendKind: 'in_process',
  enabled: true,
  ...over,
});
const dynamic = (over: Record<string, unknown> = {}) => ({
  installationId: 'custom-tenant-a',
  tenantId: 'tenant-a',
  pluginId: 'custom-notifier',
  backendKind: 'dynamic_worker',
  scriptName: 'custom-notifier',
  enabled: true,
  ...over,
});
const installationRows = () =>
  rows<Record<string, unknown>>(database, 'SELECT * FROM plugin_runner_installations');

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('input', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', resend({ extra: 1 })],
    ['a missing key', resend({ enabled: undefined })],
    ['an unsafe installation', resend({ installationId: '-x' })],
    ['a numeric installation', resend({ installationId: 5 })],
    ['an unsafe tenant', resend({ tenantId: '' })],
    ['a numeric tenant', resend({ tenantId: 5 })],
    ['an unsafe plugin', resend({ pluginId: 'a b' })],
    ['a numeric plugin', resend({ pluginId: 5 })],
    ['a textual enabled flag', resend({ enabled: 'true' })],
    ['an unknown backend', resend({ backendKind: 'wasm' })],
    [
      'a built-in plugin as a dynamic worker',
      resend({ backendKind: 'dynamic_worker', scriptName: 'notifier-resend' }),
    ],
    ['a built-in plugin carrying a script', resend({ scriptName: 'x' })],
    [
      'a custom plugin as an in-process one',
      dynamic({ backendKind: 'in_process', scriptName: undefined }),
    ],
    ['a dynamic plugin without a script', dynamic({ scriptName: undefined })],
    ['a dynamic plugin with an unsafe script', dynamic({ scriptName: 'Bad Script' })],
    ['a dynamic plugin with a numeric script', dynamic({ scriptName: 5 })],
    ['a dynamic plugin with an empty script', dynamic({ scriptName: '' })],
    ['a dynamic plugin with an over-long script', dynamic({ scriptName: 'a'.repeat(129) })],
  ])('rejects %s', async (_label, input) => {
    await expect(store().store.configure(input)).rejects.toThrow(INVALID);
    expect(installationRows()).toEqual([]);
  });
  it('accepts the built-in Cloudflare notifier and a script of 128 characters', async () => {
    await expect(
      store().store.configure(resend({ pluginId: 'notifier-cloudflare', installationId: 'cf' }))
    ).resolves.toMatchObject({ pluginId: 'notifier-cloudflare' });
    await expect(
      store().store.configure(
        dynamic({ scriptName: 'a'.repeat(128), installationId: 'long', pluginId: 'other-notifier' })
      )
    ).resolves.toMatchObject({ pluginId: 'other-notifier' });
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses a clock value of %s', async (now) => {
    await expect(store({}, now).store.configure(resend())).rejects.toThrow(
      /^plugin_notification_installation_now_invalid$/u
    );
    expect(installationRows()).toEqual([]);
  });
  it('needs the sessions API', async () => {
    await expect(store({ withoutSession: true }).store.configure(resend())).rejects.toThrow(
      /^plugin_notification_installation_d1_session_required$/u
    );
  });
});

describe('configuration', () => {
  it('creates an enabled built-in installation with its fixed policy and the Resend host', async () => {
    await expect(store().store.configure(resend())).resolves.toEqual({
      installationId: 'notifier-resend-tenant-a',
      tenantId: 'tenant-a',
      pluginId: 'notifier-resend',
      state: 'enabled',
      configVersion: 1,
    });
    expect(installationRows()).toMatchObject([
      {
        installation_id: 'notifier-resend-tenant-a',
        tenant_id: 'tenant-a',
        plugin_id: 'notifier-resend',
        backend_kind: 'in_process',
        script_name: null,
        state: 'enabled',
        config_version: 1,
        platform_concurrency_cap: 8,
        platform_rate_per_minute: 120,
        created_at: 1_000,
        updated_at: 1_000,
      },
    ]);
    expect(rows(database, 'SELECT * FROM plugin_runner_hook_policies')).toEqual([
      {
        plugin_id: 'notifier-resend',
        capability: 'notifier.send',
        timeout_ms: 30_000,
        failure_policy: 'retry_async',
        max_attempts: 12,
        async_retry_budget_seconds: 604_800,
        circuit_breaker_threshold: 5,
        circuit_breaker_cooldown_seconds: 60,
        updated_at: 1_000,
      },
    ]);
    expect(rows(database, 'SELECT * FROM plugin_runner_egress_allowed_hosts')).toEqual([
      {
        plugin_id: 'notifier-resend',
        rule_id: 'resend-api',
        match_kind: 'exact',
        host_pattern: 'api.resend.com',
        created_at: 1_000,
      },
    ]);
  });
  it('approves no external host for the Cloudflare notifier', async () => {
    await store().store.configure(
      resend({ pluginId: 'notifier-cloudflare', installationId: 'cf' })
    );
    expect(rows(database, 'SELECT * FROM plugin_runner_egress_allowed_hosts')).toEqual([]);
  });
  it('records a Dynamic Worker notifier with its script', async () => {
    await expect(store().store.configure(dynamic({ enabled: false }))).resolves.toMatchObject({
      state: 'disabled',
      pluginId: 'custom-notifier',
    });
    expect(installationRows()).toMatchObject([
      { backend_kind: 'dynamic_worker', script_name: 'custom-notifier', state: 'disabled' },
    ]);
    expect(rows(database, 'SELECT * FROM plugin_runner_egress_allowed_hosts')).toEqual([]);
  });
  it('toggles the installation and keeps its creation time, config version and policy', async () => {
    await store().store.configure(resend());
    await expect(
      store({}, 2_000).store.configure(resend({ enabled: false }))
    ).resolves.toMatchObject({ state: 'disabled', configVersion: 1 });
    expect(installationRows()).toMatchObject([
      { state: 'disabled', created_at: 1_000, updated_at: 2_000 },
    ]);
    expect(rows(database, 'SELECT updated_at FROM plugin_runner_hook_policies')).toEqual([
      { updated_at: 2_000 },
    ]);
  });
  it('keeps the config version a credential replacement advanced', async () => {
    await store().store.configure(resend());
    database.exec('UPDATE plugin_runner_installations SET config_version = 4');
    await expect(store().store.configure(resend({ enabled: false }))).resolves.toMatchObject({
      configVersion: 4,
    });
  });
  it('moves an installation between backends only for its own tenant and plugin', async () => {
    await store().store.configure(resend());
    await expect(store().store.configure(resend({ tenantId: 'tenant-b' }))).rejects.toThrow(BATCH);
    await expect(
      store().store.configure(resend({ pluginId: 'notifier-cloudflare' }))
    ).rejects.toThrow(BATCH);
    expect(installationRows()).toMatchObject([
      { tenant_id: 'tenant-a', plugin_id: 'notifier-resend', state: 'enabled' },
    ]);
  });
  it('binds the installation, tenant, plugin and backend in order', async () => {
    const { store: s, calls } = store();
    await s.configure(dynamic());
    const batch = calls.find((c) => c.kind === 'batch');
    expect(batch?.values.slice(0, 8)).toEqual([
      'custom-tenant-a',
      'tenant-a',
      'custom-notifier',
      'dynamic_worker',
      'custom-notifier',
      'enabled',
      1_000,
      1_000,
    ]);
  });
  it('adopts a batch that committed although its response was lost', async () => {
    await expect(
      store({
        afterBatch: () => {
          throw new Error('lost');
        },
      }).store.configure(resend())
    ).resolves.toMatchObject({ state: 'enabled' });
  });
  it('surfaces the storage error of a failed batch when nothing was reflected', async () => {
    await expect(
      store({
        intercept: (call) => {
          if (call.kind === 'batch') throw new Error('d1 down');
          return undefined;
        },
      }).store.configure(resend())
    ).rejects.toThrow(/^d1 down$/u);
    await expect(
      store({
        intercept: (call) => {
          if (call.kind === 'batch') throw 'opaque' as unknown as Error;
          return undefined;
        },
      }).store.configure(resend())
    ).rejects.toThrow(BATCH);
  });
  it.each([
    ['a short batch', [{ success: true, results: [], meta: { changes: 1 } }]],
    [
      'an unsuccessful statement',
      [1, 2, 3].map((i) => ({ success: i !== 2, results: [], meta: { changes: 1 } })),
    ],
    [
      'a statement error',
      [1, 2, 3].map((i) => ({
        success: true,
        error: i === 3 ? 'x' : undefined,
        results: [],
        meta: { changes: 1 },
      })),
    ],
    [
      'an unchanged statement',
      [1, 2, 3].map((i) => ({ success: true, results: [], meta: { changes: i === 1 ? 0 : 1 } })),
    ],
    [
      'a statement without a count',
      [1, 2, 3].map((i) => ({ success: true, results: [], meta: i === 1 ? {} : { changes: 1 } })),
    ],
  ])('reports %s as a failed batch when nothing was reflected', async (_label, results) => {
    await expect(
      store({
        intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
      }).store.configure(resend())
    ).rejects.toThrow(BATCH);
  });
  describe('reflection', () => {
    const reflect = (
      patch: Record<string, unknown>,
      target: 'installation' | 'policy' | 'egress'
    ) =>
      store({
        rewrite: (call, value) => {
          const matches =
            target === 'installation'
              ? call.sql.includes(
                  'config_version\n             FROM plugin_runner_installations'
                ) ||
                call.sql.includes(
                  'FROM plugin_runner_installations\n            WHERE installation_id'
                )
              : target === 'policy'
                ? call.sql.includes('FROM plugin_runner_hook_policies')
                : call.sql.includes('FROM plugin_runner_egress_allowed_hosts');
          return call.kind === 'first' && matches && value ? { ...value, ...patch } : value;
        },
      }).store.configure(resend());
    it.each([
      ['another backend', { backend_kind: 'dynamic_worker' }],
      ['a script name', { script_name: 'x' }],
      ['another state', { state: 'disabled' }],
      ['a zero config version', { config_version: 0 }],
      ['a textual config version', { config_version: 'x' }],
    ])('rejects an installation with %s', async (_label, patch) => {
      await expect(reflect(patch, 'installation')).rejects.toThrow(REFLECTION);
    });
    it.each([
      ['another timeout', { timeout_ms: 29_999 }],
      ['another failure policy', { failure_policy: 'fail_closed' }],
      ['other attempts', { max_attempts: 11 }],
      ['another retry budget', { async_retry_budget_seconds: 604_799 }],
      ['another threshold', { circuit_breaker_threshold: 4 }],
      ['another cooldown', { circuit_breaker_cooldown_seconds: 61 }],
    ])('rejects a policy with %s', async (_label, patch) => {
      await expect(reflect(patch, 'policy')).rejects.toThrow(REFLECTION);
    });
    it.each([
      ['another match kind', { match_kind: 'suffix_wildcard' }],
      ['another host', { host_pattern: 'evil.example.com' }],
    ])('rejects an egress rule with %s', async (_label, patch) => {
      await expect(reflect(patch, 'egress')).rejects.toThrow(REFLECTION);
    });
    it('rejects a missing policy or egress rule', async () => {
      await expect(
        store({
          rewrite: (call, value) =>
            call.kind === 'first' && call.sql.includes('FROM plugin_runner_hook_policies')
              ? null
              : value,
        }).store.configure(resend())
      ).rejects.toThrow(REFLECTION);
      await expect(
        store({
          rewrite: (call, value) =>
            call.kind === 'first' && call.sql.includes('FROM plugin_runner_egress_allowed_hosts')
              ? null
              : value,
        }).store.configure(resend())
      ).rejects.toThrow(REFLECTION);
    });
    it('rejects a missing installation', async () => {
      await expect(
        store({
          rewrite: (call, value) =>
            call.kind === 'first' && call.sql.includes('FROM plugin_runner_installations')
              ? null
              : value,
        }).store.configure(resend())
      ).rejects.toThrow(REFLECTION);
    });
  });
});

describe('identifier, clock and session edges', () => {
  it.each([
    ['an installation id with trailing text', resend({ installationId: 'a b' })],
    ['a tenant id with trailing text', resend({ tenantId: 'a b' })],
    ['a plugin id with trailing text', resend({ pluginId: 'notifier-resend x' })],
  ])('rejects %s', async (_label, input) => {
    await expect(store().store.configure(input)).rejects.toThrow(INVALID);
    expect(installationRows()).toEqual([]);
  });
  it('accepts the smallest clock value', async () => {
    await expect(store({}, 1).store.configure(resend())).resolves.toMatchObject({
      state: 'enabled',
    });
    expect(installationRows()).toMatchObject([{ created_at: 1 }]);
  });
  it('reads from the primary and defaults the clock to seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_111_900);
    try {
      const d1 = createD1(database);
      await new D1NotificationInstallationStore(d1.db).configure(resend());
      expect(d1.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
      expect(installationRows()).toMatchObject([{ created_at: 1_700_000_111 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

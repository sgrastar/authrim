import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1NotificationProviderOrderStore } from '../notification-provider-order';
import { rows, seedInstallation } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const INVALID = /^plugin_notification_provider_order_input_invalid$/u;
const REFLECTION = /^plugin_notification_provider_order_reflection_invalid$/u;
let database: DatabaseSync;

function store(options: D1Options = {}, now = 1_000) {
  const d1 = createD1(database, options);
  return { store: new D1NotificationProviderOrderStore(d1.db, () => now), calls: d1.calls };
}
const order = (over: Record<string, unknown> = {}) => ({
  operationId: 'operation-1',
  tenantId: 'tenant-a',
  channel: 'email',
  expectedConfigVersion: 0,
  installationIds: ['provider-a', 'provider-b'],
  ...over,
});
const routeRows = () =>
  rows<Record<string, unknown>>(database, 'SELECT * FROM plugin_runner_notification_route_sets');
const entryRows = () =>
  rows<Record<string, unknown>>(
    database,
    'SELECT tenant_id, channel, config_version, priority, installation_id, created_at FROM plugin_runner_notification_route_entries ORDER BY priority'
  );

beforeEach(async () => {
  database = openRunnerDatabase();
  for (const [id, tenant, state] of [
    ['provider-a', 'tenant-a', 'enabled'],
    ['provider-b', 'tenant-a', 'enabled'],
    ['provider-c', 'tenant-a', 'enabled'],
    ['provider-x', 'tenant-b', 'enabled'],
    ['provider-off', 'tenant-a', 'disabled'],
  ] as const) {
    await seedInstallation(database, {
      installationId: id,
      tenantId: tenant,
      pluginId: id,
      backendKind: 'in_process',
      state,
    });
  }
});

describe('input', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', order({ extra: 1 })],
    ['a missing key', order({ channel: undefined })],
    ['an unsafe operation', order({ operationId: '-x' })],
    ['an unsafe tenant', order({ tenantId: '' })],
    ['an unknown channel', order({ channel: 'fax' })],
    ['a negative expected version', order({ expectedConfigVersion: -1 })],
    ['a fractional expected version', order({ expectedConfigVersion: 0.5 })],
    ['a textual expected version', order({ expectedConfigVersion: '0' })],
    ['non-array installations', order({ installationIds: 'provider-a' })],
    [
      'nine installations',
      order({ installationIds: Array.from({ length: 9 }, (_, i) => `p${i}`) }),
    ],
    ['a numeric installation', order({ installationIds: [5] })],
    ['an unsafe installation', order({ installationIds: ['-x'] })],
    ['duplicate installations', order({ installationIds: ['provider-a', 'provider-a'] })],
  ])('rejects %s', async (_label, input) => {
    await expect(store().store.replace(input)).rejects.toThrow(INVALID);
    expect(routeRows()).toEqual([]);
  });
  it.each(['email', 'sms', 'push'])('accepts the %s channel', async (channel) => {
    await expect(
      store().store.replace(order({ channel, installationIds: [] }))
    ).resolves.toMatchObject({ channel, state: 'disabled' });
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses a clock value of %s', async (now) => {
    await expect(store({}, now).store.replace(order())).rejects.toThrow(
      /^plugin_notification_provider_order_now_invalid$/u
    );
  });
  it('needs the sessions API', async () => {
    await expect(store({ withoutSession: true }).store.replace(order())).rejects.toThrow(
      /^plugin_notification_provider_order_d1_session_required$/u
    );
    await expect(
      store({ withoutSession: true }).store.resolve({ tenantId: 'tenant-a', channel: 'email' })
    ).rejects.toThrow(/^plugin_notification_provider_order_d1_session_required$/u);
  });
});

describe('replace', () => {
  it('creates the first order at version one, in priority order', async () => {
    await expect(store().store.replace(order())).resolves.toEqual({
      tenantId: 'tenant-a',
      channel: 'email',
      configVersion: 1,
      state: 'enabled',
      installationIds: ['provider-a', 'provider-b'],
    });
    expect(routeRows()).toMatchObject([
      {
        tenant_id: 'tenant-a',
        channel: 'email',
        config_version: 1,
        state: 'enabled',
        last_operation_id: 'operation-1',
        order_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
        created_at: 1_000,
        updated_at: 1_000,
      },
    ]);
    expect(entryRows()).toEqual([
      {
        tenant_id: 'tenant-a',
        channel: 'email',
        config_version: 1,
        priority: 0,
        installation_id: 'provider-a',
        created_at: 1_000,
      },
      {
        tenant_id: 'tenant-a',
        channel: 'email',
        config_version: 1,
        priority: 1,
        installation_id: 'provider-b',
        created_at: 1_000,
      },
    ]);
  });
  it('stores an empty order as disabled without entries', async () => {
    await expect(store().store.replace(order({ installationIds: [] }))).resolves.toMatchObject({
      state: 'disabled',
      installationIds: [],
    });
    expect(entryRows()).toEqual([]);
  });
  it('replaces an order, bumping the version and keeping the creation time', async () => {
    await store().store.replace(order());
    await expect(
      store({}, 2_000).store.replace(
        order({
          operationId: 'operation-2',
          expectedConfigVersion: 1,
          installationIds: ['provider-c', 'provider-a'],
        })
      )
    ).resolves.toMatchObject({ configVersion: 2, installationIds: ['provider-c', 'provider-a'] });
    expect(routeRows()).toMatchObject([
      { config_version: 2, last_operation_id: 'operation-2', created_at: 1_000, updated_at: 2_000 },
    ]);
    expect(
      entryRows().map((row) => [row.priority, row.installation_id, row.config_version])
    ).toEqual([
      [0, 'provider-c', 2],
      [1, 'provider-a', 2],
    ]);
  });
  it('can empty an order and refill it', async () => {
    await store().store.replace(order());
    await expect(
      store().store.replace(
        order({ operationId: 'operation-2', expectedConfigVersion: 1, installationIds: [] })
      )
    ).resolves.toMatchObject({ state: 'disabled', configVersion: 2 });
    await expect(
      store().store.replace(
        order({
          operationId: 'operation-3',
          expectedConfigVersion: 2,
          installationIds: ['provider-b'],
        })
      )
    ).resolves.toMatchObject({
      state: 'enabled',
      configVersion: 3,
      installationIds: ['provider-b'],
    });
  });
  it('keeps channels and tenants apart', async () => {
    await store().store.replace(order());
    await expect(
      store().store.replace(order({ operationId: 'operation-2', channel: 'sms' }))
    ).resolves.toMatchObject({ channel: 'sms', configVersion: 1 });
    await expect(
      store().store.replace(
        order({ operationId: 'operation-3', tenantId: 'tenant-b', installationIds: ['provider-x'] })
      )
    ).resolves.toMatchObject({ tenantId: 'tenant-b', configVersion: 1 });
  });
  it.each([
    ['a stale version', 0],
    ['a version from the future', 5],
  ])('refuses %s', async (_label, expectedConfigVersion) => {
    await store().store.replace(order());
    await expect(
      store().store.replace(order({ operationId: 'operation-2', expectedConfigVersion }))
    ).rejects.toThrow(/^plugin_notification_provider_order_version_conflict$/u);
  });
  it('refuses an update of a route that does not exist yet', async () => {
    await expect(store().store.replace(order({ expectedConfigVersion: 1 }))).rejects.toThrow(
      /^plugin_notification_provider_order_version_conflict$/u
    );
  });
  it('adopts a retry of the same operation whatever version it expected', async () => {
    await store().store.replace(order());
    await expect(
      store({}, 9_000).store.replace(order({ expectedConfigVersion: 7 }))
    ).resolves.toMatchObject({ configVersion: 1, installationIds: ['provider-a', 'provider-b'] });
    expect(routeRows()).toMatchObject([{ updated_at: 1_000 }]);
  });
  it.each([
    ['another order', { installationIds: ['provider-b', 'provider-a'] }, 'idempotency_conflict'],
    ['a shorter order', { installationIds: ['provider-a'] }, 'idempotency_conflict'],
    ['another channel', { channel: 'sms' }, 'batch_failed'],
  ])('refuses the operation reused with %s', async (_label, over, code) => {
    await store().store.replace(order());
    await expect(store().store.replace(order(over))).rejects.toThrow(
      new RegExp(`^plugin_notification_provider_order_${code}$`, 'u')
    );
  });
  it('refuses the operation id of an existing route reused for another order', async () => {
    await store().store.replace(order());
    await expect(
      store().store.replace(order({ installationIds: ['provider-b', 'provider-a'] }))
    ).rejects.toThrow(/^plugin_notification_provider_order_idempotency_conflict$/u);
  });
  it('adopts a batch that committed although its response was lost', async () => {
    await expect(
      store({
        afterBatch: () => {
          throw new Error('lost');
        },
      }).store.replace(order())
    ).resolves.toMatchObject({ configVersion: 1 });
  });
  it('reports a batch that did not commit', async () => {
    await expect(
      store({
        intercept: (call) => {
          if (call.kind === 'batch') throw new Error('d1 down');
          return undefined;
        },
      }).store.replace(order())
    ).rejects.toThrow(/^plugin_notification_provider_order_batch_failed$/u);
    expect(routeRows()).toEqual([]);
  });
  it.each([
    ['an unknown installation', ['provider-missing']],
    ['an installation of another tenant', ['provider-x']],
  ])('refuses %s', async (_label, installationIds) => {
    await expect(store().store.replace(order({ installationIds }))).rejects.toThrow(
      /^plugin_notification_provider_order_batch_failed$/u
    );
    expect(routeRows()).toEqual([]);
  });
  it.each([
    ['a short batch', [{ success: true, results: [], meta: { changes: 1 } }]],
    [
      'an unsuccessful statement',
      [
        { success: false, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 1 } },
      ],
    ],
    [
      'a statement error',
      [
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, error: 'x', results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 1 } },
      ],
    ],
    [
      'an unchanged statement',
      [
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 0 } },
        { success: true, results: [], meta: { changes: 1 } },
      ],
    ],
    [
      'a statement without a count',
      [
        { success: true, results: [], meta: {} },
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 1 } },
      ],
    ],
  ])('reports %s as a failed batch when nothing committed', async (_label, results) => {
    await expect(
      store({
        intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
      }).store.replace(order())
    ).rejects.toThrow(/^plugin_notification_provider_order_batch_failed$/u);
  });
});

describe('resolve', () => {
  const resolve = (input: unknown, options: D1Options = {}) =>
    store(options).store.resolve(input as never);
  it.each([
    ['an unsafe tenant', { tenantId: '', channel: 'email' }],
    ['an unknown channel', { tenantId: 'tenant-a', channel: 'fax' }],
  ])('rejects %s', async (_label, input) => {
    await expect(resolve(input)).rejects.toThrow(INVALID);
  });
  it('reports an order that was never configured as unavailable', async () => {
    await expect(resolve({ tenantId: 'tenant-a', channel: 'email' })).rejects.toThrow(
      /^plugin_notification_provider_order_unavailable$/u
    );
  });
  it('returns the stored order of the tenant and channel', async () => {
    await store().store.replace(order());
    await expect(resolve({ tenantId: 'tenant-a', channel: 'email' })).resolves.toEqual({
      tenantId: 'tenant-a',
      channel: 'email',
      configVersion: 1,
      state: 'enabled',
      installationIds: ['provider-a', 'provider-b'],
    });
    await expect(resolve({ tenantId: 'tenant-a', channel: 'sms' })).rejects.toThrow(/unavailable/u);
    await expect(resolve({ tenantId: 'tenant-b', channel: 'email' })).rejects.toThrow(
      /unavailable/u
    );
  });
  it('returns an empty order as disabled', async () => {
    await store().store.replace(order({ installationIds: [] }));
    await expect(resolve({ tenantId: 'tenant-a', channel: 'email' })).resolves.toMatchObject({
      state: 'disabled',
      installationIds: [],
    });
  });
  it('refuses to resolve through a disabled provider installation', async () => {
    await store().store.replace(order());
    database.exec(
      "UPDATE plugin_runner_installations SET state = 'disabled' WHERE installation_id = 'provider-b'"
    );
    await expect(resolve({ tenantId: 'tenant-a', channel: 'email' })).rejects.toThrow(REFLECTION);
  });
  describe('stored rows that are not credible', () => {
    const resolveWith = async (
      patchRoute: Record<string, unknown>,
      patchEntries?: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
    ) => {
      await store().store.replace(order());
      return resolve(
        { tenantId: 'tenant-a', channel: 'email' },
        {
          rewrite: (call, value) => {
            if (
              call.kind === 'first' &&
              call.sql.includes('plugin_runner_notification_route_sets') &&
              value
            )
              return { ...value, ...patchRoute };
            if (call.kind === 'all' && patchEntries)
              return {
                ...(value as { results: Array<Record<string, unknown>> }),
                results: patchEntries(
                  (value as { results: Array<Record<string, unknown>> }).results
                ),
              };
            return value;
          },
        }
      );
    };
    it.each([
      ['an unreadable version', { config_version: 'x' }],
      ['a zero version', { config_version: 0 }],
      ['another channel', { channel: 'fax' }],
      ['an unknown state', { state: 'paused' }],
      ['an unsafe operation id', { last_operation_id: 'a b' }],
      ['a short fingerprint', { order_fingerprint: 'a'.repeat(63) }],
      ['an uppercase fingerprint', { order_fingerprint: 'A'.repeat(64) }],
      ['a zero creation time', { created_at: 0 }],
      ['a zero update time', { updated_at: 0 }],
      ['a disabled state with entries', { state: 'disabled' }],
    ])('rejects a route with %s', async (_label, patch) => {
      await expect(resolveWith(patch)).rejects.toThrow(REFLECTION);
    });
    it.each([
      [
        'a gap in priorities',
        (rs: Array<Record<string, unknown>>) => rs.map((row, i) => ({ ...row, priority: i + 1 })),
      ],
      [
        'a non-numeric priority',
        (rs: Array<Record<string, unknown>>) => rs.map((row) => ({ ...row, priority: 'x' })),
      ],
      [
        'a negative priority',
        (rs: Array<Record<string, unknown>>) => rs.map((row, i) => ({ ...row, priority: i - 1 })),
      ],
      [
        'an unsafe installation',
        (rs: Array<Record<string, unknown>>) =>
          rs.map((row) => ({ ...row, installation_id: '-x' })),
      ],
      [
        'an installation of another tenant',
        (rs: Array<Record<string, unknown>>) =>
          rs.map((row) => ({ ...row, installation_tenant_id: 'tenant-b' })),
      ],
      [
        'a disabled installation',
        (rs: Array<Record<string, unknown>>) =>
          rs.map((row) => ({ ...row, installation_state: 'disabled' })),
      ],
      [
        'a missing installation',
        (rs: Array<Record<string, unknown>>) =>
          rs.map((row) => ({ ...row, installation_tenant_id: null, installation_state: null })),
      ],
      [
        'nine entries',
        (rs: Array<Record<string, unknown>>) =>
          Array.from({ length: 9 }, (_, i) => ({ ...(rs[0] ?? {}), priority: i })),
      ],
    ])('rejects entries with %s', async (_label, patch) => {
      await expect(resolveWith({}, patch)).rejects.toThrow(REFLECTION);
    });
    it('rejects entries that exist without a route', async () => {
      await expect(
        resolve(
          { tenantId: 'tenant-a', channel: 'email' },
          {
            rewrite: (call, value) =>
              call.kind === 'all'
                ? {
                    ...(value as object),
                    results: [
                      {
                        installation_id: 'provider-a',
                        priority: 0,
                        installation_tenant_id: 'tenant-a',
                        installation_state: 'enabled',
                      },
                    ],
                  }
                : value,
          }
        )
      ).rejects.toThrow(REFLECTION);
    });
    it('refuses an entry read that did not succeed', async () => {
      await store().store.replace(order());
      await expect(
        resolve(
          { tenantId: 'tenant-a', channel: 'email' },
          {
            rewrite: (call, value) =>
              call.kind === 'all' ? { ...(value as object), success: false } : value,
          }
        )
      ).rejects.toThrow(/^plugin_notification_provider_order_read_failed$/u);
      await expect(
        resolve(
          { tenantId: 'tenant-a', channel: 'email' },
          {
            rewrite: (call, value) =>
              call.kind === 'all' ? { ...(value as object), error: 'x' } : value,
          }
        )
      ).rejects.toThrow(/^plugin_notification_provider_order_read_failed$/u);
    });
  });
});

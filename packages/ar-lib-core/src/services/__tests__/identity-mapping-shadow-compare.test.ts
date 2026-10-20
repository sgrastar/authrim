import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  IDENTITY_MAPPING_RESOLUTION_DIFF_LOG_WINDOW_MS as WINDOW,
  classifyResolutionDiff,
  IDENTITY_MAPPING_SHADOW_SETTING_FAILURE_TTL_MS as FAILURE_TTL,
  resetIdentityMappingResolutionDiffThrottle,
  resetIdentityMappingShadowCompareSettingCache,
  runOidcIdentityMappingShadowCompare,
  scheduleOidcIdentityMappingShadowCompare,
  type ResolutionDiffKind,
  type ShadowCurrentResolution,
  type ShadowNewResolution,
} from '../identity-mapping-shadow-compare';
import { PLATFORM_MAPPING_TENANT_ID } from '../identity-mapping-owner';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

/**
 * The shadow comparison: when the platform turns it on, each OIDC resolution is also run through
 * the new selection and a difference is logged as a warning. The real selection, settings reader,
 * set lookup and resolver run here, over SQLite with the real Admin baseline.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const FLAG = 'identity_mapping.shadow_compare_enabled';
const ON = { 'settings:platform:identity-mapping': { [FLAG]: true } };
const TENANT_DEFAULT = { [KEY]: 'set-own' };

function kv(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

function settings(options: { flag?: boolean; tenant?: unknown; platform?: unknown } = {}) {
  const docs: Record<string, unknown> = {};
  const platform: Record<string, unknown> = {};
  if (options.flag !== false) platform[FLAG] = true;
  if (options.platform !== undefined) platform[KEY] = options.platform;
  docs['settings:platform:identity-mapping'] = platform;
  if (options.tenant !== undefined) {
    docs['settings:tenant:tenant-a:identity-mapping'] = { [KEY]: options.tenant };
  }
  return docs;
}

/** An adapter with every method, as `DB_ADMIN` of a Worker is taken for one. */
function complete(adapter: DatabaseAdapter): DatabaseAdapter {
  return Object.assign(adapter, {
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async () => undefined,
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
    getType: () => 'test',
    close: async () => undefined,
  });
}

let sharedAdmin: DatabaseAdapter | undefined;

/** The Admin database with a set of the tenant and a set of the platform; only ever read. */
function admin(): DatabaseAdapter {
  if (!sharedAdmin) {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'own' });
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
    sharedAdmin = complete(sqliteAdapter(db));
  }
  return sharedAdmin;
}

const CURRENT: Record<string, ShadowCurrentResolution> = {
  none: { tier: 'none' },
  implicit: { tier: 'implicit_tenant_activation', setId: 'set-own' },
  explicit: { tier: 'explicit', setId: 'set-own' },
};

describe('classifyResolutionDiff', () => {
  const bound = (tier: 'client' | 'tenant_default' | 'platform_default', setId: string) =>
    ({ kind: 'bound', tier, setId }) as const;
  const none = { kind: 'none', reason: 'no_default' } as const;
  const failed = { kind: 'failed', code: 'set_missing', tier: 'tenant_default' } as const;

  it.each<[string, ShadowCurrentResolution, ShadowNewResolution, ResolutionDiffKind | null]>([
    ['nothing then nothing', CURRENT.none, none, null],
    [
      'nothing then a set',
      CURRENT.none,
      bound('tenant_default', 'set-own'),
      'current_none_new_bound',
    ],
    ['an implicit set then nothing', CURRENT.implicit, none, 'current_bound_new_none'],
    ['an explicit set then nothing', CURRENT.explicit, none, 'current_bound_new_none'],
    [
      'an implicit set then another',
      CURRENT.implicit,
      bound('tenant_default', 'set-x'),
      'set_differs',
    ],
    ['an explicit set then another', CURRENT.explicit, bound('client', 'set-x'), 'set_differs'],
    [
      'an implicit set then the same as the tenant default',
      CURRENT.implicit,
      bound('tenant_default', 'set-own'),
      'tier_differs',
    ],
    [
      'an implicit set then the same as the platform default',
      CURRENT.implicit,
      bound('platform_default', 'set-own'),
      'tier_differs',
    ],
    [
      'an implicit set then the same as the app’s own',
      CURRENT.implicit,
      bound('client', 'set-own'),
      'tier_differs',
    ],
    [
      'an explicit set then the same as the app’s own',
      CURRENT.explicit,
      bound('client', 'set-own'),
      null,
    ],
    [
      'an explicit set then the same as a default',
      CURRENT.explicit,
      bound('tenant_default', 'set-own'),
      'tier_differs',
    ],
    ['nothing then a failure', CURRENT.none, failed, 'new_selection_failed'],
    ['a set then a failure', CURRENT.implicit, failed, 'new_selection_failed'],
  ])('%s', (_name, current, next, expected) => {
    expect(classifyResolutionDiff(current, next)).toBe(expected);
  });
});

describe('the shadow comparison', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetIdentityMappingResolutionDiffThrottle();
    resetIdentityMappingShadowCompareSettingCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  const records = (): Array<Record<string, any>> =>
    warnSpy.mock.calls.map(([line]: [unknown]) => JSON.parse(String(line)) as Record<string, any>);

  function run(
    options: {
      docs?: Record<string, unknown>;
      current?: ShadowCurrentResolution;
      clientSelector?: Record<string, unknown> | null;
      clientId?: string;
      now?: number;
      env?: Record<string, unknown>;
    } = {}
  ) {
    return runOidcIdentityMappingShadowCompare({
      env: {
        SETTINGS: kv(options.docs ?? settings()),
        DB_ADMIN: admin(),
        ...options.env,
      } as never,
      tenantId: 'tenant-a',
      clientId: options.clientId ?? 'client-a',
      clientSelector: options.clientSelector ?? null,
      current: options.current ?? CURRENT.none,
      now: options.now ?? 1_000,
    });
  }

  describe('when it is off', () => {
    it('does nothing and reads nothing by default', async () => {
      const adminReads: string[] = [];
      const spying = {
        query: async (sql: string) => adminReads.push(sql),
        queryOne: async (sql: string) => adminReads.push(sql),
      };
      await run({
        docs: { 'settings:tenant:tenant-a:identity-mapping': TENANT_DEFAULT },
        env: { DB_ADMIN: spying },
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(adminReads).toEqual([]);
    });

    it('is off when the platform saved false', async () => {
      await run({
        docs: {
          'settings:platform:identity-mapping': { [FLAG]: false },
          'settings:tenant:tenant-a:identity-mapping': TENANT_DEFAULT,
        },
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('is off, quietly, when the settings cannot be read', async () => {
      await run({ env: { SETTINGS: { get: async () => '{not json' } } });
      // (The settings reader says so itself; the comparison records nothing.)
      expect(records().filter((r) => r.action === 'identity_mapping_resolution_diff')).toEqual([]);
    });

    it('is off when there is no environment to read', async () => {
      await runOidcIdentityMappingShadowCompare({
        env: undefined,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSelector: null,
        current: CURRENT.none,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('when the settings cannot be read', () => {
    afterEach(() => vi.useRealTimers());

    /** A KV that fails, counting the reads. */
    function brokenKv(fail: () => unknown = () => Promise.reject(new Error('KV is down'))) {
      const reads: string[] = [];
      const namespace = {
        get: async (key: string) => {
          reads.push(key);
          return fail();
        },
      } as unknown as KVNamespace;
      return { reads, namespace };
    }
    const settingsWarnings = () =>
      records().filter((record) => record.module === 'SETTINGS_MANAGER');

    it('reads once, treats the comparison as off, and does not read or warn again within the window', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
      const { reads, namespace } = brokenKv();
      const env = { SETTINGS: namespace };
      await run({ env });
      const firstReads = reads.length;
      expect(firstReads).toBeGreaterThan(0);

      for (let i = 0; i < 25; i += 1) await run({ env });

      expect(reads).toHaveLength(firstReads);
      expect(settingsWarnings().length).toBeLessThanOrEqual(1);
      expect(records().filter((r) => r.action === 'identity_mapping_resolution_diff')).toEqual([]);
    });

    it('tries again after the window, once', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
      const { reads, namespace } = brokenKv();
      const env = { SETTINGS: namespace };
      await run({ env });
      const firstReads = reads.length;
      vi.setSystemTime(1_000_000 + FAILURE_TTL - 1);
      await run({ env });
      expect(reads).toHaveLength(firstReads);

      vi.setSystemTime(1_000_000 + FAILURE_TTL);
      await run({ env });
      await run({ env });
      expect(reads).toHaveLength(firstReads * 2);
    });

    it('comes back when the settings can be read again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
      let healthy = false;
      const documents = settings({ tenant: 'set-own' });
      const namespace = {
        get: async (key: string) => {
          if (!healthy) throw new Error('KV is down');
          return key in documents ? JSON.stringify(documents[key]) : null;
        },
      } as unknown as KVNamespace;
      await run({ env: { SETTINGS: namespace } });
      expect(records().filter((r) => r.action === 'identity_mapping_resolution_diff')).toEqual([]);

      healthy = true;
      vi.setSystemTime(1_000_000 + FAILURE_TTL);
      await run({ env: { SETTINGS: namespace } });
      expect(records().filter((r) => r.action === 'identity_mapping_resolution_diff')).toHaveLength(
        1
      );
    });

    it('shares one read between requests that arrive while it is under way', async () => {
      let release: (value: string | null) => void = () => undefined;
      const reads: string[] = [];
      const namespace = {
        get: (key: string) => {
          reads.push(key);
          return new Promise<string | null>((resolve) => {
            release = resolve;
          });
        },
      } as unknown as KVNamespace;
      const env = { SETTINGS: namespace };

      const runs = Array.from({ length: 10 }, () => run({ env }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reads).toHaveLength(1);

      release(null);
      await Promise.all(runs);
      expect(reads).toHaveLength(1);
    });

    it('does not delay the request: scheduling returns at once and a failing read stays off its path', async () => {
      const { namespace } = brokenKv();
      const startedAt = Date.now();
      scheduleOidcIdentityMappingShadowCompare({
        env: { SETTINGS: namespace, DB_ADMIN: admin() } as never,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSelector: null,
        current: CURRENT.none,
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it('keeps a failure of one KV from switching off another', async () => {
      const { namespace } = brokenKv();
      await run({ env: { SETTINGS: namespace } });
      await run({ docs: settings({ tenant: 'set-own' }) });
      expect(records().filter((r) => r.action === 'identity_mapping_resolution_diff')).toHaveLength(
        1
      );
    });
  });

  describe('when it is on', () => {
    it('can be turned on by the environment variable, for the whole platform', async () => {
      await run({
        docs: { 'settings:tenant:tenant-a:identity-mapping': TENANT_DEFAULT },
        env: { IDENTITY_MAPPING_SHADOW_COMPARE: 'true' },
      });
      expect(records()).toHaveLength(1);
    });

    it('is not turned on by a tenant’s own document', async () => {
      await run({
        docs: {
          'settings:tenant:tenant-a:identity-mapping': { ...TENANT_DEFAULT, [FLAG]: true },
        },
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each<[ResolutionDiffKind, Parameters<typeof run>[0], Record<string, unknown>]>([
      [
        'current_none_new_bound',
        { docs: settings({ tenant: 'set-own' }), current: CURRENT.none },
        { current_tier: 'none', new_tier: 'tenant_default', new_set_id: 'set-own' },
      ],
      [
        'current_bound_new_none',
        { docs: settings(), current: CURRENT.implicit },
        {
          current_tier: 'implicit_tenant_activation',
          current_set_id: 'set-own',
          new_tier: 'none',
          new_none_reason: 'no_default',
        },
      ],
      [
        'tier_differs',
        { docs: settings({ tenant: 'set-own' }), current: CURRENT.implicit },
        {
          current_tier: 'implicit_tenant_activation',
          current_set_id: 'set-own',
          new_tier: 'tenant_default',
          new_set_id: 'set-own',
        },
      ],
      [
        'set_differs',
        { docs: settings({ platform: 'set-plat' }), current: CURRENT.implicit },
        {
          current_set_id: 'set-own',
          new_tier: 'platform_default',
          new_set_id: 'set-plat',
        },
      ],
      [
        'new_selection_failed',
        { docs: settings({ tenant: '' }), current: CURRENT.implicit },
        {
          current_tier: 'implicit_tenant_activation',
          new_tier: 'tenant_default',
          new_failure_code: 'default_setting_invalid',
        },
      ],
      [
        'new_selection_failed',
        { docs: settings({ tenant: 'set-gone' }), current: CURRENT.none },
        { new_tier: 'tenant_default', new_failure_code: 'set_missing' },
      ],
      [
        'new_selection_failed',
        {
          docs: settings(),
          current: CURRENT.explicit,
          clientSelector: { fieldMappingSetId: 'set-gone' },
        },
        { current_tier: 'explicit', new_tier: 'client', new_failure_code: 'set_missing' },
      ],
    ])('logs %s as a warning, with the two sets and levels', async (kind, options, fields) => {
      await run(options);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(records()[0]).toMatchObject({
        level: 'warn',
        tenantId: 'tenant-a',
        clientId: 'client-a',
        action: 'identity_mapping_resolution_diff',
        failure_kind: kind,
        suppressed_since_last_log: 0,
        ...fields,
      });
    });

    it.each<[string, Parameters<typeof run>[0]]>([
      [
        'the same set chosen by the app',
        {
          docs: settings(),
          current: CURRENT.explicit,
          clientSelector: { fieldMappingSetId: 'set-own' },
        },
      ],
      ['no mapping on either side', { docs: settings(), current: CURRENT.none }],
      [
        'the app opting out of nothing',
        {
          docs: settings({ tenant: 'set-own' }),
          current: CURRENT.none,
          clientSelector: { mode: 'none' },
        },
      ],
    ])('logs nothing for %s', async (_name, options) => {
      await run(options);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('records that the current resolution failed and went on without a mapping', async () => {
      await run({
        docs: settings({ tenant: 'set-own' }),
        current: { tier: 'none', failed: true },
      });
      expect(records()[0]).toMatchObject({
        failure_kind: 'current_none_new_bound',
        current_resolution_failed: true,
      });
    });

    it('records a failure to read the Admin database as a failure of the new selection', async () => {
      await run({ docs: settings({ tenant: 'set-own' }), env: { DB_ADMIN: undefined } });
      expect(records()[0]).toMatchObject({
        failure_kind: 'new_selection_failed',
        new_failure_code: 'admin_database_unavailable',
      });
    });

    it('carries no claim, value, user or error message, only the fixed fields', async () => {
      await run({ docs: settings({ tenant: 'set-own' }) });

      const record = records()[0];
      expect(Object.keys(record).sort()).toEqual(
        [
          'action',
          'clientId',
          'current_tier',
          'failure_kind',
          'level',
          'message',
          'module',
          'new_set_id',
          'new_tier',
          'suppressed_since_last_log',
          'tenantId',
          'timestamp',
        ].sort()
      );
      expect(record.module).toBe('OIDC-IDENTITY-MAPPING-SHADOW');
    });
  });

  describe('the volume', () => {
    const diff = (clientId: string, now: number, tenant = 'set-own') =>
      run({ docs: settings({ tenant }), clientId, now });

    it('records the same difference of the same app once per window, with the repeats counted', async () => {
      await diff('client-a', 1_000);
      await diff('client-a', 2_000);
      await diff('client-a', 3_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      await diff('client-a', 1_000 + WINDOW);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(records()[1].suppressed_since_last_log).toBe(2);
    });

    it('records another app, or another kind of difference, independently', async () => {
      await diff('client-a', 1_000);
      await diff('client-b', 1_000);
      await run({ docs: settings(), current: CURRENT.implicit, clientId: 'client-a', now: 1_000 });
      expect(warnSpy).toHaveBeenCalledTimes(3);
    });

    it('is bounded: keys beyond the table share one record that names no app', async () => {
      for (let i = 0; i < 256; i += 1) await diff(`client-${i}`, 1_000);
      expect(warnSpy).toHaveBeenCalledTimes(256);

      await diff('client-new', 1_500);
      await diff('client-newer', 1_600);
      // The first one over the table is recorded as the shared record, the next is held back.
      expect(warnSpy).toHaveBeenCalledTimes(257);
      const overflow = records()[256];
      expect(overflow.throttle_overflow).toBe(true);
      expect(overflow).not.toHaveProperty('clientId');

      // The records already held keep their windows (no cycle of keys logs on every pass).
      await diff('client-0', 1_700);
      expect(warnSpy).toHaveBeenCalledTimes(257);

      // After the window the shared record reports the repeats.
      await diff('client-new', 1_000 + WINDOW + 1);
      expect(records().at(-1)).toMatchObject({ suppressed_since_last_log: expect.any(Number) });
    });
  });

  describe('the request', () => {
    it('never sees an error from the comparison, whatever it throws', async () => {
      warnSpy.mockImplementation(() => {
        throw new Error('the log sink is down');
      });
      await expect(run({ docs: settings({ tenant: 'set-own' }) })).resolves.toBeUndefined();
    });

    it('is handed to waitUntil, and a waitUntil that throws changes nothing', async () => {
      const handed: Promise<unknown>[] = [];
      scheduleOidcIdentityMappingShadowCompare({
        env: { SETTINGS: kv(settings({ tenant: 'set-own' })), DB_ADMIN: admin() } as never,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSelector: null,
        current: CURRENT.none,
        waitUntil: (promise) => void handed.push(promise),
      });
      expect(handed).toHaveLength(1);
      await handed[0];
      expect(records()).toHaveLength(1);

      expect(() =>
        scheduleOidcIdentityMappingShadowCompare({
          env: { SETTINGS: kv(settings()), DB_ADMIN: admin() } as never,
          tenantId: 'tenant-a',
          clientId: 'client-a',
          clientSelector: null,
          current: CURRENT.none,
          waitUntil: () => {
            throw new Error('no execution context');
          },
        })
      ).not.toThrow();
    });

    it('does not wait for the comparison: scheduling returns while its reads are still pending', async () => {
      const never = new Promise<never>(() => undefined);
      const startedAt = Date.now();
      scheduleOidcIdentityMappingShadowCompare({
        env: { SETTINGS: { get: () => never }, DB_ADMIN: admin() } as never,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSelector: null,
        current: CURRENT.none,
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
    });
  });
});

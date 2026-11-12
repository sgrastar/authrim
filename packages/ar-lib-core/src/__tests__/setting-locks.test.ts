/**
 * The platform's setting locks: a locked setting cannot be changed by a tenant or a client, and
 * the values they stored for it are ignored (the platform's value, else env, else default).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  generateVersion,
  isLockedByPlatformReason,
  LOCKED_BY_PLATFORM,
  SETTING_LOCKS_FIELD,
  settingsStorageKey,
  SettingsManager,
  type SettingScope,
  type SettingsAuditEvent,
} from '../utils/settings-manager';
import { getTenantSettingsDocument } from '../utils/tenant-settings';
import {
  ALL_CATEGORY_META,
  CATEGORY_SCOPE_CONFIG,
  isCategoryAvailableAtScope,
  settingsParentScopes,
  type CategoryName,
} from '../types/settings/catalog';
import {
  resolveEffectiveSettings,
  resolveEffectiveSettingsWithSources,
} from '../services/effective-settings';
import { resolveEmailSendLimit, resolveTotpAttemptLimit } from '../services/sign-in-limits';
import { resolveProtocolSettings } from '../services/protocol-settings';

const MAX = 'rate_limit.email_max_requests';
const WINDOW = 'rate_limit.email_window';
const HTTPS_ENABLED = 'oauth.https_request_uri_enabled';
const HTTPS_DOMAINS = 'oauth.https_request_uri_allowed_domains';

const PLATFORM: SettingScope = { type: 'platform' };
const TENANT: SettingScope = { type: 'tenant', id: 'acme' };
const CLIENT: SettingScope = { type: 'client', id: 'app', tenantId: 'acme' };
const LOCK = SETTING_LOCKS_FIELD;

function memoryKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)])
  );
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return { kv: kv as unknown as KVNamespace, store, raw: kv };
}

function manager(
  initial: Record<string, unknown>,
  options: { env?: Record<string, string>; audit?: (e: SettingsAuditEvent) => Promise<void> } = {}
) {
  const { kv, store } = memoryKv(initial);
  const m = new SettingsManager({
    env: options.env ?? {},
    kv,
    cacheTTL: 0,
    auditCallback: options.audit,
  });
  for (const meta of Object.values(ALL_CATEGORY_META)) m.registerCategory(meta);
  return { m, kv, store };
}

const read = (m: SettingsManager, category: CategoryName, scope: SettingScope) =>
  m.getAll(category, scope, { parents: settingsParentScopes(category, scope) });

describe('reads', () => {
  const docs = {
    'settings:platform:rate-limit': { [MAX]: 5, [LOCK]: [MAX] },
    'settings:tenant:acme:rate-limit': { [MAX]: 9, [WINDOW]: 600 },
    'settings:client:acme:app:oauth': { [HTTPS_ENABLED]: true },
    'settings:tenant:acme:oauth': { [HTTPS_ENABLED]: true },
    'settings:platform:oauth': { [HTTPS_ENABLED]: false, [LOCK]: [HTTPS_ENABLED] },
  };

  it('resolves a locked key from the platform, ignoring the tenant value, and says so', async () => {
    const { m } = manager(docs);
    const result = await read(m, 'rate-limit', TENANT);
    expect(result.values[MAX]).toBe(5);
    expect(result.sources[MAX]).toBe('platform');
    expect(result.inherited.values[MAX]).toBe(5);
    expect(result.locked).toEqual([MAX]);
    // The tenant still stores a value of its own for it, which is set aside.
    expect(result.setAside).toEqual([MAX]);
    // An unlocked key is untouched.
    expect(result.values[WINDOW]).toBe(600);
    expect(result.sources[WINDOW]).toBe('kv');
  });

  it('ignores the client value and the tenant value of a locked key at the client scope', async () => {
    const { m } = manager(docs);
    const result = await read(m, 'oauth', CLIENT);
    expect(result.values[HTTPS_ENABLED]).toBe(false);
    expect(result.sources[HTTPS_ENABLED]).toBe('platform');
    expect(result.inherited.sources[HTTPS_ENABLED]).toBe('platform');
  });

  it('falls to env, then the default, when the platform holds no value for a locked key', async () => {
    const withEnv = manager(
      {
        'settings:platform:rate-limit': { [LOCK]: [MAX] },
        'settings:tenant:acme:rate-limit': { [MAX]: 9 },
      },
      { env: { EMAIL_RATE_LIMIT_MAX_REQUESTS: '7' } }
    );
    const fromEnv = await read(withEnv.m, 'rate-limit', TENANT);
    expect(fromEnv.values[MAX]).toBe(7);
    expect(fromEnv.sources[MAX]).toBe('env');

    const bare = manager({
      'settings:platform:rate-limit': { [LOCK]: [MAX] },
      'settings:tenant:acme:rate-limit': { [MAX]: 9 },
    });
    const fromDefault = await read(bare.m, 'rate-limit', TENANT);
    expect(fromDefault.values[MAX]).toBe(3);
    expect(fromDefault.sources[MAX]).toBe('default');
  });

  it('applies the tenant value again once the key is unlocked (it was kept, not deleted)', async () => {
    const { m } = manager(docs);
    const before = await read(m, 'rate-limit', PLATFORM);
    await m.patch('rate-limit', PLATFORM, { ifMatch: before.version, unlock: [MAX] }, 'admin');
    const after = await read(m, 'rate-limit', TENANT);
    expect(after.values[MAX]).toBe(9);
    expect(after.sources[MAX]).toBe('kv');
    expect(after.locked).toEqual([]);
    expect(after.setAside).toEqual([]);
  });

  it('changes nothing when nothing is locked', async () => {
    const { m } = manager({
      'settings:platform:rate-limit': { [MAX]: 5 },
      'settings:tenant:acme:rate-limit': { [MAX]: 9 },
    });
    const result = await read(m, 'rate-limit', TENANT);
    expect(result.values[MAX]).toBe(9);
    expect(result.sources[MAX]).toBe('kv');
    expect(result.locked).toEqual([]);
  });

  it('enforces only keys that are lockable and settable by tenants; the list never shows as a value', async () => {
    const { m } = manager({
      'settings:platform:rate-limit': {
        [MAX]: 5,
        'rate_limit.lenient': 111,
        [LOCK]: [MAX, 'rate_limit.auth_max_failed_attempts', 'no.such.key', 42],
      },
      'settings:tenant:acme:rate-limit': { 'rate_limit.auth_max_failed_attempts': 4 },
    });
    const tenant = await read(m, 'rate-limit', TENANT);
    // Not lockable: the tenant's own value stands even though the stored list names it.
    expect(tenant.values['rate_limit.auth_max_failed_attempts']).toBe(4);
    expect(tenant.locked).toEqual([MAX]);
    for (const result of [tenant, await read(m, 'rate-limit', PLATFORM)]) {
      expect(Object.keys(result.values)).not.toContain(LOCK);
      expect(Object.keys(result.sources)).not.toContain(LOCK);
    }
  });

  it('ignores a lock list stored in a tenant document', async () => {
    const { m } = manager({
      'settings:tenant:acme:rate-limit': { [MAX]: 9, [LOCK]: [MAX] },
    });
    const result = await read(m, 'rate-limit', TENANT);
    expect(result.values[MAX]).toBe(9);
    expect(result.locked).toEqual([]);
  });

  it('enforces a lock for a read made without the platform as a parent', async () => {
    const { m } = manager(docs);
    const tenant = await m.getAll('rate-limit', TENANT);
    expect(tenant.values[MAX]).toBe(5);
    expect(tenant.sources[MAX]).toBe('platform');
    expect(tenant.values[WINDOW]).toBe(600);
    expect(tenant.locked).toEqual([MAX]);
    const client = await m.getAll('oauth', CLIENT);
    expect(client.values[HTTPS_ENABLED]).toBe(false);
    expect(client.sources[HTTPS_ENABLED]).toBe('platform');
  });

  it('reads an unlocked key, and a category without lockable keys, as before without parents', async () => {
    const { m, kv } = manager({
      'settings:platform:oauth': { 'oauth.access_token_expiry': 900 },
      'settings:tenant:acme:oauth': { 'oauth.access_token_expiry': 1800 },
      'settings:tenant:acme:session': { 'session.default_ttl': 7200 },
    });
    const oauth = await m.getAll('oauth', TENANT);
    expect(oauth.values['oauth.access_token_expiry']).toBe(1800);
    expect(oauth.sources['oauth.access_token_expiry']).toBe('kv');
    // No platform read for a category with nothing lockable.
    vi.mocked(kv.get).mockClear();
    await m.getAll('session', TENANT);
    expect(vi.mocked(kv.get).mock.calls.map(([key]) => key)).toEqual([
      'settings:tenant:acme:session',
    ]);
  });
});

describe('writes', () => {
  const docs = {
    'settings:platform:rate-limit': { [MAX]: 5, [LOCK]: [MAX] },
    'settings:tenant:acme:rate-limit': { [MAX]: 9 },
    'settings:platform:oauth': { [LOCK]: [HTTPS_ENABLED] },
    'settings:tenant:acme:oauth': { [HTTPS_ENABLED]: true },
    'settings:client:acme:app:oauth': { [HTTPS_ENABLED]: true },
  };

  it('refuses set and disable of a locked key at the tenant and the client scope', async () => {
    const { m } = manager(docs);
    const tenantVersion = (await read(m, 'rate-limit', TENANT)).version;
    const set = await m.patch(
      'rate-limit',
      TENANT,
      { ifMatch: tenantVersion, set: { [MAX]: 4, [WINDOW]: 600 } },
      'tenant-admin',
      { parents: settingsParentScopes('rate-limit', TENANT) }
    );
    expect(set.applied).toEqual([WINDOW]);
    expect(isLockedByPlatformReason(set.rejected[MAX])).toBe(true);
    expect(set.rejected[MAX]).toContain(LOCKED_BY_PLATFORM);
    expect((await read(m, 'rate-limit', TENANT)).values[MAX]).toBe(5);

    const clientVersion = (await read(m, 'oauth', CLIENT)).version;
    const disable = await m.patch(
      'oauth',
      CLIENT,
      { ifMatch: clientVersion, disable: [HTTPS_ENABLED] },
      'client-admin',
      { parents: settingsParentScopes('oauth', CLIENT) }
    );
    expect(disable.disabled).toEqual([]);
    expect(isLockedByPlatformReason(disable.rejected[HTTPS_ENABLED])).toBe(true);
    const set2 = await m.patch(
      'oauth',
      CLIENT,
      { ifMatch: clientVersion, set: { [HTTPS_ENABLED]: false } },
      'client-admin',
      { parents: settingsParentScopes('oauth', CLIENT) }
    );
    expect(isLockedByPlatformReason(set2.rejected[HTTPS_ENABLED])).toBe(true);
  });

  it('refuses set and disable of a locked key even when the caller passed no parents', async () => {
    const { m } = manager(docs);
    const tenant = await m.getAll('rate-limit', TENANT);
    const set = await m.patch(
      'rate-limit',
      TENANT,
      { ifMatch: tenant.version, set: { [MAX]: 4 } },
      'import'
    );
    expect(set.applied).toEqual([]);
    expect(isLockedByPlatformReason(set.rejected[MAX])).toBe(true);
    const client = await m.getAll('oauth', CLIENT);
    const disabled = await m.patch(
      'oauth',
      CLIENT,
      { ifMatch: client.version, disable: [HTTPS_ENABLED] },
      'import'
    );
    expect(isLockedByPlatformReason(disabled.rejected[HTTPS_ENABLED])).toBe(true);
  });

  it('allows clearing a locked key, which removes the stale own value', async () => {
    const { m, store } = manager(docs);
    const version = (await read(m, 'rate-limit', TENANT)).version;
    const result = await m.patch(
      'rate-limit',
      TENANT,
      { ifMatch: version, clear: [MAX] },
      'admin',
      {
        parents: settingsParentScopes('rate-limit', TENANT),
      }
    );
    expect(result.cleared).toEqual([MAX]);
    expect(result.rejected).toEqual({});
    expect(JSON.parse(store.get('settings:tenant:acme:rate-limit')!)).toEqual({});
  });

  it('lets the platform still change the value of a locked key', async () => {
    const { m } = manager(docs);
    const version = (await read(m, 'rate-limit', PLATFORM)).version;
    const result = await m.patch(
      'rate-limit',
      PLATFORM,
      { ifMatch: version, set: { [MAX]: 6 } },
      'p'
    );
    expect(result.applied).toEqual([MAX]);
    expect((await read(m, 'rate-limit', TENANT)).values[MAX]).toBe(6);
  });

  it('does not let a request reach the lock list through set, clear or disable', async () => {
    const { m } = manager(docs);
    const version = (await read(m, 'rate-limit', PLATFORM)).version;
    const result = await m.patch(
      'rate-limit',
      PLATFORM,
      { ifMatch: version, set: { [LOCK]: [] }, clear: [LOCK] },
      'p'
    );
    expect(result.applied).toEqual([]);
    expect(result.rejected[LOCK]).toBeDefined();
    expect((await read(m, 'rate-limit', PLATFORM)).locked).toEqual([MAX]);
  });
});

describe('an unreadable platform document', () => {
  const tenantDocs = {
    'settings:tenant:acme:rate-limit': { [MAX]: 9 },
    'settings:client:acme:app:oauth': { [HTTPS_ENABLED]: true },
    'settings:tenant:acme:session': { 'session.default_ttl': 7200 },
  };

  /** A manager that is not strict and has no canonical store, over a platform key that fails. */
  function broken(platformKey: string, how: 'throws' | 'malformed') {
    const { kv, store } = memoryKv(tenantDocs);
    if (how === 'malformed') store.set(platformKey, 'not json');
    const inner = kv.get.bind(kv) as (key: string) => Promise<string | null>;
    (kv as unknown as { get: unknown }).get = vi.fn(async (key: string) => {
      if (how === 'throws' && key === platformKey) throw new Error('kv unavailable');
      return inner(key);
    });
    const m = new SettingsManager({ env: {}, kv, cacheTTL: 0 });
    for (const meta of Object.values(ALL_CATEGORY_META)) m.registerCategory(meta);
    return m;
  }

  it.each(['throws', 'malformed'] as const)(
    'is not read as unlocked: reads and writes throw (%s)',
    async (how) => {
      const rate = broken('settings:platform:rate-limit', how);
      const oauth = broken('settings:platform:oauth', how);
      // With the platform as a parent, and without.
      await expect(read(rate, 'rate-limit', TENANT)).rejects.toThrow('settings_read_failed');
      await expect(rate.getAll('rate-limit', TENANT)).rejects.toThrow('settings_read_failed');
      await expect(read(oauth, 'oauth', CLIENT)).rejects.toThrow('settings_read_failed');
      await expect(oauth.getAll('oauth', CLIENT)).rejects.toThrow('settings_read_failed');
      const version = generateVersion({ [MAX]: 9 });
      await expect(
        rate.patch('rate-limit', TENANT, { ifMatch: version, set: { [MAX]: 4 } }, 't', {
          parents: settingsParentScopes('rate-limit', TENANT),
        })
      ).rejects.toThrow('settings_read_failed');
      await expect(
        rate.patch('rate-limit', TENANT, { ifMatch: version, set: { [MAX]: 4 } }, 't')
      ).rejects.toThrow('settings_read_failed');
      await expect(
        oauth.patch(
          'oauth',
          CLIENT,
          { ifMatch: generateVersion({ [HTTPS_ENABLED]: true }), disable: [HTTPS_ENABLED] },
          'c'
        )
      ).rejects.toThrow('settings_read_failed');
    }
  );

  it('is still tolerated for a category without lockable settings, and at the platform scope', async () => {
    const session = broken('settings:platform:session', 'throws');
    const result = await read(session, 'session', TENANT);
    expect(result.values['session.default_ttl']).toBe(7200);
    const platform = broken('settings:platform:rate-limit', 'throws');
    // Reading the platform's own document keeps today's behaviour (an unreadable one is empty).
    await expect(read(platform, 'rate-limit', PLATFORM)).resolves.toMatchObject({ locked: [] });
  });

  it('is not a failure when the platform document is absent: no locks, no error', async () => {
    const { m } = manager(tenantDocs);
    const result = await read(m, 'rate-limit', TENANT);
    expect(result.values[MAX]).toBe(9);
    expect(result.locked).toEqual([]);
    expect((await m.getAll('oauth', CLIENT)).values[HTTPS_ENABLED]).toBe(true);
  });
});

describe('the cache and the platform document', () => {
  const PLATFORM_KEY = 'settings:platform:rate-limit';
  const docs = { 'settings:tenant:acme:rate-limit': { [MAX]: 9 } };

  /** A non-strict manager with a long cache; the platform document can be broken and mended. */
  function cached() {
    const { kv, store } = memoryKv(docs);
    const state = { fail: false };
    const inner = kv.get.bind(kv) as (key: string) => Promise<string | null>;
    const get = vi.fn(async (key: string) => {
      if (state.fail && key === PLATFORM_KEY) throw new Error('kv unavailable');
      return inner(key);
    });
    (kv as unknown as { get: unknown }).get = get;
    const m = new SettingsManager({ env: {}, kv, cacheTTL: 60_000 });
    for (const meta of Object.values(ALL_CATEGORY_META)) m.registerCategory(meta);
    return { m, store, state, get };
  }

  const platformGets = (get: ReturnType<typeof vi.fn>) =>
    get.mock.calls.filter(([key]) => key === PLATFORM_KEY).length;

  it.each(['throws', 'malformed', 'not-an-object'] as const)(
    'is not served from a tolerated failed read of the platform scope (%s)',
    async (how) => {
      const { m, store, state } = cached();
      if (how === 'throws') state.fail = true;
      else store.set(PLATFORM_KEY, how === 'malformed' ? 'not json' : '[]');
      // The platform scope keeps its tolerance: an unreadable document reads as empty.
      await expect(m.getAll('rate-limit', PLATFORM)).resolves.toMatchObject({ locked: [] });
      // The same manager, within the cache lifetime, must not take that as "no locks".
      await expect(m.getAll('rate-limit', TENANT)).rejects.toThrow();
      await expect(
        m.patch(
          'rate-limit',
          TENANT,
          { ifMatch: generateVersion({ [MAX]: 9 }), set: { [MAX]: 4 } },
          't'
        )
      ).rejects.toThrow();

      // Mended: the lock is enforced again.
      state.fail = false;
      store.set(PLATFORM_KEY, JSON.stringify({ [MAX]: 5, [LOCK]: [MAX] }));
      const view = await m.getAll('rate-limit', TENANT);
      expect(view.values[MAX]).toBe(5);
      expect(view.locked).toEqual([MAX]);
    }
  );

  it('still caches a successful platform read, and reuses it', async () => {
    const { m, store, get } = cached();
    store.set(PLATFORM_KEY, JSON.stringify({ [MAX]: 5, [LOCK]: [MAX] }));
    await m.getAll('rate-limit', PLATFORM);
    await m.getAll('rate-limit', TENANT);
    await m.getAll('rate-limit', TENANT);
    expect(platformGets(get)).toBe(1);
  });

  it.each([
    ['with parents', true],
    ['without parents', false],
  ])(
    'checks a write against the current lock list, not a cached one (%s)',
    async (_name, withParents) => {
      const { m, store } = cached();
      const options = withParents ? { parents: settingsParentScopes('rate-limit', TENANT) } : {};
      // The manager caches a platform document without locks (a read the same way) ...
      expect((await m.getAll('rate-limit', TENANT, options)).values[MAX]).toBe(9);
      // ... then the platform locks the key behind its back: its cache is stale.
      store.set(PLATFORM_KEY, JSON.stringify({ [MAX]: 5, [LOCK]: [MAX] }));
      const refused = await m.patch(
        'rate-limit',
        TENANT,
        { ifMatch: generateVersion({ [MAX]: 9 }), set: { [MAX]: 4 } },
        't',
        options
      );
      expect(isLockedByPlatformReason(refused.rejected[MAX])).toBe(true);
    }
  );
});

describe('lock and unlock', () => {
  it('locks and unlocks lockable keys, covered by the version and audited', async () => {
    const audit = vi.fn(async (_e: SettingsAuditEvent) => {});
    const { m } = manager({ 'settings:platform:rate-limit': { [MAX]: 5 } }, { audit });
    const v0 = (await read(m, 'rate-limit', PLATFORM)).version;

    const locked = await m.patch('rate-limit', PLATFORM, { ifMatch: v0, lock: [MAX, WINDOW] }, 'p');
    expect(locked.locked).toEqual([MAX, WINDOW]);
    expect(locked.unlocked).toEqual([]);
    expect(locked.version).not.toBe(v0);
    const after = await read(m, 'rate-limit', PLATFORM);
    expect(after.locked).toEqual([MAX, WINDOW]);
    expect(after.version).toBe(locked.version);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].diff[`locked:${MAX}`]).toEqual({ before: false, after: true });

    // A stale version is a conflict, as for any change of the document.
    await expect(
      m.patch('rate-limit', PLATFORM, { ifMatch: v0, unlock: [MAX] }, 'p')
    ).rejects.toBeInstanceOf(ConflictError);

    const unlocked = await m.patch(
      'rate-limit',
      PLATFORM,
      { ifMatch: after.version, unlock: [WINDOW] },
      'p'
    );
    expect(unlocked.unlocked).toEqual([WINDOW]);
    expect((await read(m, 'rate-limit', PLATFORM)).locked).toEqual([MAX]);
    expect(audit.mock.calls[1][0].diff[`locked:${WINDOW}`]).toEqual({ before: true, after: false });
  });

  it('removes the list from the document when nothing is locked, and is a no-op for a repeat', async () => {
    const { m, store } = manager({ 'settings:platform:rate-limit': { [MAX]: 5, [LOCK]: [MAX] } });
    const v = (await read(m, 'rate-limit', PLATFORM)).version;
    const noop = await m.patch('rate-limit', PLATFORM, { ifMatch: v, lock: [MAX] }, 'p');
    expect(noop.locked).toEqual([]);
    expect(noop.version).toBe(v);
    const done = await m.patch('rate-limit', PLATFORM, { ifMatch: v, unlock: [MAX] }, 'p');
    expect(done.unlocked).toEqual([MAX]);
    expect(JSON.parse(store.get('settings:platform:rate-limit')!)).toEqual({ [MAX]: 5 });
  });

  it('refuses to lock an unknown, non-lockable or platform-only key, and conflicting operations', async () => {
    const { m } = manager({});
    const v = generateVersion({});
    const result = await m.patch(
      'rate-limit',
      PLATFORM,
      {
        ifMatch: v,
        lock: [
          'rate_limit.auth_max_failed_attempts',
          'rate_limit.lenient',
          'no.such.key',
          MAX,
          WINDOW,
        ],
        unlock: [WINDOW],
      },
      'p'
    );
    expect(result.locked).toEqual([MAX]);
    expect(result.rejected['rate_limit.auth_max_failed_attempts']).toMatch(/cannot be locked/);
    expect(result.rejected['rate_limit.lenient']).toMatch(/cannot be locked/);
    expect(result.rejected['no.such.key']).toMatch(/Unknown/);
    expect(result.rejected[WINDOW]).toMatch(/Conflicting/);
  });

  it('refuses lock and unlock at a tenant scope', async () => {
    const { m } = manager({ 'settings:platform:rate-limit': { [LOCK]: [MAX] } });
    const v = (await read(m, 'rate-limit', TENANT)).version;
    const result = await m.patch(
      'rate-limit',
      TENANT,
      { ifMatch: v, unlock: [MAX], lock: [WINDOW] },
      't',
      {
        parents: settingsParentScopes('rate-limit', TENANT),
      }
    );
    expect(result.rejected[MAX]).toMatch(/platform scope/);
    expect(result.rejected[WINDOW]).toMatch(/platform scope/);
    expect((await read(m, 'rate-limit', PLATFORM)).locked).toEqual([MAX]);
  });

  it('keeps the list through the canonical store and its KV projection', async () => {
    const docs = new Map<string, { data: Record<string, unknown>; version: string }>();
    const keyOf = (category: string, scope: SettingScope) => settingsStorageKey(category, scope);
    const store = {
      load: vi.fn(async (c: string, s: SettingScope) => docs.get(keyOf(c, s)) ?? null),
      create: vi.fn(
        async (
          c: string,
          s: SettingScope,
          d: { data: Record<string, unknown>; version: string }
        ) => {
          if (!docs.has(keyOf(c, s))) docs.set(keyOf(c, s), d);
          return docs.get(keyOf(c, s)) ?? d;
        }
      ),
      compareAndSet: vi.fn(
        async (
          c: string,
          s: SettingScope,
          expected: string,
          d: { data: Record<string, unknown>; version: string }
        ) => {
          if ((docs.get(keyOf(c, s))?.version ?? generateVersion({})) !== expected) return false;
          docs.set(keyOf(c, s), d);
          return true;
        }
      ),
      markProjected: vi.fn(async () => {}),
      markPending: vi.fn(async () => {}),
    };
    const { kv, store: kvStore } = memoryKv();
    const m = new SettingsManager({ env: {}, kv, cacheTTL: 0, canonicalStore: store });
    for (const meta of Object.values(ALL_CATEGORY_META)) m.registerCategory(meta);
    const v = (await read(m, 'rate-limit', PLATFORM)).version;
    const result = await m.patch(
      'rate-limit',
      PLATFORM,
      { ifMatch: v, set: { [MAX]: 5 }, lock: [MAX] },
      'p'
    );
    expect(result.projection).toBeUndefined();
    const canonical = docs.get('settings:platform:rate-limit')!;
    expect(canonical.data[LOCK]).toEqual([MAX]);
    expect(canonical.version).toBe(generateVersion(canonical.data));
    expect(
      (JSON.parse(kvStore.get('settings:platform:rate-limit')!) as Record<string, unknown>)[LOCK]
    ).toEqual([MAX]);

    // A runtime reader of the projected KV alone enforces it.
    const tenantDoc = { [MAX]: 9 };
    kvStore.set('settings:tenant:acme:rate-limit', JSON.stringify(tenantDoc));
    const limit = await resolveEmailSendLimit({ SETTINGS: kv }, 'acme');
    expect(limit.maxRequests).toBe(5);
  });
});

describe('the lockable keys', () => {
  it('are settable by tenants, in a category that has a platform scope', () => {
    const lockable: string[] = [];
    for (const [category, meta] of Object.entries(ALL_CATEGORY_META)) {
      for (const setting of Object.values(meta.settings) as Array<{
        key: string;
        lockable?: boolean;
        scopes?: string[];
      }>) {
        if (!setting.lockable) continue;
        lockable.push(setting.key);
        expect(isCategoryAvailableAtScope(category as CategoryName, 'platform'), setting.key).toBe(
          true
        );
        expect(isCategoryAvailableAtScope(category as CategoryName, 'tenant'), setting.key).toBe(
          true
        );
        expect(setting.scopes ? setting.scopes.includes('tenant') : true, setting.key).toBe(true);
        expect(CATEGORY_SCOPE_CONFIG[category as CategoryName]).toBeDefined();
      }
    }
    expect(lockable.sort()).toEqual([HTTPS_DOMAINS, HTTPS_ENABLED, MAX, WINDOW].sort());
  });
});

describe('getTenantSettingsDocument', () => {
  const THEME = 'tenant-discovery-ui.theme';
  const TITLE = 'tenant-discovery-ui.page_title';
  const stores = (platform: Record<string, unknown> | null) =>
    ({
      SETTINGS: memoryKv({
        ...(platform ? { 'settings:platform:tenant-discovery-ui': platform } : {}),
        'settings:tenant:acme:tenant-discovery-ui': { [THEME]: 'dark', [TITLE]: 'Tenant' },
      }).kv,
    }) as never;

  it('gives a locked key the platform value (or leaves it unset), never the reserved field', async () => {
    // No key of these categories is lockable yet: mark one for this test only.
    const meta = ALL_CATEGORY_META['tenant-discovery-ui'].settings as Record<
      string,
      { lockable?: boolean }
    >;
    meta[THEME].lockable = true;
    try {
      expect(
        await getTenantSettingsDocument(
          stores({ [THEME]: 'light', [TITLE]: 'Platform', [LOCK]: [THEME, TITLE] }),
          'acme',
          'tenant-discovery-ui'
        )
      ).toEqual({ [THEME]: 'light', [TITLE]: 'Tenant' });
      // Locked, with no platform value: the tenant's is dropped.
      expect(
        await getTenantSettingsDocument(stores({ [LOCK]: [THEME] }), 'acme', 'tenant-discovery-ui')
      ).toEqual({ [TITLE]: 'Tenant' });
    } finally {
      delete meta[THEME].lockable;
    }
  });

  it('ignores the list of a key that is not lockable, and strips the field', async () => {
    expect(
      await getTenantSettingsDocument(
        stores({ [THEME]: 'light', [LOCK]: [THEME] }),
        'acme',
        'tenant-discovery-ui'
      )
    ).toEqual({ [THEME]: 'dark', [TITLE]: 'Tenant' });
    expect(await getTenantSettingsDocument(stores(null), 'acme', 'tenant-discovery-ui')).toEqual({
      [THEME]: 'dark',
      [TITLE]: 'Tenant',
    });
  });
});

describe('readers', () => {
  const platformLocked = {
    'settings:platform:rate-limit': { [MAX]: 5, [WINDOW]: 1200, [LOCK]: [MAX, WINDOW] },
    'settings:tenant:acme:rate-limit': { [MAX]: 9, [WINDOW]: 3000 },
    'settings:platform:oauth': {
      [HTTPS_ENABLED]: false,
      [HTTPS_DOMAINS]: 'platform.example',
      [LOCK]: [HTTPS_ENABLED, HTTPS_DOMAINS],
    },
    'settings:tenant:acme:oauth': { [HTTPS_ENABLED]: true, [HTTPS_DOMAINS]: 'tenant.example' },
    'settings:client:acme:app:oauth': { [HTTPS_ENABLED]: true, [HTTPS_DOMAINS]: 'client.example' },
  };

  it('resolveEmailSendLimit (the e-mail send limit of every code flow): the platform value wins', async () => {
    const { kv } = memoryKv(platformLocked);
    expect(await resolveEmailSendLimit({ SETTINGS: kv }, 'acme')).toEqual({
      maxRequests: 5,
      windowSeconds: 1200,
    });
  });

  it('resolveEmailSendLimit: an unreadable tenant document does not loosen a locked limit', async () => {
    const { kv, store } = memoryKv({
      'settings:platform:rate-limit': { [MAX]: 5, [WINDOW]: 1200, [LOCK]: [MAX, WINDOW] },
    });
    store.set('settings:tenant:acme:rate-limit', 'not json');
    expect(await resolveEmailSendLimit({ SETTINGS: kv }, 'acme')).toEqual({
      maxRequests: 5,
      windowSeconds: 1200,
    });
  });

  it('resolveEmailSendLimit: with the platform document unreadable too, the defaults stand', async () => {
    const { kv, store } = memoryKv();
    store.set('settings:platform:rate-limit', 'not json');
    store.set('settings:tenant:acme:rate-limit', 'not json');
    expect(await resolveEmailSendLimit({ SETTINGS: kv }, 'acme')).toEqual({
      maxRequests: 3,
      windowSeconds: 900,
    });
  });

  it('resolveProtocolSettings throws when the tenant layer cannot be read (authorize fails closed)', async () => {
    const { kv, store } = memoryKv({
      'settings:platform:oauth': { [HTTPS_ENABLED]: false, [LOCK]: [HTTPS_ENABLED] },
    });
    store.set('settings:tenant:acme:oauth', 'not json');
    await expect(
      resolveProtocolSettings({ SETTINGS: kv }, 'acme', { keys: [HTTPS_ENABLED] })
    ).rejects.toThrow();
  });

  describe('when the tenant layer cannot be read', () => {
    const broke = (platform: Record<string, unknown>) => {
      const { kv, store } = memoryKv(platform);
      store.set('settings:tenant:acme:rate-limit', 'not json');
      return { SETTINGS: kv };
    };

    it('keeps the old defaults for settings that are not locked', async () => {
      const env = broke({
        'settings:platform:rate-limit': {
          [MAX]: 5,
          [WINDOW]: 1200,
          'rate_limit.totp_max_requests': 100,
          'rate_limit.totp_window': 60,
        },
      });
      expect(await resolveEmailSendLimit(env, 'acme')).toEqual({
        maxRequests: 3,
        windowSeconds: 900,
      });
      expect(await resolveTotpAttemptLimit(env, 'acme')).toEqual({
        maxRequests: 10,
        windowSeconds: 900,
      });
    });

    it('takes only the locked key from the platform', async () => {
      const env = broke({
        'settings:platform:rate-limit': { [MAX]: 5, [WINDOW]: 1200, [LOCK]: [MAX] },
      });
      expect(await resolveEmailSendLimit(env, 'acme')).toEqual({
        maxRequests: 5,
        windowSeconds: 900,
      });
    });
  });

  it('resolveEmailSendLimit: the tenant value applies again when the key is not locked', async () => {
    const { kv } = memoryKv({
      ...platformLocked,
      'settings:platform:rate-limit': { [MAX]: 5, [WINDOW]: 1200 },
    });
    expect(await resolveEmailSendLimit({ SETTINGS: kv }, 'acme')).toEqual({
      maxRequests: 9,
      windowSeconds: 3000,
    });
  });

  it('resolveProtocolSettings (HTTPS request_uri of authorize): the platform value wins for a client', async () => {
    const { kv } = memoryKv(platformLocked);
    const settings = await resolveProtocolSettings({ SETTINGS: kv }, 'acme', {
      clientId: 'app',
      keys: [HTTPS_ENABLED, HTTPS_DOMAINS],
    });
    expect(settings.oidc.httpsRequestUri?.enabled).toBe(false);
    expect(settings.oidc.httpsRequestUri?.allowedDomains).toEqual(['platform.example']);
  });

  it('resolveProtocolSettings reads a locked key the platform never set as unset (env applies in the reader)', async () => {
    const { kv } = memoryKv({
      'settings:platform:oauth': { [LOCK]: [HTTPS_ENABLED] },
      'settings:tenant:acme:oauth': { [HTTPS_ENABLED]: true },
    });
    const settings = await resolveProtocolSettings({ SETTINGS: kv }, 'acme', {
      keys: [HTTPS_ENABLED],
    });
    expect(settings.oidc.httpsRequestUri?.enabled).toBeUndefined();
  });

  it('composes with the Default profile layer: each layer decides its own keys', async () => {
    const { kv } = memoryKv({
      'settings:platform:profiles': { 'profiles.session.tenant_change_allowed': false },
      'settings:platform:oauth': {
        'oauth.sso_enabled': true,
        [HTTPS_ENABLED]: false,
        [LOCK]: [HTTPS_ENABLED],
      },
      'settings:tenant:acme:oauth': { 'oauth.sso_enabled': false, [HTTPS_ENABLED]: true },
    });
    const set = await resolveEffectiveSettingsWithSources({ SETTINGS: kv }, 'oauth', {
      tenantId: 'acme',
    });
    // The Default layer sets the tenant's value aside for its key; the lock does so for its own.
    expect(set.values['oauth.sso_enabled']).toBe(true);
    expect(set.values[HTTPS_ENABLED]).toBe(false);
    expect(set.sources[HTTPS_ENABLED]).toBe('platform');

    const open = memoryKv({
      'settings:platform:oauth': {
        'oauth.sso_enabled': true,
        [HTTPS_ENABLED]: false,
        [LOCK]: [HTTPS_ENABLED],
      },
      'settings:tenant:acme:oauth': { 'oauth.sso_enabled': false, [HTTPS_ENABLED]: true },
    });
    const free = await resolveEffectiveSettings({ SETTINGS: open.kv }, 'oauth', {
      tenantId: 'acme',
    });
    // The Default layer honours the tenant's value; the lock still holds for its key.
    expect(free['oauth.sso_enabled']).toBe(false);
    expect(free[HTTPS_ENABLED]).toBe(false);
  });
});

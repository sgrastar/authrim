import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  buildTenantSystemSettingsKey,
  generateVersion,
  projectLatestSettingsDocument,
  requireDedicatedAdminDatabaseAdapter,
  resolveProtocolSettings,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, createAuditLogFromContext: vi.fn(async () => undefined) };
});

import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import {
  applyCertificationProfileHandler,
  listCertificationProfilesHandler,
} from '../routes/certification-profiles';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import { createSettingsCanonicalD1 } from './helpers/settings-canonical-d1';

function environment(saved: Record<string, unknown>) {
  const store = new Map<string, string>(
    Object.entries(saved).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  );
  const SETTINGS = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
  const env = { SETTINGS, DB_ADMIN: createSettingsCanonicalD1() } as unknown as Env;
  return { env, store };
}

function app(tenantId = 'fapi2') {
  const hono = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  hono.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: unknown) => void }).set('tenantId', tenantId);
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      roles: ['system_admin'],
    } as AdminAuthContext);
    await next();
  });
  hono.get('/api/admin/certification-profiles', listCertificationProfilesHandler);
  hono.post('/api/admin/certification-profiles/:id/apply', applyCertificationProfileHandler);
  return hono;
}

const apply = (env: Env, id: string) =>
  app().request(`/api/admin/certification-profiles/${id}/apply`, { method: 'POST' }, env);

describe('certification profiles API', () => {
  it('lists each profile with its id and the settings it sets', async () => {
    const response = await app().request('/api/admin/certification-profiles', {}, {} as Env);
    const body = (await response.json()) as {
      profiles: Array<{ id: string; settings: Record<string, Record<string, unknown>> }>;
    };
    expect(
      body.profiles.find((profile) => profile.id === 'fapi-2')?.settings.security
    ).toMatchObject({ 'security.fapi_enabled': true, 'security.par_required': true });
  });

  it("saves the profile as the tenant's settings and clears the managed ones it leaves out", async () => {
    const globalSettings = { fapi: { enabled: false }, oidc: { requirePar: false } };
    const { env, store } = environment({
      system_settings: globalSettings,
      // The tenant's own values: one the profile manages but leaves out, one it does not manage.
      'settings:tenant:fapi2:security': {
        'security.fapi_strict_dpop': false,
        'security.pkce_required': true,
      },
      // An older profile: its fapi and oidc sections would apply what the new one leaves out.
      [buildTenantSystemSettingsKey('fapi2')]: {
        fapi: { enabled: true, requireDpop: true, strictDPoP: false },
        oidc: { requirePar: true, allowNoneAlgorithm: true },
        conformance: { enabled: true },
      },
    });

    const response = await apply(env, 'fapi-2');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profile: { id: 'fapi-2', name: 'FAPI 2.0' },
      tenant_id: 'fapi2',
    });
    expect(JSON.parse(store.get('settings:tenant:fapi2:security')!)).toEqual(
      expect.objectContaining({
        'security.fapi_enabled': true,
        'security.dpop_required': 'never',
        'security.par_required': true,
        'security.pkce_required': true,
      })
    );
    expect(JSON.parse(store.get('settings:tenant:fapi2:security')!)).not.toHaveProperty(
      'security.fapi_strict_dpop'
    );
    // Only the replaced sections leave the older profile; the global document is untouched.
    expect(JSON.parse(store.get(buildTenantSystemSettingsKey('fapi2'))!)).toEqual({
      conformance: { enabled: true },
    });
    expect(JSON.parse(store.get('system_settings')!)).toEqual(globalSettings);
    // Removing them is recorded, with what was removed.
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'settings.certification_profile_sections_removed',
      'settings',
      'tenant:fapi2:certification-profile',
      expect.objectContaining({
        profile: 'fapi-2',
        removed: {
          fapi: { enabled: true, requireDpop: true, strictDPoP: false },
          oidc: { requirePar: true, allowNoneAlgorithm: true },
        },
      })
    );

    // Runtime reads the profile.
    const settings = await resolveProtocolSettings(env, 'fapi2', { sections: ['fapi', 'oidc'] });
    expect(settings.fapi).toMatchObject({
      enabled: true,
      requireDpop: false,
      clientAssertionAudience: 'issuer',
    });
    expect(settings.fapi).not.toHaveProperty('strictDPoP');
    expect(settings.oidc).toMatchObject({ requirePar: true, allowNoneAlgorithm: false });
  });

  it('clears what one profile set when another one leaves it out', async () => {
    const { env, store } = environment({});
    expect((await apply(env, 'fapi-2-client-credentials-dpop')).status).toBe(200);
    expect(JSON.parse(store.get('settings:tenant:fapi2:feature-flags')!)).toMatchObject({
      'feature.enable_client_credentials': true,
    });

    expect((await apply(env, 'basic-op')).status).toBe(200);
    expect(JSON.parse(store.get('settings:tenant:fapi2:feature-flags') ?? '{}')).not.toHaveProperty(
      'feature.enable_client_credentials'
    );
    expect(JSON.parse(store.get('settings:tenant:fapi2:security')!)).toMatchObject({
      'security.fapi_enabled': false,
      'security.allow_unsigned_request_object': true,
    });
  });

  it.each([
    ['its own security settings', 'settings:tenant:fapi2:security'],
    ["the platform's oauth settings", 'settings:platform:oauth'],
  ])('changes nothing when %s cannot be read', async (_what, key) => {
    const { env, store } = environment({ [key]: '[]' });

    const response = await apply(env, 'fapi-2');

    expect(response.status).toBe(503);
    expect(store.has('settings:tenant:fapi2:oauth')).toBe(false);
    expect(store.get('settings:tenant:fapi2:security') ?? '[]').toBe('[]');
  });

  it('changes nothing when the older profile cannot be read', async () => {
    const { env, store } = environment({ [buildTenantSystemSettingsKey('fapi2')]: '[]' });

    const response = await apply(env, 'fapi-2');

    expect(response.status).toBe(503);
    expect(store.has('settings:tenant:fapi2:security')).toBe(false);
  });

  describe('without a transaction across categories', () => {
    afterEach(() => vi.restoreAllMocks());

    it('names what was applied when a later category cannot be saved', async () => {
      const { env } = environment({});
      // Reading creates a missing document; saving compares and sets it.
      for (const method of ['compareAndSet'] as const) {
        const original = DatabaseSettingsCanonicalStore.prototype[method];
        vi.spyOn(DatabaseSettingsCanonicalStore.prototype, method).mockImplementation(function (
          this: DatabaseSettingsCanonicalStore,
          ...args: unknown[]
        ) {
          if (args[0] === 'oauth') return Promise.reject(new Error('d1 unavailable'));
          return (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
        } as never);
      }

      const response = await apply(env, 'fapi-2');

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: 'temporarily_unavailable',
        partially_applied: ['security'],
      });
    });

    it('does not report success when another apply lands in between', async () => {
      const { env } = environment({
        [buildTenantSystemSettingsKey('fapi2')]: { fapi: { enabled: true } },
      });
      // Another apply saves its profile while this one tidies the older profile.
      const del = env.SETTINGS!.delete as unknown as ReturnType<typeof vi.fn>;
      const original = del.getMockImplementation() as (key: string) => Promise<void>;
      let other: Promise<Response> | undefined;
      del.mockImplementation(async (key: string) => {
        if (!other) {
          other = Promise.resolve(apply(env, 'basic-op'));
          await other;
        }
        return original(key);
      });

      const response = await apply(env, 'fapi-2');

      expect((await other)?.status).toBe(200);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: 'conflict' });
    });

    it('does not report success while runtime cannot see the saved values yet', async () => {
      const { env } = environment({});
      const put = env.SETTINGS!.put as unknown as ReturnType<typeof vi.fn>;
      const original = put.getMockImplementation() as (key: string, value: string) => Promise<void>;
      put.mockImplementation(async (key: string, value: string) => {
        if (key === 'settings:tenant:fapi2:security') throw new Error('kv unavailable');
        return original(key, value);
      });

      const response = await apply(env, 'fapi-2');

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error_description: string };
      expect(body.error_description).toContain('not yet in effect for security');
    });

    it('does not take a save between its reads and its snapshot as in place', async () => {
      const { env, store } = environment({});
      const original = DatabaseSettingsCanonicalStore.prototype.snapshot;
      let saved = false;
      vi.spyOn(DatabaseSettingsCanonicalStore.prototype, 'snapshot').mockImplementation(
        async function (this: DatabaseSettingsCanonicalStore, categories, scope) {
          if (!saved) {
            // A PATCH turns client credentials on after the profile read the feature flags.
            saved = true;
            const current = await this.load('feature-flags', scope);
            const data = { 'feature.enable_client_credentials': true };
            await this.compareAndSet('feature-flags', scope, current!.version, {
              data,
              version: generateVersion(data),
            });
          }
          return original.call(this, categories, scope);
        }
      );

      const response = await apply(env, 'basic-op');

      expect(response.status).toBe(409);
      expect(store.has('settings:tenant:fapi2:security')).toBe(false);
    });

    it('does not report success until a cleared value is in the KV runtime reads', async () => {
      const { env, store } = environment({});
      expect((await apply(env, 'fapi-2-client-credentials-dpop')).status).toBe(200);
      const put = env.SETTINGS!.put as unknown as ReturnType<typeof vi.fn>;
      const original = put.getMockImplementation() as (key: string, value: string) => Promise<void>;
      let broken = true;
      put.mockImplementation(async (key: string, value: string) => {
        if (broken && key === 'settings:tenant:fapi2:feature-flags') {
          throw new Error('kv unavailable');
        }
        return original(key, value);
      });

      // The clear is saved, but its copy to KV fails: runtime still has client credentials on.
      expect((await apply(env, 'basic-op')).status).toBe(503);
      // Applied again, nothing is left to save, but the copy still fails.
      expect((await apply(env, 'basic-op')).status).toBe(503);

      broken = false;
      expect((await apply(env, 'basic-op')).status).toBe(200);
      expect(
        JSON.parse(store.get('settings:tenant:fapi2:feature-flags') ?? '{}')
      ).not.toHaveProperty('feature.enable_client_credentials');
    });

    it('writes each key once, as KV refuses a second write within a second', async () => {
      const { env } = environment({
        [buildTenantSystemSettingsKey('fapi2')]: { fapi: { enabled: true } },
      });
      const put = env.SETTINGS!.put as unknown as ReturnType<typeof vi.fn>;
      const original = put.getMockImplementation() as (key: string, value: string) => Promise<void>;
      const written = new Map<string, number>();
      put.mockImplementation(async (key: string, value: string) => {
        const last = written.get(key);
        if (last !== undefined && Date.now() - last < 1000)
          throw new Error('429 Too Many Requests');
        written.set(key, Date.now());
        return original(key, value);
      });

      const response = await apply(env, 'fapi-2-client-credentials-dpop');

      expect(response.status).toBe(200);
    });

    it('names what was applied when the older profile cannot be tidied', async () => {
      const { env } = environment({
        [buildTenantSystemSettingsKey('fapi2')]: { fapi: { enabled: true } },
      });
      (env.SETTINGS!.delete as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('kv unavailable')
      );

      const response = await apply(env, 'fapi-2');

      expect(response.status).toBe(503);
      const body = (await response.json()) as { partially_applied: string[] };
      expect(body.partially_applied).toEqual(expect.arrayContaining(['security', 'oauth']));
    });
  });

  it('applies only once what the tenant inherits from the platform is in effect', async () => {
    const { env, store } = environment({
      'settings:platform:security': { 'security.fapi_strict_dpop': false },
    });
    // Saved for the platform, but not yet copied to the KV runtime reads.
    const canonical = new DatabaseSettingsCanonicalStore(
      requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    );
    const data = { 'security.fapi_strict_dpop': true };
    await canonical.create(
      'security',
      { type: 'platform' },
      { data, version: generateVersion(data) }
    );
    const put = env.SETTINGS!.put as unknown as ReturnType<typeof vi.fn>;
    const original = put.getMockImplementation() as (key: string, value: string) => Promise<void>;
    let broken = true;
    put.mockImplementation(async (key: string, value: string) => {
      if (broken && key === 'settings:platform:security') throw new Error('kv unavailable');
      return original(key, value);
    });

    const refused = await apply(env, 'fapi-2');
    expect(refused.status).toBe(503);
    expect(store.has('settings:tenant:fapi2:security')).toBe(false);

    broken = false;
    expect((await apply(env, 'fapi-2')).status).toBe(200);
    expect(JSON.parse(store.get('settings:platform:security')!)).toEqual(data);
  });

  it('removes nothing from the older profile it could not record removing', async () => {
    const older = { fapi: { enabled: true }, conformance: { enabled: true } };
    const { env, store } = environment({ [buildTenantSystemSettingsKey('fapi2')]: older });
    // The settings saves record their own audit; recording the removal fails once.
    let failed = false;
    vi.mocked(createAuditLogFromContext).mockImplementation(async (_c, action) => {
      if (action === 'settings.certification_profile_sections_removed' && !failed) {
        failed = true;
        throw new Error('audit unavailable');
      }
    });

    expect((await apply(env, 'fapi-2')).status).toBe(503);
    expect(JSON.parse(store.get(buildTenantSystemSettingsKey('fapi2'))!)).toEqual(older);

    // Applied again, it is recorded and removed.
    expect((await apply(env, 'fapi-2')).status).toBe(200);
    expect(JSON.parse(store.get(buildTenantSystemSettingsKey('fapi2'))!)).toEqual({
      conformance: { enabled: true },
    });
  });

  it('updates a canonical copy of the older profile, which its scheduled copy writes to KV', async () => {
    const older = { fapi: { enabled: true, strictDPoP: false }, conformance: { enabled: true } };
    const { env, store } = environment({ [buildTenantSystemSettingsKey('fapi2')]: older });
    const canonical = new DatabaseSettingsCanonicalStore(
      requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    );
    const scope = { type: 'tenant' as const, id: 'fapi2' };
    await canonical.create('certification-profile', scope, {
      data: older,
      version: generateVersion(older),
    });

    expect((await apply(env, 'fapi-2')).status).toBe(200);

    const rest = { conformance: { enabled: true } };
    expect((await canonical.load('certification-profile', scope))?.data).toEqual(rest);
    // The scheduled copy writes what the canonical copy holds: the sections stay removed.
    await projectLatestSettingsDocument(
      canonical,
      env.SETTINGS!,
      'certification-profile',
      scope,
      buildTenantSystemSettingsKey('fapi2')
    );
    expect(JSON.parse(store.get(buildTenantSystemSettingsKey('fapi2'))!)).toEqual(rest);
  });

  it('copies the updated older profile to KV before it reports success', async () => {
    const older = { fapi: { enabled: true, strictDPoP: false }, conformance: { enabled: true } };
    const key = buildTenantSystemSettingsKey('fapi2');
    const { env, store } = environment({ [key]: older });
    const canonical = new DatabaseSettingsCanonicalStore(
      requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    );
    await canonical.create(
      'certification-profile',
      { type: 'tenant', id: 'fapi2' },
      { data: older, version: generateVersion(older) }
    );
    const put = env.SETTINGS!.put as unknown as ReturnType<typeof vi.fn>;
    const original = put.getMockImplementation() as (key: string, value: string) => Promise<void>;
    let broken = true;
    put.mockImplementation(async (name: string, value: string) => {
      if (broken && name === key) throw new Error('kv unavailable');
      return original(name, value);
    });

    // The canonical copy is updated, but KV still has the removed sections.
    expect((await apply(env, 'fapi-2')).status).toBe(503);
    expect(JSON.parse(store.get(key)!)).toEqual(older);
    // Applied again, the copy is retried: still failing, still no success.
    expect((await apply(env, 'fapi-2')).status).toBe(503);

    broken = false;
    expect((await apply(env, 'fapi-2')).status).toBe(200);
    expect(JSON.parse(store.get(key)!)).toEqual({ conformance: { enabled: true } });
  });

  it('changes nothing when the canonical copy of the older profile cannot be read', async () => {
    const { env, store } = environment({
      [buildTenantSystemSettingsKey('fapi2')]: { fapi: { enabled: true } },
    });
    const original = DatabaseSettingsCanonicalStore.prototype.load;
    vi.spyOn(DatabaseSettingsCanonicalStore.prototype, 'load').mockImplementation(async function (
      this: DatabaseSettingsCanonicalStore,
      category,
      scope
    ) {
      if (category === 'certification-profile') throw new Error('settings_canonical_invalid');
      return original.call(this, category, scope);
    });

    const response = await apply(env, 'fapi-2');

    expect(response.status).toBe(503);
    expect(store.has('settings:tenant:fapi2:security')).toBe(false);
    expect(JSON.parse(store.get(buildTenantSystemSettingsKey('fapi2'))!)).toEqual({
      fapi: { enabled: true },
    });
    vi.restoreAllMocks();
  });

  it('changes nothing without the KV runtime reads settings from', async () => {
    const { env } = environment({});
    const withoutKv = { ...env, SETTINGS: undefined } as unknown as Env;

    const response = await apply(withoutKv, 'fapi-2');

    expect(response.status).toBe(503);
    const saved = await (env.DB_ADMIN as D1Database)
      .prepare('SELECT count(*) AS n FROM tenant_settings_documents')
      .first<{ n: number }>();
    expect(saved?.n).toBe(0);
  });

  it('refuses an unknown profile', async () => {
    const { env } = environment({});
    expect((await apply(env, 'constructor')).status).toBe(404);
  });
});

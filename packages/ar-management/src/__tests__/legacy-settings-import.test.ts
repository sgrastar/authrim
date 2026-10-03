import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  createAuditLog,
  LEGACY_IMPORT_CONTRACT,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, createAuditLog: vi.fn(async () => undefined) };
});

import {
  LegacyImportStateError,
  processLegacySettingsImport,
  readLegacyImportState,
  runLegacySettingsImport,
} from '../legacy-settings-import';
import settingsV2 from '../routes/settings-v2';
import { createSettingsCanonicalD1 } from './helpers/settings-canonical-d1';

function kv(data: Record<string, unknown> = {}, failing: string[] = []) {
  const store = new Map<string, string>(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  );
  return {
    store,
    namespace: {
      get: vi.fn(async (key: string) => {
        if (failing.includes(key)) throw new Error('kv unavailable');
        return store.get(key) ?? null;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(
        async ({
          prefix,
          limit = 1000,
          cursor,
        }: {
          prefix?: string;
          limit?: number;
          cursor?: string;
        }) => {
          const names = [...store.keys()]
            .filter((name) => !prefix || name.startsWith(prefix))
            .sort();
          // As KV's cursor: the page after the last key returned.
          const rest = cursor ? names.filter((name) => name > cursor) : names;
          const page = rest.slice(0, limit);
          return {
            keys: page.map((name) => ({ name })),
            list_complete: rest.length <= limit,
            cursor: page[page.length - 1],
          };
        }
      ),
    } as unknown as KVNamespace,
  };
}

function environment(
  settings: Record<string, unknown>,
  config: Record<string, unknown> = {},
  failing: string[] = []
) {
  const SETTINGS = kv(settings, failing);
  const AUTHRIM_CONFIG = kv(config);
  const env = {
    SETTINGS: SETTINGS.namespace,
    AUTHRIM_CONFIG: AUTHRIM_CONFIG.namespace,
    DB_ADMIN: createSettingsCanonicalD1(),
    ISSUER_URL: 'https://id.example.com',
    BASE_DOMAIN: 'example.com',
    RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('rate-limit-id'),
      get: vi.fn().mockReturnValue({
        incrementRpc: vi.fn().mockResolvedValue({
          allowed: true,
          current: 1,
          limit: 100,
          resetAt: Math.floor(Date.now() / 1000) + 60,
        }),
      }),
    },
  } as unknown as Env;
  return { env, settings: SETTINGS.store };
}

const saved = {
  system_settings: {
    fapi: { enabled: false, strictDPoP: false },
    ui: { baseUrl: 'https://evil.example.net' },
  },
  'settings:tenant:acme:certification-profile': { fapi: { enabled: true } },
  'settings:platform:oauth': { 'oauth.access_token_expiry': 600 },
};
const config = { 'oauth:config:TOKEN_EXPIRY': '900', 'oauth:config:AUTH_CODE_TTL': '120' };

const documentOf = (
  report: Awaited<ReturnType<typeof runLegacySettingsImport>>,
  scopeId: string | null,
  category: string
) =>
  report.documents.find(
    (document) => document.scopeId === scopeId && document.category === category
  );

const actor = 'admin';
const preview = (env: Env) => runLegacySettingsImport(env, { mode: 'dry_run', actor });
const runStep = (env: Env) => runLegacySettingsImport(env, { mode: 'run', actor });

describe('runLegacySettingsImport', () => {
  it('reports what it would write in a preview, and writes nothing', async () => {
    const { env, settings } = environment(saved, config);
    const before = new Map(settings);

    const report = await preview(env);

    expect(report.status).toBe('dry_run');
    // A value already set through the Settings API is kept.
    expect(documentOf(report, null, 'oauth')).toMatchObject({
      applied: ['oauth.auth_code_ttl'],
      kept: ['oauth.access_token_expiry'],
    });
    expect(documentOf(report, null, 'security')?.applied).toEqual(
      expect.arrayContaining(['security.fapi_enabled', 'security.fapi_strict_dpop'])
    );
    // A value a PATCH would refuse is reported, not written.
    expect(documentOf(report, null, 'tenant')?.rejected).toHaveProperty('tenant.ui_base_url');
    expect(documentOf(report, 'acme', 'security')?.applied).toContain('security.fapi_enabled');
    expect(settings).toEqual(before);
    // Not even a canonical document is created from what was read.
    const count = async (table: string) =>
      (
        await (env.DB_ADMIN as D1Database)
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n;
    await expect(count('tenant_settings_documents')).resolves.toBe(0);
    await expect(count('platform_settings_documents')).resolves.toBe(0);
  });

  it('refuses an older value no setting carries as runtime read it, instead of changing it', async () => {
    const { env, settings } = environment({
      system_settings: {
        fapi: {
          enabled: '__DISABLED__',
          messageSigning: { requestObjectSigningAlgorithms: ['ES256,PS256'] },
        },
      },
    });

    const report = await runStep(env);

    const security = documentOf(report, null, 'security');
    expect(Object.keys(security?.rejected ?? {}).sort()).toEqual([
      'security.fapi_enabled',
      'security.request_object_signing_algs',
    ]);
    expect(settings.get('settings:platform:security')).toBeUndefined();
  });

  it('bounds a preview however many tenant settings documents there are', async () => {
    const documents = Object.fromEntries(
      Array.from({ length: 3000 }, (_, index) => [
        `settings:tenant:t${String(index).padStart(4, '0')}:oauth`,
        {},
      ])
    );
    const { env } = environment(documents);

    const report = await preview(env);

    expect(report.truncated).toBe(true);
    expect(vi.mocked(env.SETTINGS!.list).mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('writes the platform stores and tenant profiles, keeping values already set', async () => {
    const clean = { ...saved, system_settings: { fapi: { enabled: false, strictDPoP: false } } };
    const { env, settings } = environment(clean, config);

    const report = await runStep(env);

    expect(report.status).toBe('completed');
    expect(JSON.parse(settings.get('settings:platform:oauth')!)).toMatchObject({
      'oauth.access_token_expiry': 600,
      'oauth.auth_code_ttl': 120,
    });
    // The dependency (FAPI on) is not checked: the value applied to tenants that turn FAPI on.
    expect(JSON.parse(settings.get('settings:platform:security')!)).toMatchObject({
      'security.fapi_enabled': false,
      'security.fapi_strict_dpop': false,
    });
    // The profile's section, with the fields it leaves out at what applied (the defaults).
    expect(JSON.parse(settings.get('settings:tenant:acme:security')!)).toMatchObject({
      'security.fapi_enabled': true,
      'security.fapi_strict_dpop': true,
      'security.fapi_allow_public_clients': true,
      'security.require_signed_request_object': false,
    });
    await expect(readLegacyImportState(env)).resolves.toMatchObject({
      status: 'completed',
      actor,
    });

    // Completed: not run again.
    settings.set('system_settings', JSON.stringify({ fapi: { enabled: true } }));
    await expect(runStep(env)).resolves.toMatchObject({
      status: 'already_completed',
      documents: [],
    });
    expect(JSON.parse(settings.get('settings:platform:security')!)).toMatchObject({
      'security.fapi_enabled': false,
    });
  });

  it('runs again for what was added since a completed import of an earlier contract', async () => {
    const clean = { ...saved, system_settings: { fapi: { enabled: false, strictDPoP: false } } };
    const { env, settings } = environment(clean, config);
    expect((await runStep(env)).status).toBe('completed');

    // As if completed before the per-profile rate limits were imported.
    await (env.DB_ADMIN as unknown as D1Database)
      .prepare(
        "UPDATE settings_legacy_import_state SET state_json=json_remove(state_json,'$.contract')"
      )
      .run();
    const configKV = env.AUTHRIM_CONFIG as unknown as { put: (k: string, v: string) => unknown };
    await configKV.put('rate_limit_public_read_max_requests', '900');
    // Saved in the Settings API since: kept.
    settings.set(
      'settings:platform:oauth',
      JSON.stringify({
        ...JSON.parse(settings.get('settings:platform:oauth')!),
        'oauth.auth_code_ttl': 60,
      })
    );

    await processLegacySettingsImport(env);

    expect(JSON.parse(settings.get('settings:platform:rate-limit')!)).toMatchObject({
      'rate_limit.public_read': 900,
    });
    expect(JSON.parse(settings.get('settings:platform:oauth')!)).toMatchObject({
      'oauth.auth_code_ttl': 60,
    });
    const state = await readLegacyImportState(env);
    expect(state).toMatchObject({ status: 'completed', contract: LEGACY_IMPORT_CONTRACT });
    await expect(runStep(env)).resolves.toMatchObject({ status: 'already_completed' });
  });

  it('works through many tenants a page at a time, keeping its position', async () => {
    const profiles = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `settings:tenant:t${String(index).padStart(2, '0')}:certification-profile`,
        { fapi: { enabled: true } },
      ])
    );
    const { env, settings } = environment({ ...profiles });

    // At most 25 tenants a step, each step going on from where the last one stopped.
    const statuses: string[] = [];
    for (let steps = 0; steps < 10; steps += 1) {
      const report = await runStep(env);
      statuses.push(report.status);
      const tenants = new Set(
        report.documents.filter((document) => document.scope === 'tenant').map((d) => d.scopeId)
      );
      expect(tenants.size).toBeLessThanOrEqual(25);
      if (report.status !== 'in_progress') break;
    }
    expect(statuses).toEqual(['in_progress', 'in_progress', 'in_progress', 'completed']);
    for (let index = 0; index < 80; index += 1) {
      const key = `settings:tenant:t${String(index).padStart(2, '0')}:security`;
      expect(JSON.parse(settings.get(key)!), key).toMatchObject({ 'security.fapi_enabled': true });
    }
  });

  it('needs attention for sign-in defaults that are set per tenant, and saves none of them', async () => {
    const { env, settings } = environment({
      system_settings: {
        advanced: { passkeyEnabled: false },
        loginUI: { theme: 'dark' },
        general: { siteName: 'Example' },
      },
    });

    const report = await runStep(env);
    expect(report.status).toBe('needs_attention');
    expect(report.state?.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'platform',
          key: 'authentication-methods.passkey.login_enabled',
          reason: 'Not settable at platform scope',
        }),
        expect.objectContaining({ scope: 'platform', key: 'login-ui.theme' }),
        expect.objectContaining({ scope: 'platform', key: 'login-ui.brand_name' }),
      ])
    );
    expect(settings.has('settings:platform:authentication-methods')).toBe(false);
    expect(settings.has('settings:platform:login-ui')).toBe(false);
  });

  it('needs attention while values are refused, until an admin runs it again or accepts them', async () => {
    const { env, settings } = environment(saved, config);

    const report = await runStep(env);
    expect(report.status).toBe('needs_attention');
    expect(report.state?.rejected).toEqual([
      expect.objectContaining({ scope: 'platform', key: 'tenant.ui_base_url' }),
    ]);
    // The rest is saved.
    expect(JSON.parse(settings.get('settings:tenant:acme:security')!)).toMatchObject({
      'security.fapi_enabled': true,
    });
    // The scheduler leaves it alone.
    await processLegacySettingsImport(env);
    await expect(readLegacyImportState(env)).resolves.toMatchObject({
      status: 'needs_attention',
    });

    // Corrected, an admin's run starts it over and completes it.
    settings.set('system_settings', JSON.stringify({ fapi: { enabled: false } }));
    await expect(runStep(env)).resolves.toMatchObject({ status: 'completed' });
  });

  it('completes with the refusals accepted only when an admin says so, recorded first', async () => {
    const { env } = environment(saved, config);
    const accept = () => runLegacySettingsImport(env, { mode: 'accept_rejections', actor });
    await expect(accept()).rejects.toBeInstanceOf(LegacyImportStateError);
    await runStep(env);

    // When the record cannot be written, nothing is accepted.
    vi.mocked(createAuditLog).mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(accept()).rejects.toThrow('audit unavailable');
    await expect(readLegacyImportState(env)).resolves.toMatchObject({
      status: 'needs_attention',
    });

    vi.mocked(createAuditLog).mockClear();
    await expect(accept()).resolves.toMatchObject({
      status: 'completed',
      state: { acceptedRejections: true },
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        action: 'settings.legacy_import.rejections_accepted',
        userId: actor,
        metadata: expect.stringContaining('tenant.ui_base_url'),
      })
    );
  });

  it('stops a step whose state was changed meanwhile, instead of undoing the change', async () => {
    const profiles = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `settings:tenant:t${String(index).padStart(2, '0')}:certification-profile`,
        { fapi: { enabled: true } },
      ])
    );
    const { env } = environment(profiles);
    // Another step (or an admin) changes the state while this one lists the tenants.
    const list = vi.mocked(env.SETTINGS!.list);
    const original = list.getMockImplementation()!;
    list.mockImplementationOnce(async (options) => {
      await (env.DB_ADMIN as D1Database)
        .prepare('UPDATE settings_legacy_import_state SET revision=revision+1 WHERE id=1')
        .run();
      return original(options);
    });

    await expect(runStep(env)).rejects.toBeInstanceOf(LegacyImportStateError);
  });

  it('does not complete when a store cannot be read', async () => {
    const { env, settings } = environment(saved, config, ['system_settings']);

    await expect(runStep(env)).rejects.toThrow();
    expect(settings.has('settings:platform:security')).toBe(false);
    await expect(readLegacyImportState(env)).resolves.not.toMatchObject({ status: 'completed' });
  });
});

describe('/api/admin/platform/settings/legacy-import', () => {
  const appFor = (env: Env, roles: string[]) => {
    const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('adminAuth', { userId: 'admin', authMethod: 'bearer', roles } as AdminAuthContext);
      await next();
    });
    app.route('/api/admin', settingsV2);
    return (method: string, body?: unknown) =>
      app.request(
        '/api/admin/platform/settings/legacy-import',
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env
      );
  };

  it('previews by default and runs only when asked, for platform admins', async () => {
    const { env, settings } = environment(saved, config);
    const request = appFor(env, ['system_admin']);

    const previewed = await request('GET');
    expect(previewed.status).toBe(200);
    await expect(previewed.json()).resolves.toMatchObject({ status: 'dry_run' });
    await expect((await request('POST', {})).json()).resolves.toMatchObject({
      status: 'dry_run',
    });
    await expect(readLegacyImportState(env)).resolves.toBeNull();
    // Nothing to accept yet.
    expect((await request('POST', { acceptRejections: true })).status).toBe(409);

    const run = await request('POST', { dryRun: false });
    expect(run.status).toBe(200);
    await expect(run.json()).resolves.toMatchObject({ status: 'needs_attention' });
    const accepted = await request('POST', { acceptRejections: true });
    await expect(accepted.json()).resolves.toMatchObject({ status: 'completed' });
  });

  it('changes nothing while a backup or restore holds settings writes', async () => {
    const { env, settings } = environment(saved, config);
    const held = {
      ...env,
      TENANT_BACKUP_WRAPPING_KEY: 'enabled',
      CONTROL: {
        acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: false })),
        completeEnvironmentBackupMutationPermit: vi.fn(async () => {}),
      },
    } as unknown as Env;
    const before = new Map(settings);

    const response = await appFor(held, ['system_admin'])('POST', { dryRun: false });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'backup_mutation_unavailable',
    });
    expect(settings).toEqual(before);
    await expect(readLegacyImportState(env)).resolves.toBeNull();
  });

  it('refuses other admins, and answers 503 when a store cannot be read', async () => {
    const { env } = environment(saved, config);
    expect((await appFor(env, ['admin'])('POST', { dryRun: false })).status).toBe(403);

    const broken = environment(saved, config, ['system_settings']);
    expect((await appFor(broken.env, ['system_admin'])('GET')).status).toBe(503);
  });
});

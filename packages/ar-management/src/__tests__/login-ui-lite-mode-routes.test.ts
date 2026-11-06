import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LitePolicyStore } from '@authrim/ar-lib-core/durable-objects/LitePolicyStore';

interface RouteMockState {
  auth: Record<string, unknown>;
  recorded: string;
  issues: Array<{ code: string; subject?: string }>;
  required: { login: boolean; signup: boolean; reauth: boolean };
  recordSaves: Array<Record<string, unknown>>;
  failRecord: boolean;
  pendingProjection: boolean;
  leaseHeldDuringRecord: boolean[];
}

const mocks = vi.hoisted(() => {
  const state: RouteMockState = {
    auth: {},
    recorded: 'off',
    issues: [],
    required: { login: true, signup: false, reauth: false },
    recordSaves: [],
    failRecord: false,
    pendingProjection: false,
    leaseHeldDuringRecord: [],
  };
  return { state, writeAdminAuditLog: vi.fn(), invalidate: vi.fn() };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));
vi.mock('../lite-mode-readiness', () => ({
  evaluateLiteReadiness: vi.fn(async () => mocks.state.issues),
}));
vi.mock('../human-verification-guards', () => ({
  requiredHumanVerificationActions: vi.fn(async () => mocks.state.required),
}));
vi.mock('../routes/settings-v2/settings-support', () => ({
  getSettingsManager: () => ({
    getAll: async () => ({
      version: 'rev-1',
      values: { 'login-ui.lite_mode': mocks.state.recorded },
    }),
  }),
  invalidateAuthenticationMethodsCacheRevision: mocks.invalidate,
}));
vi.mock('../routes/settings-v2/tenant-settings-apply', () => ({
  applyTenantSettingsChange: async (input: {
    litePolicyRecord?: boolean;
    readBody: () => Promise<{ set: Record<string, unknown> }>;
  }) => {
    const body = await input.readBody();
    if (mocks.state.failRecord) return Response.json({ error: 'server_error' }, { status: 500 });
    mocks.state.leaseHeldDuringRecord.push(
      (await currentStore().getStatusRpc('tenant-a')).changeInProgress
    );
    if (mocks.state.pendingProjection) {
      return Response.json({ version: 'rev-2', projection: 'pending' });
    }
    mocks.state.recordSaves.push({ litePolicyRecord: input.litePolicyRecord, ...body.set });
    mocks.state.recorded = String(body.set['login-ui.lite_mode']);
    return Response.json({ version: 'rev-2' });
  },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getRateLimitProfileAsync: vi.fn(async (_env: unknown, profile: string) => ({ profile })),
    rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.state.auth);
        await next();
      },
    createErrorResponse: vi.fn((c: { json: (body: unknown, status: number) => Response }) =>
      c.json({ error: 'forbidden' }, 403)
    ),
  };
});

import { loginUILiteModeRouter } from '../routes/admin-management/login-ui-lite-mode';

class Storage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

const ADMIN = {
  userId: 'admin-1',
  authMethod: 'machine_access_token',
  actorType: 'machine',
  roles: [],
  permissions: ['admin:settings:read', 'admin:settings:write'],
  tenantScope: ['tenant-a'],
  tenantId: 'tenant-a',
};

let store: LitePolicyStore;
let kv: Map<string, string>;
function currentStore() {
  return store;
}
let env: Record<string, unknown>;

function call(method: string, body?: unknown) {
  return loginUILiteModeRouter.request(
    '/',
    {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env
  );
}

describe('lite Login UI switch route', () => {
  beforeEach(() => {
    mocks.state.auth = { ...ADMIN };
    mocks.state.recorded = 'off';
    mocks.state.issues = [];
    mocks.state.required = { login: true, signup: false, reauth: false };
    mocks.state.recordSaves = [];
    mocks.state.failRecord = false;
    mocks.state.pendingProjection = false;
    mocks.state.leaseHeldDuringRecord = [];
    mocks.writeAdminAuditLog.mockClear();
    mocks.invalidate.mockClear();
    store = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
    kv = new Map();
    env = {
      LITE_POLICY_STORE: { idFromName: (name: string) => name, get: () => store },
      SETTINGS: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => {
          kv.set(key, value);
        },
      },
    };
  });

  const switchOn = () => call('PUT', { mode: 'always' });

  it('reports the policy, the recorded mode and the readiness', async () => {
    mocks.state.issues = [{ code: 'not_released' }];
    const response = await call('GET');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      mode: 'off',
      policy_revision: 'initial',
      change_in_progress: false,
      recorded_mode: 'off',
      readiness: { ready: false, issues: [{ code: 'not_released' }] },
    });
  });

  it('refuses switching on while the tenant has something the lite UI cannot do', async () => {
    mocks.state.issues = [{ code: 'method_unsupported', subject: 'directory_password' }];
    const response = await call('PUT', { mode: 'always' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'lite_mode_unsupported',
      issues: [{ code: 'method_unsupported', subject: 'directory_password' }],
    });
    expect((await store.getStatusRpc('tenant-a')).snapshot.liteMode).toBe('off');
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
    expect(mocks.state.recordSaves).toEqual([]);
  });

  it('marks the tenant before publishing always, then records it', async () => {
    const response = await call('PUT', { mode: 'always' });
    expect(response.status).toBe(200);
    expect(await store.isEverLiteRpc('tenant-a')).toBe(true);
    // The outage record for runtimes that cannot reach any policy store object (never cleared).
    expect(kv.get('login_ui_lite_ever:tenant-a')).toBe('1');
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      mode: 'always',
      generation: 1,
      recorded: true,
      human_verification_required: { login: true, signup: false, reauth: false },
    });
    expect(body.policy_revision).not.toBe('initial');
    expect(mocks.state.recordSaves).toEqual([
      { litePolicyRecord: true, 'login-ui.lite_mode': 'always' },
    ]);
    expect(mocks.invalidate).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'login_ui_lite_mode'
    );
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'login_ui.lite_mode.changed',
        metadata: expect.objectContaining({ from: 'off', to: 'always' }) as unknown,
      })
    );
  });

  it('keeps the marker when the tenant is switched off', async () => {
    expect((await switchOn()).status).toBe(200);
    expect((await call('PUT', { mode: 'off' })).status).toBe(200);
    expect(await store.isEverLiteRpc('tenant-a')).toBe(true);
  });

  it('does not publish always when the marker cannot be written', async () => {
    store.markEverLiteRpc = async () => {
      throw new Error('down');
    };
    expect((await call('PUT', { mode: 'always' })).status).toBe(503);
    expect((await store.getStatusRpc('tenant-a')).snapshot.liteMode).toBe('off');
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
  });

  it('does not publish always when the KV outage record cannot be written', async () => {
    const marked = vi.spyOn(store, 'markEverLiteRpc');
    env.SETTINGS = {
      get: async (key: string) => kv.get(key) ?? null,
      put: async () => {
        throw new Error('kv down');
      },
    };
    expect((await call('PUT', { mode: 'always' })).status).toBe(503);
    expect(marked).not.toHaveBeenCalled();
    expect((await store.getStatusRpc('tenant-a')).snapshot.liteMode).toBe('off');
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
  });

  it('does not publish always without a KV namespace for the outage record', async () => {
    delete env.SETTINGS;
    expect((await call('PUT', { mode: 'always' })).status).toBe(503);
    expect((await store.getStatusRpc('tenant-a')).snapshot.liteMode).toBe('off');
  });

  it('keeps the switch when the console record cannot be written', async () => {
    mocks.state.failRecord = true;
    const response = await switchOn();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'always', recorded: false });
  });

  it('switches off without the compatibility check', async () => {
    await switchOn();
    mocks.state.issues = [{ code: 'not_released' }];
    const response = await call('PUT', { mode: 'off' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'off', generation: 2 });
    expect(mocks.state.recordSaves.at(-1)).toMatchObject({ 'login-ui.lite_mode': 'off' });
  });

  it('asks to retry while another change holds the lease', async () => {
    await store.acquireLeaseRpc('tenant-a');
    const response = await call('PUT', { mode: 'always' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'lite_mode_change_in_progress' });
  });

  it('refuses a mode that is not off or always', async () => {
    for (const mode of ['auto', '', null, true]) {
      expect((await call('PUT', { mode })).status).toBe(400);
    }
  });

  it('refuses switching without the policy store', async () => {
    env = {};
    const response = await call('PUT', { mode: 'always' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      issues: [{ code: 'policy_store_unavailable' }],
    });
  });

  it('requires edit permission on both the Login UI and the authentication methods', async () => {
    mocks.state.auth = { ...ADMIN, permissions: ['admin:settings:read'] };
    expect((await call('PUT', { mode: 'always' })).status).toBe(403);
    expect((await call('GET')).status).toBe(200);
    mocks.state.auth = { ...ADMIN, permissions: [] };
    expect((await call('GET')).status).toBe(403);
  });
});

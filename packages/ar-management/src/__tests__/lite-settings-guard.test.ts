import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LitePolicyStore } from '@authrim/ar-lib-core/durable-objects/LitePolicyStore';

const mocks = vi.hoisted((): { after: Record<string, unknown>; dryRunError: Error | null } => ({
  after: {},
  dryRunError: null,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  // One active tenant screen with a block only shown while email codes are on.
  const screen = {
    screen_key: 'login',
    screen_kind: 'login',
    fields_json: JSON.stringify([
      {
        field: 'x',
        label: 'X',
        required: false,
        block_type: 'account_profile_widget',
        display_condition: { mode: 'feature_enabled', feature: 'mail_otp' },
      },
    ]),
  };
  return {
    ...actual,
    createAuthContextFromHono: () => ({
      coreAdapter: {
        query: async (sql: string) => (sql.includes("tenant_id = 'default'") ? [] : [screen]),
      },
    }),
  };
});

vi.mock('../routes/settings-v2/settings-support', () => ({
  parsePatchRequest: (body: unknown) => body,
  getSettingsManager: () => ({
    patch: async () => {
      if (mocks.dryRunError) throw mocks.dryRunError;
      return { candidate: { before: {}, after: mocks.after } };
    },
  }),
}));

import {
  guardTenantSettingsChangeForLite,
  patchTouchesLiteMode,
} from '../routes/settings-v2/lite-settings-guard';

class Storage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

let store: LitePolicyStore;

async function goLite() {
  const lease = await store.acquireLeaseRpc('tenant-a');
  if (!lease.acquired) throw new Error('lease not acquired');
  await store.commitRpc({
    tenantId: 'tenant-a',
    token: lease.token,
    expectedGeneration: lease.generation,
    liteMode: 'always',
    humanVerificationRequired: { login: false, signup: false, reauth: false },
  });
}

function save(
  category: 'authentication-methods' | 'login-ui' | 'self-service',
  body: unknown,
  readBody: () => Promise<unknown> = async () => body
) {
  const app = new Hono();
  const saved = vi.fn(async () => Response.json({ saved: true }));
  app.patch('/', (c) =>
    guardTenantSettingsChangeForLite({
      c,
      tenantId: 'tenant-a',
      category,
      actor: 'admin-1',
      readBody,
      save: saved,
    })
  );
  const env = { LITE_POLICY_STORE: { idFromName: (n: string) => n, get: () => store } };
  return { response: app.request('/', { method: 'PATCH' }, env), saved };
}

describe('patchTouchesLiteMode', () => {
  it('sees the key in set, clear and disable', () => {
    expect(patchTouchesLiteMode({ set: { 'login-ui.lite_mode': 'always' } })).toBe(true);
    expect(patchTouchesLiteMode({ clear: ['login-ui.lite_mode'] })).toBe(true);
    expect(patchTouchesLiteMode({ disable: ['login-ui.lite_mode'] })).toBe(true);
    expect(patchTouchesLiteMode({ set: { 'login-ui.lite_logo': '' } })).toBe(false);
  });
});

describe('the lite guard on settings saves', () => {
  beforeEach(() => {
    store = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
    mocks.after = {};
    mocks.dryRunError = null;
  });

  it('saves anything for a tenant that is not in lite mode', async () => {
    mocks.after = { 'authentication-methods.did.login_enabled': true };
    const { response, saved } = save('authentication-methods', { ifMatch: 'v', set: {} });
    expect((await response).status).toBe(200);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('refuses switching DID sign-in on for a lite tenant', async () => {
    await goLite();
    mocks.after = { 'authentication-methods.did.login_enabled': true };
    const { response, saved } = save('authentication-methods', {
      ifMatch: 'v',
      set: { 'authentication-methods.did.login_enabled': true },
    });
    const result = await response;
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      error: 'lite_mode_unsupported',
      issues: [{ code: 'method_unsupported', subject: 'did' }],
    });
    expect(saved).not.toHaveBeenCalled();
  });

  it("refuses moving a lite tenant's account page off /account, and saves it at /account", async () => {
    await goLite();
    mocks.after = { 'self-service.account_page_path': '/my-account' };
    const moved = save('self-service', {
      ifMatch: 'v',
      set: { 'self-service.account_page_path': '/my-account' },
    });
    const result = await moved.response;
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      error: 'lite_mode_unsupported',
      issues: [{ code: 'account_page_path_custom' }],
    });
    expect(moved.saved).not.toHaveBeenCalled();
    mocks.after = { 'self-service.account_page_path': '/account' };
    const kept = save('self-service', {
      ifMatch: 'v',
      set: { 'self-service.account_page_path': '/account' },
    });
    expect((await kept.response).status).toBe(200);
    expect(kept.saved).toHaveBeenCalledTimes(1);
  });

  it('saves a change of the account page path under the lite lease, lite on or off', async () => {
    // Off: the save holds the lease, so a switch to lite cannot run in the middle of it.
    mocks.after = { 'self-service.account_page_path': '/my-account' };
    let leaseDuringSave: boolean | null = null;
    const app = new Hono();
    app.patch('/', (c) =>
      guardTenantSettingsChangeForLite({
        c,
        tenantId: 'tenant-a',
        category: 'self-service',
        actor: 'admin-1',
        readBody: async () => ({
          ifMatch: 'v',
          set: { 'self-service.account_page_path': '/my-account' },
        }),
        save: async () => {
          leaseDuringSave = (await store.acquireLeaseRpc('tenant-a')).acquired;
          return Response.json({ saved: true });
        },
      })
    );
    const env = { LITE_POLICY_STORE: { idFromName: (n: string) => n, get: () => store } };
    expect((await app.request('/', { method: 'PATCH' }, env)).status).toBe(200);
    expect(leaseDuringSave).toBe(false);
  });

  it('refuses switching on a method that reveals a block the lite UI cannot render', async () => {
    await goLite();
    mocks.after = { 'authentication-methods.email_otp.login_enabled': true };
    const { response, saved } = save('authentication-methods', {
      ifMatch: 'v',
      set: { 'authentication-methods.email_otp.login_enabled': true },
    });
    const result = await response;
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      issues: [
        { code: 'screen_block_unsupported', subject: 'login', detail: 'account_profile_widget' },
      ],
    });
    expect(saved).not.toHaveBeenCalled();
  });

  it('publishes a change of the required actions of a lite tenant', async () => {
    await goLite();
    const prefix = 'authentication-methods.human_verification.';
    mocks.after = { [`${prefix}signup_enabled`]: true };
    const { response } = save('authentication-methods', {
      ifMatch: 'v',
      set: { [`${prefix}signup_enabled`]: true },
    });
    expect((await response).status).toBe(200);
    expect((await store.getSnapshotRpc('tenant-a')).humanVerificationRequired).toEqual({
      login: false,
      signup: true,
      reauth: false,
    });
  });
});

describe('the lite guard when a change cannot be judged', () => {
  beforeEach(() => {
    store = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
    mocks.after = {};
    mocks.dryRunError = null;
  });

  it('does not save a lite tenant change whose dry run failed (503)', async () => {
    await goLite();
    mocks.dryRunError = new Error('D1 unavailable');
    const { response, saved } = save('authentication-methods', {
      ifMatch: 'v',
      set: { 'authentication-methods.human_verification.login_enabled': true },
    });
    const result = await response;
    expect(result.status).toBe(503);
    expect(saved).not.toHaveBeenCalled();
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
  });

  it('lets the save answer a stale version (409 from the save)', async () => {
    await goLite();
    const { ConflictError } = await import('@authrim/ar-lib-core');
    mocks.dryRunError = new ConflictError('stale', { currentVersion: 'v2' });
    const { response, saved } = save('authentication-methods', { ifMatch: 'v1', set: {} });
    expect((await response).status).toBe(200);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('hands an unreadable body to the save, which answers it as before', async () => {
    const { response, saved } = save('login-ui', null, async () => {
      throw new SyntaxError('Unexpected token');
    });
    expect((await response).status).toBe(200);
    expect(saved).toHaveBeenCalledTimes(1);
  });
});

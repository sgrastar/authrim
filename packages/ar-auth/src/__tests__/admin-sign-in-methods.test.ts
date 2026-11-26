import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ settings: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveEffectiveSettings: mocks.settings,
    getTenantIdFromContext: () => 'tenant-1',
  };
});

import { adminSignInMethodsApp, readAdminSignInMethods } from '../admin-sign-in-methods';

const KEY = 'security.admin_sign_in_methods';

async function methods(): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', adminSignInMethodsApp);
  return app.request('/api/admin/auth/methods', {}, {});
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the admin sign-in methods', () => {
  it('are a passkey only until the platform turns the wallet on', async () => {
    mocks.settings.mockResolvedValue({});
    expect([...(await readAdminSignInMethods({} as Env, 'tenant-1'))]).toEqual(['passkey']);
    const response = await methods();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ methods: { passkey: true, vc: false } });
  });

  it('include the wallet when the platform lists it', async () => {
    mocks.settings.mockResolvedValue({ [KEY]: ['passkey', 'vc'] });
    expect(await (await methods()).json()).toEqual({ methods: { passkey: true, vc: true } });
    // Uncached: turning the wallet off must apply to the next request.
    expect(mocks.settings).toHaveBeenCalledWith({}, 'security', {
      tenantId: 'tenant-1',
      fresh: true,
    });
  });

  it('never open a way in on a list that cannot be read, or a failure to read it', async () => {
    mocks.settings.mockResolvedValue({ [KEY]: ['vc'] });
    expect(await (await methods()).json()).toEqual({ methods: { passkey: true, vc: false } });
    mocks.settings.mockResolvedValue({ [KEY]: 'vc' });
    expect(await (await methods()).json()).toEqual({ methods: { passkey: true, vc: false } });
    mocks.settings.mockRejectedValue(new Error('kv down'));
    expect(await (await methods()).json()).toEqual({ methods: { passkey: true, vc: false } });
  });
});

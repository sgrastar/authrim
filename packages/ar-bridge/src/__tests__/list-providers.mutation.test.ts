import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  listEnabledProviders: vi.fn(),
  module: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-1',
  getLogger: () => ({
    module: (name: string) => {
      mocks.module(name);
      return { error: mocks.error };
    },
  }),
}));
vi.mock('../services/provider-store', () => ({
  listEnabledProviders: mocks.listEnabledProviders,
}));

import { handleListProviders } from '../handlers/list';

const ENV = {} as unknown as Env;
const app = () => {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/auth/external/providers', handleListProviders);
  return instance;
};

describe('handleListProviders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only public fields and marks every provider enabled', async () => {
    mocks.listEnabledProviders.mockResolvedValue([
      {
        id: 'p1',
        slug: 'google',
        name: 'Google',
        providerType: 'oidc',
        iconUrl: 'https://i.example/g.png',
        iconName: 'google',
        buttonColor: '#fff',
        buttonColorDark: '#000',
        buttonText: 'Sign in with Google',
        enabled: false,
        clientId: 'secret-client',
        clientSecretEncrypted: 'secret',
      },
      { id: 'p2', name: 'Bare', providerType: 'oauth2' },
    ]);
    const response = await app().request('https://rp.example/auth/external/providers', {}, ENV);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [
        {
          id: 'p1',
          slug: 'google',
          name: 'Google',
          providerType: 'oidc',
          iconUrl: 'https://i.example/g.png',
          iconName: 'google',
          buttonColor: '#fff',
          buttonColorDark: '#000',
          buttonText: 'Sign in with Google',
          enabled: true,
        },
        { id: 'p2', name: 'Bare', providerType: 'oauth2', enabled: true },
      ],
    });
    expect(mocks.listEnabledProviders).toHaveBeenCalledWith(ENV, 'tenant-1');
  });

  it('returns an empty list', async () => {
    mocks.listEnabledProviders.mockResolvedValue([]);
    const response = await app().request('https://rp.example/auth/external/providers', {}, ENV);
    expect(await response.json()).toEqual({ providers: [] });
  });

  it('returns a generic 500 without leaking the failure', async () => {
    mocks.listEnabledProviders.mockRejectedValue(new Error('db password leaked'));
    const response = await app().request('https://rp.example/auth/external/providers', {}, ENV);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('db password leaked');
    expect(text).toContain('server_error');
    expect(mocks.module).toHaveBeenCalledWith('EXTERNAL-IDP');
    expect(mocks.error).toHaveBeenCalledWith(
      'Failed to list providers',
      {},
      expect.objectContaining({ message: 'db password leaked' })
    );
  });
});

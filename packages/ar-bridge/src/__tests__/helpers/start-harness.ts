import { Hono } from 'hono';
import { vi, type Mock } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { UpstreamProvider } from '../../types';
import { handleExternalStart } from '../../handlers/start';

export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

export const IDP_AUTHORIZE = 'https://idp.example.com/authorize?state=upstream-state';
export const FIXED_STATE = 'fixed-state-value';
export const FIXED_NONCE = 'fixed-nonce-value';
export const SIGN_IN = 'client_id=client-a&code_challenge=abc&code_challenge_method=S256';

export const baseProvider: UpstreamProvider = {
  id: 'provider-a',
  slug: 'corp',
  tenantId: 'tenant-1',
  name: 'Corp IdP',
  providerType: 'oidc',
  enabled: true,
  priority: 0,
  issuer: 'https://idp.example.com',
  clientId: 'upstream-client',
  clientSecretEncrypted: 'encrypted-secret',
  scopes: 'openid email',
  attributeMapping: {},
  autoLinkEmail: false,
  jitProvisioning: false,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

export interface KvHarness {
  store: Map<string, string>;
  get: Mock<(key: string) => Promise<string | null>>;
  put: Mock<(key: string, value: string, options?: unknown) => Promise<void>>;
}

export function makeKv(initial: Record<string, string> = {}): KvHarness {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

export function makeEnv(kv: KvHarness, extra: Record<string, unknown> = {}): Env {
  return {
    ISSUER_URL: 'https://auth.example.com',
    SETTINGS: kv,
    ...extra,
  } as unknown as Env;
}

export function startApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/start', handleExternalStart);
  app.get('/auth/external/start', handleExternalStart);
  return app;
}

export function start(
  query: string,
  env: Env,
  headers: Record<string, string> = {},
  provider = 'corp'
): Promise<Response> {
  return Promise.resolve(
    startApp().request(
      `https://auth.example.com/auth/external/${provider}/start?${query}`,
      { headers },
      env
    )
  );
}

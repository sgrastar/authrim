import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { handleExternalCallback } from '../../handlers/callback';
import { getAuthStateCookieName } from '../../utils/state';
import type { ExternalIdpAuthState, UpstreamProvider } from '../../types';

export const STATE = 'upstream-state-0123456789';

export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

export const oidcProvider: UpstreamProvider = {
  id: 'provider-a',
  slug: 'corp',
  tenantId: 'default',
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
  jitProvisioning: true,
  requireEmailVerified: false,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

export const oauthProvider: UpstreamProvider = {
  ...oidcProvider,
  providerType: 'oauth2',
  issuer: undefined,
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  userinfoEndpoint: 'https://idp.example.com/userinfo',
};

export function authState(overrides: Partial<ExternalIdpAuthState> = {}): ExternalIdpAuthState {
  return {
    id: 'auth-state-a',
    tenantId: 'default',
    clientId: 'client-a',
    providerId: 'provider-a',
    state: STATE,
    codeChallenge: 'code-challenge-a',
    nonce: 'nonce-a',
    codeVerifier: 'verifier-a',
    flowId: 'flow-a',
    redirectUri: 'https://login.example.com/callback',
    enableSso: false,
    expiresAt: 1_900_000_000_000,
    createdAt: 1_800_000_000_000,
    ...overrides,
  };
}

export const ENV = {
  ISSUER_URL: 'https://auth.example.com',
  RP_TOKEN_ENCRYPTION_KEY: 'unused',
  SETTINGS: { get: async () => null },
} as unknown as Env;

export interface CallbackOptions {
  method?: 'GET' | 'POST';
  query?: string;
  body?: Record<string, string>;
  headers?: Record<string, string>;
  /** Send the browser-binding cookie for STATE (default true). */
  bound?: boolean;
  env?: Env;
  path?: string;
  executionCtx?: ExecutionContext;
}

export async function callback(options: CallbackOptions = {}): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.on(['GET', 'POST'], '/auth/external/:provider/callback', handleExternalCallback);
  app.on(['GET', 'POST'], '/noprovider', handleExternalCallback);
  const query = options.query ?? `code=upstream-code&state=${STATE}`;
  const cookies: string[] = [];
  if (options.bound !== false) cookies.push(`${await getAuthStateCookieName(STATE)}=${STATE}`);
  if (options.headers?.Cookie) cookies.push(options.headers.Cookie);
  const headers: Record<string, string> = { ...options.headers };
  if (cookies.length > 0) headers.Cookie = cookies.join('; ');
  const method = options.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (options.body) {
    init.body = new URLSearchParams(options.body).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const path = options.path ?? '/auth/external/corp/callback';
  const url = `https://auth.example.com${path}${query ? `?${query}` : ''}`;
  return Promise.resolve(app.request(url, init, options.env ?? ENV, options.executionCtx));
}

export const locationOf = (response: Response): URL =>
  new URL(must(response.headers.get('Location')));

export const paramsOf = (response: Response): Record<string, string> =>
  Object.fromEntries(locationOf(response).searchParams);

/** An execution context that hands what is passed to `waitUntil` to `onWait`. */
export function fakeExecutionContext(
  onWait: (promise: Promise<unknown>) => void
): ExecutionContext {
  return {
    waitUntil: onWait,
    passThroughOnException: () => undefined,
    props: {},
  } as ExecutionContext;
}

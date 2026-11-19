/**
 * Shared mock setup for the mut-adminagent-* tests of src/admin-agent-token.ts.
 *
 * Mirrors the vi.hoisted/vi.mock setup of admin-agent-token.test.ts and additionally mocks the
 * confidential client authenticator and token revocation, so both client classes and the code
 * replay path can be asserted. Import this module before anything else in the test file.
 */
import { Hono } from 'hono';
import { expect, vi, type Mock } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  consumeCodeRpc: vi.fn(),
  getClientCached: vi.fn(),
  createAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  createRefreshTokenFamily: vi.fn(),
  getRefreshTokenRotatorStubByJti: vi.fn(),
  getPublicKeyByKid: vi.fn(),
  verifyToken: vi.fn(),
  parseTokenHeader: vi.fn(),
  getGrant: vi.fn(),
  getActiveDelegatorPermissions: vi.fn(),
  hasCurrentConsent: vi.fn(),
  writeAudit: vi.fn(),
  createPendingTokenFamily: vi.fn(),
  finalizeTokenFamily: vi.fn(),
  consumeModeBDelegationJti: vi.fn(),
  isTokenFamilyUsable: vi.fn(),
  registerIssuedTokensRpc: vi.fn(),
  getFamilyRpc: vi.fn(),
  rotateRpc: vi.fn(),
  revokeFamilyRpc: vi.fn(),
  revokeByJtiRpc: vi.fn(),
  importPKCS8: vi.fn(),
  validateDPoPProof: vi.fn(),
  isTokenRevoked: vi.fn(),
  resolveTenantMachineLimit: vi.fn(),
  signJwtPayload: vi.fn(),
  signJwtCalls: vi.fn(),
  coreExecute: vi.fn(),
  authenticateConfidentialOAuthClient: vi.fn(),
  revokeToken: vi.fn(),
  buildRequestIssuerUrl: vi.fn(),
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      getGrant = mocks.getGrant;
      getActiveDelegatorPermissions = mocks.getActiveDelegatorPermissions;
      hasCurrentConsent = mocks.hasCurrentConsent;
      writeAudit = mocks.writeAudit;
      createPendingTokenFamily = mocks.createPendingTokenFamily;
      finalizeTokenFamily = mocks.finalizeTokenFamily;
      isTokenFamilyUsable = mocks.isTokenFamilyUsable;
      consumeModeBDelegationJti = mocks.consumeModeBDelegationJti;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildRequestIssuerUrl: mocks.buildRequestIssuerUrl,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: { execute: mocks.coreExecute } })),
    createAccessToken: mocks.createAccessToken,
    createRefreshToken: mocks.createRefreshToken,
    createRefreshTokenFamily: mocks.createRefreshTokenFamily,
    getClientCached: mocks.getClientCached,
    getPublicKeyByKid: mocks.getPublicKeyByKid,
    getRefreshTokenRotatorStubByJti: mocks.getRefreshTokenRotatorStubByJti,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    parseTokenHeader: mocks.parseTokenHeader,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    verifyToken: mocks.verifyToken,
    validateDPoPProof: mocks.validateDPoPProof,
    isTokenRevoked: mocks.isTokenRevoked,
    authenticateConfidentialOAuthClient: mocks.authenticateConfidentialOAuthClient,
    revokeToken: mocks.revokeToken,
    AdminMachineAccessRepository: class {
      resolveTenantMachineLimit = mocks.resolveTenantMachineLimit;
    },
  };
});

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  class FakeSignJWT {
    constructor(payload: Record<string, unknown>) {
      mocks.signJwtPayload(payload);
    }
    private record(name: string, value: unknown) {
      mocks.signJwtCalls(name, value);
      return this;
    }
    setProtectedHeader(value: unknown) {
      return this.record('header', value);
    }
    setIssuer(value: unknown) {
      return this.record('iss', value);
    }
    setSubject(value: unknown) {
      return this.record('sub', value);
    }
    setAudience(value: unknown) {
      return this.record('aud', value);
    }
    setJti(value: unknown) {
      return this.record('jti', value);
    }
    setIssuedAt(value: unknown) {
      return this.record('iat', value);
    }
    setNotBefore(value: unknown) {
      return this.record('nbf', value);
    }
    setExpirationTime(value: unknown) {
      return this.record('exp', value);
    }
    sign() {
      return Promise.resolve('signed-delegation-token');
    }
  }
  return { ...actual, importPKCS8: mocks.importPKCS8, SignJWT: FakeSignJWT };
});

import { adminAgentDelegationHandler, adminAgentTokenHandler } from '../../admin-agent-token';

export { mocks };

export const BASE = 'https://tenant.example.com';
export const ISSUER = `${BASE}/oauth/admin-agent`;
export const TOKEN_URL = `${ISSUER}/token`;
export const MCP = `${BASE}/mcp`;
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const DELEGATION_TYPE = 'urn:authrim:token-type:agent-delegation';

export type TestEnv = Partial<Env> & { ENABLE_AGENT_MCP?: string };

export function environment(overrides: TestEnv = {}): TestEnv {
  return {
    ENABLE_AGENT_MCP: 'true',
    DB_ADMIN: {} as never,
    AUTH_CODE_STORE: {
      idFromName: vi.fn(() => ({}) as never),
      get: vi.fn(() => ({
        consumeCodeRpc: mocks.consumeCodeRpc,
        registerIssuedTokensRpc: mocks.registerIssuedTokensRpc,
      })),
    } as never,
    REFRESH_TOKEN_ROTATOR: {} as never,
    KEY_MANAGER: {
      idFromName: vi.fn(() => ({}) as never),
      get: vi.fn(() => ({
        getActiveKeyWithPrivateRpc: vi.fn(async () => ({ kid: 'kid-1', privatePEM: 'pem' })),
        rotateKeysWithPrivateRpc: vi.fn(),
      })),
    } as never,
    ...overrides,
  };
}

export async function post(
  path: 'token' | 'delegation',
  body: Record<string, string>,
  headers: Record<string, string> = {},
  env: TestEnv = environment()
): Promise<Response> {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    await next();
  });
  app.post('/oauth/admin-agent/token', adminAgentTokenHandler);
  app.post('/oauth/admin-agent/delegation', adminAgentDelegationHandler);
  return app.fetch(
    new Request(`${BASE}/oauth/admin-agent/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body),
    }),
    env
  );
}

export async function expectError(
  response: Response,
  status: number,
  error: string,
  description?: string
): Promise<void> {
  expect(response.status).toBe(status);
  const json = await response.json();
  expect(json).toMatchObject(
    description === undefined ? { error } : { error, error_description: description }
  );
}

export const publicClient = () => ({
  client_id: 'mcp-client',
  redirect_uris: ['https://client.example.com/callback'],
  token_endpoint_auth_method: 'none',
  requestable_scopes: ['agent:read', 'agent:write'],
});

export const confidentialClient = () => ({
  client_id: 'mcp-client',
  redirect_uris: ['https://client.example.com/callback'],
  token_endpoint_auth_method: 'client_secret_post',
  client_secret_hash: 'hash',
  requestable_scopes: ['agent:read', 'agent:write'],
});

export const modeAGrant = (overrides: Record<string, unknown> = {}) => ({
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'mcp-client',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read', 'agent:write'],
  consentVersion: 2,
  generation: 3,
  status: 'active',
  delegationMode: 'user_consent',
  ...overrides,
});

export const modeBGrant = (overrides: Record<string, unknown> = {}) =>
  modeAGrant({
    machinePrincipalId: 'amp-1',
    delegationMode: 'admin_pre_authorized',
    ...overrides,
  });

export const refreshPayload = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: 'admin_user:admin-1',
  aud: 'mcp-client',
  client_id: 'mcp-client',
  tenant_id: 'tenant-1',
  scope: 'agent:read agent:write',
  resource_aud: MCP,
  agent_family_id: 'agf-family-1',
  grant_id: 'grant-1',
  grant_generation: 3,
  consent_version: 2,
  jti: 'rt_1_0_initial',
  rtv: 1,
  ...overrides,
});

export const refreshForm = (overrides: Record<string, string> = {}) => ({
  grant_type: 'refresh_token',
  refresh_token: 'signed-refresh-token',
  client_id: 'mcp-client',
  resource: MCP,
  ...overrides,
});

export const codeForm = (overrides: Record<string, string> = {}) => ({
  grant_type: 'authorization_code',
  code: 'aac_valid-code',
  redirect_uri: 'https://client.example.com/callback',
  client_id: 'mcp-client',
  code_verifier: 'v'.repeat(43),
  resource: MCP,
  ...overrides,
});

export const codeData = (overrides: Record<string, unknown> = {}) => ({
  userId: 'admin_user:admin-1',
  scope: 'agent:read',
  redirectUri: 'https://client.example.com/callback',
  authorizationServer: 'admin_agent',
  subjectType: 'admin_user',
  resource: MCP,
  agentGrantId: 'grant-1',
  agentGrantGeneration: 3,
  agentConsentVersion: 2,
  ...overrides,
});

export const machineActorPayload = (overrides: Record<string, unknown> = {}) => ({
  actor_type: 'machine',
  actor_id: 'amp-1',
  credential_id: 'amk-1',
  client_id: 'mcp-client',
  sender_constrained: true,
  jti: 'machine-jti',
  cnf: { jkt: 'mode-b-jkt' },
  ...overrides,
});

export const delegationPayload = (overrides: Record<string, unknown> = {}) => ({
  token_use: 'agent_delegation',
  iss: ISSUER,
  sub: 'admin_user:admin-1',
  aud: TOKEN_URL,
  jti: 'adj-1',
  exp: Math.floor(Date.now() / 1000) + 300,
  tenant_id: 'tenant-1',
  client_id: 'mcp-client',
  grant_id: 'grant-1',
  grant_generation: 3,
  consent_version: 2,
  scope: 'agent:read agent:write',
  resource: MCP,
  may_act: { sub: 'machine:amp-1' },
  cnf: { jkt: 'mode-b-jkt' },
  ...overrides,
});

export const exchangeForm = (overrides: Record<string, string> = {}) => ({
  grant_type: TOKEN_EXCHANGE,
  subject_token: 'delegation-token',
  subject_token_type: DELEGATION_TYPE,
  actor_token: 'machine-token',
  actor_token_type: ACCESS_TYPE,
  client_id: 'mcp-client',
  resource: MCP,
  ...overrides,
});

/** verifyToken routes the machine actor token and any other token (delegation/refresh). */
export function routeVerifyToken(
  actor: Record<string, unknown> | null,
  other: Record<string, unknown> | null
): void {
  mocks.verifyToken.mockImplementation(async (token: string) => {
    const value = token === 'machine-token' ? actor : other;
    if (!value) throw new Error('invalid token');
    return value;
  });
}

export function machineLimit(
  permissions: string[] = ['admin:users:read'],
  clientId = 'mcp-client'
) {
  return {
    principal: { id: 'amp-1', clientId, status: 'active' },
    credential: { id: 'amk-1', principalId: 'amp-1', status: 'active' },
    permissions,
  };
}

export function resetDefaults(): void {
  vi.clearAllMocks();
  mocks.buildRequestIssuerUrl.mockReturnValue(BASE);
  mocks.getClientCached.mockResolvedValue(publicClient());
  mocks.consumeCodeRpc.mockResolvedValue(codeData());
  mocks.getGrant.mockResolvedValue(modeAGrant());
  mocks.getActiveDelegatorPermissions.mockResolvedValue(['admin:users:read']);
  mocks.hasCurrentConsent.mockResolvedValue(true);
  mocks.importPKCS8.mockResolvedValue({});
  mocks.createAccessToken.mockImplementation(
    async (_c: unknown, _k: unknown, _kid: unknown, _ttl: unknown, jti: string) => ({
      token: 'signed-access-token',
      jti,
    })
  );
  mocks.createRefreshToken.mockResolvedValue({ token: 'signed-refresh-token', jti: 'rt', rtv: 1 });
  mocks.createRefreshTokenFamily.mockResolvedValue({
    jti: 'rt_1_0_initial',
    family: { version: 1, newJti: 'rt_1_0_initial', expiresIn: 604800 },
  });
  mocks.createPendingTokenFamily.mockResolvedValue(undefined);
  mocks.registerIssuedTokensRpc.mockResolvedValue(true);
  mocks.finalizeTokenFamily.mockResolvedValue(true);
  mocks.isTokenFamilyUsable.mockResolvedValue(true);
  mocks.getPublicKeyByKid.mockResolvedValue({});
  mocks.parseTokenHeader.mockReturnValue({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
  mocks.isTokenRevoked.mockResolvedValue(false);
  mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'mode-b-jkt' });
  mocks.resolveTenantMachineLimit.mockResolvedValue(machineLimit());
  mocks.consumeModeBDelegationJti.mockResolvedValue(true);
  mocks.coreExecute.mockResolvedValue({ success: true, rows: [] });
  mocks.authenticateConfidentialOAuthClient.mockResolvedValue({ ok: true });
  mocks.revokeToken.mockResolvedValue(undefined);
  mocks.getFamilyRpc.mockResolvedValue({
    tenant_id: 'tenant-1',
    last_used_at: Date.now(),
    user_id: 'agf-family-1',
    client_id: 'mcp-client',
  });
  mocks.rotateRpc.mockResolvedValue({ newVersion: 2, newJti: 'rt_rotated', expiresIn: 600000 });
  mocks.revokeFamilyRpc.mockResolvedValue(undefined);
  mocks.revokeByJtiRpc.mockResolvedValue(undefined);
  mocks.getRefreshTokenRotatorStubByJti.mockReturnValue({
    stub: {
      getFamilyRpc: mocks.getFamilyRpc,
      rotateRpc: mocks.rotateRpc,
      revokeFamilyRpc: mocks.revokeFamilyRpc,
      revokeByJtiRpc: mocks.revokeByJtiRpc,
    },
  });
}

/** Typed access to a recorded mock call argument. */
export function callArg<T = Record<string, unknown>>(mock: Mock, index = 0, call = 0): T {
  return mock.mock.calls[call][index] as T;
}

/** The SignJWT builder calls recorded as name -> value. */
export function signJwtSettings(): Record<string, unknown> {
  return Object.fromEntries(mocks.signJwtCalls.mock.calls as Array<[string, unknown]>);
}

export const anyString = (): string => expect.any(String) as string;
export const anyNumber = (): number => expect.any(Number) as number;
export const anything = (): unknown => expect.anything() as unknown;
export const matching = (pattern: RegExp): string => expect.stringMatching(pattern) as string;

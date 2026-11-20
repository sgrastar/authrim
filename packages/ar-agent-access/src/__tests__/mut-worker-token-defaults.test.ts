import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudflareAgentAccessTokenAuthenticator,
  isCloudflareAgentAccessMcpEnabled,
} from '../platform/cloudflare/token-authentication';
import {
  failureOf,
  mcpRequest,
  tokenClaims,
  tokenEnvironment,
  tokenRepository,
} from './helpers/mut-worker-token-fixtures';

const state = vi.hoisted(() => {
  const token: {
    header: { alg: string; typ: string; kid?: string };
    key: { kind: string } | null;
  } = { header: { alg: 'RS256', typ: 'JWT', kid: 'kid-1' }, key: { kind: 'public-key' } };
  return {
    tenant: null as null | { success: false; error: string },
    ...token,
    verifyToken: vi.fn(),
    validateDPoPProof: vi.fn(),
    getPublicKeyByKid: vi.fn(),
    database: { kind: 'admin-db' },
    requireDedicated: vi.fn(),
    repositoryArgs: [] as unknown[][],
    repo: null as null | Record<string, unknown>,
  };
});

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({ client_id: 'client-1' })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    resolveTenantFromRequest: vi.fn(
      (request: Request, env: never) =>
        state.tenant ?? actual.resolveTenantFromRequest(request, env)
    ),
    parseTokenHeader: vi.fn(() => state.header),
    getPublicKeyByKid: state.getPublicKeyByKid.mockImplementation(async () => state.key),
    verifyToken: state.verifyToken,
    validateDPoPProof: state.validateDPoPProof,
    requireDedicatedAdminDatabaseAdapter: state.requireDedicated.mockImplementation(
      () => state.database
    ),
  };
});
vi.mock('../platform/cloudflare/admin-agent-audit-writer', () => ({
  createCloudflareAdminAgentAuditWriter: vi.fn(() => ({ kind: 'audit-writer' })),
}));
vi.mock('../core', async (original) => ({
  ...(await original<typeof import('../core')>()),
  AdminAgentAccessRepository: class {
    constructor(...args: unknown[]) {
      state.repositoryArgs.push(args);
      Object.assign(this, state.repo);
    }
  },
}));

beforeEach(() => {
  // The hoisted ar-lib-core mocks are shared by every case; keep their implementations but
  // drop call history so each assertion only sees the calls made by its own case.
  state.verifyToken.mockClear();
  state.validateDPoPProof.mockClear();
  state.getPublicKeyByKid.mockClear();
  state.requireDedicated.mockClear();
  state.repositoryArgs.length = 0;
});

describe('isCloudflareAgentAccessMcpEnabled', () => {
  function settings(raw: string | null) {
    return { get: vi.fn(async () => raw) };
  }

  it('reads the tenant agent-access document and honours agent.mcp.enabled', async () => {
    const kv = settings('{"agent.mcp.enabled":true}');
    await expect(
      isCloudflareAgentAccessMcpEnabled({ SETTINGS: kv } as never, 'tenant-9')
    ).resolves.toBe(true);
    expect(kv.get).toHaveBeenCalledWith('settings:tenant:tenant-9:agent-access');
  });

  it('prefers SETTINGS over AUTHRIM_CONFIG', async () => {
    const primary = settings('{"agent.mcp.enabled":false}');
    const fallback = settings('{"agent.mcp.enabled":true}');
    await expect(
      isCloudflareAgentAccessMcpEnabled(
        { SETTINGS: primary, AUTHRIM_CONFIG: fallback, ENABLE_AGENT_MCP: 'true' } as never,
        't'
      )
    ).resolves.toBe(false);
    expect(fallback.get).not.toHaveBeenCalled();
  });

  it('accepts a bare boolean document and falls back to the environment when absent', async () => {
    await expect(
      isCloudflareAgentAccessMcpEnabled(
        { AUTHRIM_CONFIG: settings('true'), ENABLE_AGENT_MCP: 'false' } as never,
        't'
      )
    ).resolves.toBe(true);
    await expect(
      isCloudflareAgentAccessMcpEnabled(
        { AUTHRIM_CONFIG: settings(null), ENABLE_AGENT_MCP: 'true' } as never,
        't'
      )
    ).resolves.toBe(true);
  });

  it('treats an array document as invalid configuration', async () => {
    await expect(
      isCloudflareAgentAccessMcpEnabled(
        { AUTHRIM_CONFIG: settings('[true]'), ENABLE_AGENT_MCP: 'true' } as never,
        't'
      )
    ).resolves.toBe(false);
  });

  it('uses the environment flag when no settings binding exists', async () => {
    await expect(
      isCloudflareAgentAccessMcpEnabled({ ENABLE_AGENT_MCP: 'true' } as never, 't')
    ).resolves.toBe(true);
    await expect(isCloudflareAgentAccessMcpEnabled({} as never, 't')).resolves.toBe(false);
  });
});

describe('token authenticator gating', () => {
  it('rejects an unresolvable tenant before reading feature configuration', async () => {
    state.tenant = { success: false, error: 'tenant_not_found' };
    const kv = { get: vi.fn() };
    const verifyJwt = vi.fn();
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt,
      validateDpop: vi.fn(),
      createRepository: () => tokenRepository(),
    });
    try {
      const failure = await failureOf(
        await authenticate(mcpRequest(), tokenEnvironment({ SETTINGS: kv }))
      );
      expect(failure).toMatchObject({
        status: 401,
        code: 'AGENT_MCP_TENANT_RESOLUTION_FAILED',
        tenantId: undefined,
      });
    } finally {
      state.tenant = null;
    }
    expect(kv.get).not.toHaveBeenCalled();
    expect(verifyJwt).not.toHaveBeenCalled();
  });

  it('answers 404 with the disabled code when the feature flag is off', async () => {
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt: vi.fn(),
      validateDpop: vi.fn(),
      createRepository: () => tokenRepository(),
    });
    const failure = await failureOf(
      await authenticate(mcpRequest(), tokenEnvironment({ ENABLE_AGENT_MCP: 'false' }))
    );
    expect(failure).toMatchObject({
      status: 404,
      code: 'AGENT_MCP_DISABLED',
      tenantId: 'tenant-1',
    });
  });
});

describe('default token verifier', () => {
  function authenticateWithDefaults() {
    return createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      validateDpop: vi.fn(),
      createRepository: () => tokenRepository(),
    });
  }

  it('verifies RS256 JWTs with the tenant key, issuer and MCP audience', async () => {
    state.verifyToken.mockResolvedValueOnce(tokenClaims());
    const env = tokenEnvironment();
    const result = await authenticateWithDefaults()(mcpRequest(), env);
    expect(result.allowed).toBe(true);
    expect(state.getPublicKeyByKid).toHaveBeenCalledTimes(1);
    expect(state.getPublicKeyByKid).toHaveBeenCalledWith(env, 'tenant-1', 'kid-1');
    expect(state.verifyToken).toHaveBeenCalledTimes(1);
    expect(state.verifyToken).toHaveBeenCalledWith(
      'access-token',
      state.key,
      'https://auth.example/oauth/admin-agent',
      { audience: 'https://auth.example/mcp' }
    );
  });

  it.each([
    ['a non-RS256 algorithm', { alg: 'HS256', typ: 'JWT', kid: 'kid-1' }],
    ['a non-JWT type', { alg: 'RS256', typ: 'at+jwt', kid: 'kid-1' }],
    ['a missing key id', { alg: 'RS256', typ: 'JWT' }],
  ])('refuses %s without fetching a key', async (_name, header) => {
    state.header = header;
    try {
      const failure = await failureOf(
        await authenticateWithDefaults()(mcpRequest(), tokenEnvironment())
      );
      expect(failure.code).toBe('AGENT_MCP_TOKEN_INVALID');
    } finally {
      state.header = { alg: 'RS256', typ: 'JWT', kid: 'kid-1' };
    }
    expect(state.getPublicKeyByKid).not.toHaveBeenCalled();
    expect(state.verifyToken).not.toHaveBeenCalled();
  });

  it('refuses a token whose verification key is unavailable', async () => {
    state.key = null;
    try {
      const failure = await failureOf(
        await authenticateWithDefaults()(mcpRequest(), tokenEnvironment())
      );
      expect(failure.code).toBe('AGENT_MCP_TOKEN_INVALID');
    } finally {
      state.key = { kind: 'public-key' };
    }
    expect(state.verifyToken).not.toHaveBeenCalled();
  });
});

describe('default DPoP validator and repository', () => {
  it('validates the proof against method, URL, token, client and tenant', async () => {
    state.validateDPoPProof.mockResolvedValueOnce({ valid: true, jkt: 'jkt-1' });
    const env = tokenEnvironment();
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi
        .fn()
        .mockResolvedValue(tokenClaims({ token_binding: 'dpop', cnf: { jkt: 'jkt-1' } })),
      createRepository: () => tokenRepository(),
    });
    const result = await authenticate(
      mcpRequest({ authorization: 'DPoP access-token', dpop: 'proof-1' }),
      env
    );
    expect(result.allowed).toBe(true);
    expect(state.validateDPoPProof).toHaveBeenCalledTimes(1);
    expect(state.validateDPoPProof).toHaveBeenCalledWith(
      'proof-1',
      'POST',
      'https://auth.example/mcp',
      'access-token',
      env,
      'client-1',
      'tenant-1'
    );
  });

  it('builds the Grant repository on the dedicated admin database', async () => {
    state.repo = tokenRepository();
    const env = tokenEnvironment();
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi.fn().mockResolvedValue(tokenClaims()),
      validateDpop: vi.fn(),
    });
    const result = await authenticate(mcpRequest(), env);
    expect(result.allowed).toBe(true);
    expect(state.requireDedicated).toHaveBeenCalledTimes(1);
    expect(state.requireDedicated).toHaveBeenCalledWith(env, 'agent-access-mcp-authentication');
    expect(state.repositoryArgs).toEqual([[state.database, { kind: 'audit-writer' }]]);
  });
});

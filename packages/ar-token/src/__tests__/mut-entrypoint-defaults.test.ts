import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDownscopeExchangeRequest } from '@authrim/ar-agent-access/core';

const mocks = vi.hoisted(() => ({
  parseTokenHeader: vi.fn(),
  getPublicKeyByKid: vi.fn(),
  verifyToken: vi.fn(),
  createAccessToken: vi.fn(),
  requireAdapter: vi.fn(),
  resolveTenantMachineLimit: vi.fn(),
  machineRepositoryArgs: [] as unknown[],
  importPKCS8: vi.fn(),
  accessRepositoryArgs: [] as unknown[][],
  bulkRepositoryArgs: [] as unknown[][],
  accessRepository: { getGrant: vi.fn() },
  bulkRepository: { get: vi.fn(), getTenantExecution: vi.fn() },
  auditWriter: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    parseTokenHeader: mocks.parseTokenHeader,
    getPublicKeyByKid: mocks.getPublicKeyByKid,
    verifyToken: mocks.verifyToken,
    createAccessToken: mocks.createAccessToken,
    requireDedicatedAdminDatabaseAdapter: mocks.requireAdapter,
    AdminMachineAccessRepository: class {
      constructor(adapter: unknown) {
        mocks.machineRepositoryArgs.push(adapter);
      }
      resolveTenantMachineLimit = mocks.resolveTenantMachineLimit;
    },
  };
});
vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jose')>()),
  importPKCS8: mocks.importPKCS8,
}));
vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-agent-access/core')>()),
  AdminAgentAccessRepository: class {
    constructor(...args: unknown[]) {
      mocks.accessRepositoryArgs.push(args);
      return mocks.accessRepository;
    }
  },
  AgentBulkRepository: class {
    constructor(...args: unknown[]) {
      mocks.bulkRepositoryArgs.push(args);
      return mocks.bulkRepository;
    }
  },
}));
vi.mock('@authrim/ar-agent-access/platform/cloudflare/admin-agent-audit-writer', () => ({
  createCloudflareAdminAgentAuditWriter: () => mocks.auditWriter,
}));

import {
  defaultModeBPermissionLimit,
  exchangeAgentAccessToken,
  issueAgentBulkChildToken,
} from '../entrypoints/AgentDownscopeEntrypoint';
import { bulkScenario } from './helpers/mut-entrypoint-fixtures';

const request: AgentDownscopeExchangeRequest = {
  subjectToken: 'mcp-token',
  tenantId: 'tenant-1',
  issuerOrigin: 'https://tenant-1.authrim.example',
  audience: 'authrim:admin-api',
  permissions: ['admin:users:read'],
  grantId: 'grant-1',
  grantGeneration: 3,
  delegatorId: 'admin-1',
  consentVersion: 2,
  actorSub: 'client:client-1',
  actorMode: 'mode_a',
  actorAssurance: 'public_client_transaction',
  clientId: 'client-1',
  correlationId: 'correlation-1',
};

/** Stops the exchange right after the step under test, without reaching later defaults. */
const stop = new Error('stop_after_step');

beforeEach(() => {
  for (const mock of [
    mocks.parseTokenHeader,
    mocks.getPublicKeyByKid,
    mocks.verifyToken,
    mocks.createAccessToken,
    mocks.requireAdapter,
    mocks.resolveTenantMachineLimit,
    mocks.importPKCS8,
    mocks.accessRepository.getGrant,
    mocks.bulkRepository.get,
    mocks.bulkRepository.getTenantExecution,
  ]) {
    mock.mockReset();
  }
  mocks.machineRepositoryArgs.length = 0;
  mocks.accessRepositoryArgs.length = 0;
  mocks.bulkRepositoryArgs.length = 0;
  mocks.requireAdapter.mockImplementation((_env: unknown, purpose: string) => ({ purpose }));
});
afterEach(() => vi.restoreAllMocks());

describe('default subject token verification', () => {
  const run = () =>
    exchangeAgentAccessToken({} as never, request, {
      isFeatureEnabled: async () => true,
      createRepository: () => {
        throw stop;
      },
    });

  it.each([
    ['a non-RS256 algorithm', { alg: 'ES256', typ: 'JWT', kid: 'kid-1' }],
    ['a non-JWT type', { alg: 'RS256', typ: 'at+jwt', kid: 'kid-1' }],
    ['a missing kid', { alg: 'RS256', typ: 'JWT' }],
  ])('rejects %s before key lookup', async (_name, header) => {
    mocks.parseTokenHeader.mockReturnValue(header);
    await expect(run()).rejects.toThrow('invalid_agent_subject_token');
    expect(mocks.getPublicKeyByKid).not.toHaveBeenCalled();
  });

  it('fails closed when the verification key is unavailable', async () => {
    mocks.parseTokenHeader.mockReturnValue({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    mocks.getPublicKeyByKid.mockResolvedValue(null);
    await expect(run()).rejects.toThrow('agent_subject_verification_key_unavailable');
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it('verifies against the tenant key, the admin-agent issuer, and the MCP audience', async () => {
    const key = { type: 'public' };
    mocks.parseTokenHeader.mockReturnValue({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    mocks.getPublicKeyByKid.mockResolvedValue(key);
    mocks.verifyToken.mockResolvedValue({ not: 'agent claims' });
    await expect(run()).rejects.toThrow('invalid_agent_subject_token_binding');
    expect(mocks.parseTokenHeader).toHaveBeenCalledWith('mcp-token');
    expect(mocks.getPublicKeyByKid).toHaveBeenCalledWith({}, 'tenant-1', 'kid-1');
    expect(mocks.verifyToken).toHaveBeenCalledWith(
      'mcp-token',
      key,
      'https://tenant-1.authrim.example/oauth/admin-agent',
      { audience: 'https://tenant-1.authrim.example/mcp' }
    );
  });
});

describe('default signer', () => {
  function keyManager(active: unknown, rotated: unknown = { kid: 'rotated', privatePEM: 'pem-r' }) {
    const stub = {
      getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue(active),
      rotateKeysWithPrivateRpc: vi.fn().mockResolvedValue(rotated),
    };
    return {
      stub,
      binding: { idFromName: vi.fn((name: string) => `id:${name}`), get: vi.fn(() => stub) },
    };
  }

  async function sign(env: Record<string, unknown>) {
    const scenario = await bulkScenario();
    const { signToken: _signer, ...deps } = scenario.deps;
    return issueAgentBulkChildToken(env as never, scenario.request, deps);
  }

  it('refuses to sign without a key manager', async () => {
    await expect(sign({})).rejects.toThrow('agent_downscope_signing_key_unavailable');
  });

  it('signs a 60 second token with the active tenant key', async () => {
    const manager = keyManager({ kid: 'active-kid', privatePEM: 'pem-a' });
    mocks.importPKCS8.mockResolvedValue('private-key');
    mocks.createAccessToken.mockResolvedValue({ token: 'signed-token' });
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    await expect(sign({ KEY_MANAGER: manager.binding })).resolves.toEqual({
      accessToken: 'signed-token',
      expiresAt: 65_000,
    });
    expect(manager.binding.idFromName).toHaveBeenCalledWith('tenant-1-v3');
    expect(manager.binding.get).toHaveBeenCalledWith('id:tenant-1-v3');
    expect(manager.stub.rotateKeysWithPrivateRpc).not.toHaveBeenCalled();
    expect(mocks.importPKCS8).toHaveBeenCalledWith('pem-a', 'RS256');
    expect(mocks.createAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-1', aud: 'authrim:admin-api' }),
      'private-key',
      'active-kid',
      60,
      expect.any(String)
    );
  });

  it('rotates in a key when the tenant has no active signing key', async () => {
    const manager = keyManager(null);
    mocks.importPKCS8.mockResolvedValue('private-key');
    mocks.createAccessToken.mockResolvedValue({ token: 'signed-token' });
    await sign({ KEY_MANAGER: manager.binding });
    expect(mocks.importPKCS8).toHaveBeenCalledWith('pem-r', 'RS256');
    expect(mocks.createAccessToken.mock.calls[0][2]).toBe('rotated');
  });
});

describe('default repositories, clock, and machine permission limit', () => {
  it('builds the access repository on the dedicated downscope database partition', async () => {
    mocks.accessRepository.getGrant.mockRejectedValue(stop);
    vi.spyOn(Date, 'now').mockReturnValue(777);
    const getActiveDelegatorPermissions = vi.fn().mockRejectedValue(stop);
    Object.assign(mocks.accessRepository, {
      getActiveDelegatorPermissions,
      hasCurrentConsent: vi.fn().mockResolvedValue(true),
    });
    await expect(
      exchangeAgentAccessToken({} as never, request, {
        isFeatureEnabled: async () => true,
        verifySubjectToken: async () => ({
          sub: 'admin_user:admin-1',
          jti: 'jti',
          scope: 'agent:read',
          client_id: 'client-1',
          tenant_id: 'tenant-1',
          grant_id: 'grant-1',
          grant_generation: 3,
          consent_version: 2,
          actor_mode: 'mode_a',
          actor_assurance: 'public_client_transaction',
          token_binding: 'bearer',
          act: { sub: 'client:client-1' },
        }),
      })
    ).rejects.toBe(stop);
    expect(mocks.requireAdapter).toHaveBeenCalledWith({}, 'agent-downscope-exchange');
    expect(mocks.accessRepositoryArgs).toEqual([
      [{ purpose: 'agent-downscope-exchange' }, mocks.auditWriter],
    ]);
    expect(getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', 777);
  });

  it('builds both Bulk repositories on the Bulk child database partition', async () => {
    const scenario = await bulkScenario();
    const { createBulkRepository: _b, createRepository: _r, now: _n, ...deps } = scenario.deps;
    mocks.bulkRepository.get.mockRejectedValue(stop);
    mocks.bulkRepository.getTenantExecution.mockResolvedValue(null);
    await expect(issueAgentBulkChildToken({} as never, scenario.request, deps)).rejects.toBe(stop);
    expect(mocks.requireAdapter).toHaveBeenCalledWith({}, 'agent-bulk-child-token');
    const database = { purpose: 'agent-bulk-child-token' };
    expect(mocks.bulkRepositoryArgs).toEqual([[database, mocks.auditWriter]]);
    expect(mocks.accessRepositoryArgs).toEqual([[database, mocks.auditWriter]]);
  });

  it('uses the wall clock when no clock is injected for Bulk child tokens', async () => {
    const scenario = await bulkScenario();
    const { now: _now, ...deps } = scenario.deps;
    vi.spyOn(Date, 'now').mockReturnValue(1_100);
    await expect(issueAgentBulkChildToken({} as never, scenario.request, deps)).rejects.toThrow(
      'agent_bulk_child_binding_changed'
    );
  });

  it('reads one machine principal and credential snapshot from the admin database', async () => {
    mocks.resolveTenantMachineLimit.mockResolvedValue({ permissions: ['admin:clients:read'] });
    await expect(
      defaultModeBPermissionLimit({} as never, 'tenant-1', 'amp-1', 'amk-1')
    ).resolves.toEqual(['admin:clients:read']);
    expect(mocks.requireAdapter).toHaveBeenCalledWith({}, 'agent-downscope-machine-principal');
    expect(mocks.machineRepositoryArgs).toEqual([{ purpose: 'agent-downscope-machine-principal' }]);
    expect(mocks.resolveTenantMachineLimit).toHaveBeenCalledWith('tenant-1', 'amp-1', 'amk-1');
    mocks.resolveTenantMachineLimit.mockResolvedValue(null);
    await expect(defaultModeBPermissionLimit({} as never, 'tenant-1', 'amp-1')).resolves.toBeNull();
  });
});

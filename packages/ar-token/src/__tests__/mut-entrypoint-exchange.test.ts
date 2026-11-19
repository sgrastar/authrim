import { describe, expect, it, vi } from 'vitest';
import type {
  AgentDownscopeExchangeRequest,
  AgentGrantContract,
} from '@authrim/ar-agent-access/core';
import { exchangeAgentAccessToken } from '../entrypoints/AgentDownscopeEntrypoint';
import { pinTool } from './helpers/mut-entrypoint-fixtures';

const env = {} as never;
const NOW = 100;

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read', 'admin:clients:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 2,
  generation: 3,
  status: 'active',
  delegationMode: 'user_consent',
  expiresAt: 1_000,
  taskSetId: 'ats-read-only',
  taskSetVersion: 1,
  scopePolicyId: 'asp-tenant-1',
  scopePolicyVersion: 1,
  resolvedTools: [pinTool('admin.read.clients.list')],
  accessSnapshotHash: 'a'.repeat(43),
};

const modeA: AgentDownscopeExchangeRequest = {
  subjectToken: 'mcp-token',
  tenantId: 'tenant-1',
  issuerOrigin: 'https://tenant-1.authrim.example',
  audience: 'authrim:admin-api',
  permissions: ['admin:users:read', 'admin:clients:read'],
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

const modeB: AgentDownscopeExchangeRequest = {
  ...modeA,
  actorSub: 'machine:amp-1',
  actorMode: 'mode_b',
  actorAssurance: 'machine_key',
  machinePrincipalId: 'amp-1',
  machineCredentialId: 'amk-1',
};

function subjectFor(mode: 'a' | 'b', overrides: Record<string, unknown> = {}) {
  const base = {
    sub: 'admin_user:admin-1',
    jti: 'source-jti',
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
  };
  const modeBClaims =
    mode === 'b'
      ? {
          actor_mode: 'mode_b',
          actor_assurance: 'machine_key',
          token_binding: 'dpop',
          act: { sub: 'machine:amp-1' },
          act_principal_id: 'amp-1',
          act_credential_id: 'amk-1',
          cnf: { jkt: 'thumbprint' },
        }
      : {};
  return { ...base, ...modeBClaims, ...overrides };
}

function deps(
  options: {
    mode?: 'a' | 'b';
    subject?: Record<string, unknown>;
    grant?: Partial<AgentGrantContract>;
    delegatorPermissions?: string[] | null;
    consent?: boolean;
    limit?: string[] | null;
  } = {}
) {
  const mode = options.mode ?? 'a';
  const repo = {
    getGrant: vi.fn().mockResolvedValue({
      ...grant,
      ...(mode === 'b'
        ? { machinePrincipalId: 'amp-1', delegationMode: 'admin_pre_authorized' }
        : {}),
      ...options.grant,
    }),
    getActiveDelegatorPermissions: vi
      .fn()
      .mockResolvedValue(
        options.delegatorPermissions === undefined ? ['admin:*'] : options.delegatorPermissions
      ),
    hasCurrentConsent: vi.fn().mockResolvedValue(options.consent ?? true),
  };
  return {
    repo,
    now: () => NOW,
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    verifySubjectToken: vi.fn().mockResolvedValue(subjectFor(mode, options.subject)),
    createRepository: vi.fn(() => repo),
    getModeBPermissionLimit: vi
      .fn()
      .mockResolvedValue(options.limit === undefined ? ['admin:*'] : options.limit),
    signToken: vi.fn().mockResolvedValue({ accessToken: 'token', expiresAt: 160 }),
  };
}

describe('exchangeAgentAccessToken request boundaries', () => {
  it('accepts generation and consent version 1 and exactly 64 permissions', async () => {
    const permissions = Array.from({ length: 64 }, (_, index) => `admin:p${index}`);
    const d = deps({
      subject: { grant_generation: 1, consent_version: 1 },
      grant: { generation: 1, consentVersion: 1, permissions: ['admin:*'] },
    });
    await expect(
      exchangeAgentAccessToken(
        env,
        { ...modeA, grantGeneration: 1, consentVersion: 1, permissions },
        d
      )
    ).resolves.toEqual({ accessToken: 'token', expiresAt: 160 });
  });

  it('rejects a list where only one permission is malformed', async () => {
    const d = deps();
    await expect(
      exchangeAgentAccessToken(env, { ...modeA, permissions: ['admin:users:read', 'Admin'] }, d)
    ).rejects.toThrow('invalid_agent_downscope_request');
  });
});

describe('exchangeAgentAccessToken issuer origin', () => {
  it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
    'allows the loopback development origin %s',
    async (issuerOrigin) => {
      const d = deps();
      await exchangeAgentAccessToken(env, { ...modeA, issuerOrigin }, d);
      expect(d.verifySubjectToken).toHaveBeenCalledWith(env, 'tenant-1', issuerOrigin, 'mcp-token');
      expect(d.signToken.mock.calls[0][2]).toMatchObject({
        iss: `${issuerOrigin}/oauth/admin-agent`,
      });
    }
  );

  it.each([
    'not a url',
    'http://tenant-1.authrim.example',
    'https://tenant-1.authrim.example/',
    'https://tenant-1.authrim.example/path',
    'https://user:pass@tenant-1.authrim.example',
    'ftp://tenant-1.authrim.example',
  ])('rejects %s before verifying the subject token', async (issuerOrigin) => {
    const d = deps();
    await expect(exchangeAgentAccessToken(env, { ...modeA, issuerOrigin }, d)).rejects.toThrow(
      'agent_downscope_issuer_unavailable'
    );
    expect(d.verifySubjectToken).not.toHaveBeenCalled();
  });
});

describe('exchangeAgentAccessToken subject token binding', () => {
  it.each([
    ['tenant', { tenant_id: 'tenant-2' }],
    ['grant', { grant_id: 'grant-2' }],
    ['grant generation', { grant_generation: 4 }],
    ['consent version', { consent_version: 3 }],
    ['client', { client_id: 'client-2' }],
    ['delegator subject', { sub: 'admin_user:admin-2' }],
    ['actor assurance', { actor_assurance: 'confidential_client' }],
  ])('rejects a Mode A source token with another %s', async (_name, subject) => {
    const d = deps({ subject });
    await expect(exchangeAgentAccessToken(env, modeA, d)).rejects.toThrow(
      'invalid_agent_subject_token_binding'
    );
    expect(d.createRepository).not.toHaveBeenCalled();
  });

  it('rejects unparseable source claims', async () => {
    const d = deps({ subject: { actor_mode: 'mode_x' } });
    await expect(exchangeAgentAccessToken(env, modeA, d)).rejects.toThrow(
      'invalid_agent_subject_token_binding'
    );
  });

  it('rejects a request whose actor mode differs from the source token', async () => {
    const d = deps();
    await expect(
      exchangeAgentAccessToken(env, { ...modeA, actorMode: 'mode_b' }, d)
    ).rejects.toThrow('invalid_agent_subject_token_binding');
  });

  it.each([
    ['principal', { machinePrincipalId: 'amp-2', actorSub: 'machine:amp-1' }],
    ['credential', { machineCredentialId: 'amk-2' }],
  ])('rejects a Mode B token bound to another machine %s', async (_name, request) => {
    const d = deps({ mode: 'b' });
    await expect(exchangeAgentAccessToken(env, { ...modeB, ...request }, d)).rejects.toThrow(
      'invalid_agent_subject_token_binding'
    );
  });
});

describe('exchangeAgentAccessToken live authorization', () => {
  it.each([
    ['inactive status', { status: 'suspended' }],
    ['an incomplete snapshot', { accessSnapshotHash: undefined }],
    ['another client', { clientId: 'client-2' }],
    ['another delegator', { delegatorId: 'admin-2' }],
    ['another generation', { generation: 4 }],
    ['another consent version', { consentVersion: 3 }],
    ['an expiry equal to now', { expiresAt: NOW }],
    ['a Grant missing one requested permission', { permissions: ['admin:users:read'] }],
  ])('rejects a Grant with %s', async (_name, grantOverrides) => {
    const d = deps({ grant: grantOverrides as Partial<AgentGrantContract> });
    await expect(exchangeAgentAccessToken(env, modeA, d)).rejects.toThrow(
      'agent_downscope_authorization_changed'
    );
    expect(d.signToken).not.toHaveBeenCalled();
  });

  it.each([
    ['no active delegator permissions', { delegatorPermissions: null }],
    ['withdrawn consent', { consent: false }],
    [
      'a delegator missing one requested permission',
      { delegatorPermissions: ['admin:users:read'] },
    ],
  ])('rejects %s', async (_name, options) => {
    const d = deps(options);
    await expect(exchangeAgentAccessToken(env, modeA, d)).rejects.toThrow(
      'agent_downscope_authorization_changed'
    );
  });

  it('rejects a Mode B Grant pinned to another machine principal', async () => {
    const d = deps({ mode: 'b', grant: { machinePrincipalId: 'amp-2' } });
    await expect(exchangeAgentAccessToken(env, modeB, d)).rejects.toThrow(
      'agent_downscope_authorization_changed'
    );
  });

  it('rejects when the machine ceiling lacks one requested permission', async () => {
    const d = deps({ mode: 'b', limit: ['admin:users:read'] });
    await expect(exchangeAgentAccessToken(env, modeB, d)).rejects.toThrow(
      'agent_downscope_authorization_changed'
    );
    expect(d.getModeBPermissionLimit).toHaveBeenCalledWith(env, 'tenant-1', 'amp-1', 'amk-1');
  });

  it('reads the repository state with the request identifiers and current time', async () => {
    const d = deps();
    await exchangeAgentAccessToken(env, modeA, d);
    expect(d.repo.getGrant).toHaveBeenCalledWith('tenant-1', 'grant-1');
    expect(d.repo.getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', NOW);
    expect(d.repo.hasCurrentConsent).toHaveBeenCalledWith(
      'tenant-1',
      'grant-1',
      'admin-1',
      'client-1',
      2
    );
    expect(d.getModeBPermissionLimit).not.toHaveBeenCalled();
  });

  it('signs a space-separated scope and omits machine claims for Mode A', async () => {
    const d = deps();
    await exchangeAgentAccessToken(env, modeA, d);
    expect(d.signToken).toHaveBeenCalledWith(env, 'tenant-1', {
      iss: 'https://tenant-1.authrim.example/oauth/admin-agent',
      sub: 'admin_user:admin-1',
      aud: 'authrim:admin-api',
      scope: 'admin:users:read admin:clients:read',
      permissions: ['admin:users:read', 'admin:clients:read'],
      client_id: 'client-1',
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      grant_generation: 3,
      consent_version: 2,
      actor_type: 'agent',
      actor_mode: 'mode_a',
      actor_assurance: 'public_client_transaction',
      act: { sub: 'client:client-1' },
      source_token_jti: 'source-jti',
      correlation_id: 'correlation-1',
    });
  });
});

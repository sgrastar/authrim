import { vi } from 'vitest';
import type { AgentGrantContract } from '../../core';

export const tokenGrant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read', 'agent:write'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 2,
  generation: 3,
  status: 'active',
  delegationMode: 'user_consent',
  expiresAt: 1_000,
};

export function tokenClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'admin_user:admin-1',
    jti: 'jti-1',
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
    ...overrides,
  };
}

export function tokenRepository(grant: AgentGrantContract | null = tokenGrant) {
  return {
    getGrant: vi.fn().mockResolvedValue(grant),
    getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:users:read']),
    hasCurrentConsent: vi.fn().mockResolvedValue(true),
  };
}

export function mcpRequest(headers: Record<string, string> = {}) {
  return new Request('https://auth.example/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer access-token', ...headers },
  });
}

export function tokenEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    DEFAULT_TENANT_ID: 'tenant-1',
    ENABLE_AGENT_MCP: 'true',
    ...overrides,
  } as never;
}

export async function failureOf(result: unknown) {
  const value = result as {
    allowed: boolean;
    response: Response;
    auditContext: { code: string; tenantId?: string };
  };
  if (value.allowed) throw new Error('expected refusal');
  return {
    status: value.response.status,
    code: value.auditContext.code,
    tenantId: value.auditContext.tenantId,
    headers: value.response.headers,
    body: await value.response.json<unknown>().catch(() => null),
  };
}

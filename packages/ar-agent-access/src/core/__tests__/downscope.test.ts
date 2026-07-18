import { describe, expect, it } from 'vitest';
import { parseAgentAdminApiDownscopeTokenClaims } from '../downscope';

const claims = {
  sub: 'admin_user:admin-1',
  jti: 'downscope-jti',
  scope: 'admin:users:read admin:clients:read',
  permissions: ['admin:users:read', 'admin:clients:read'],
  client_id: 'client-1',
  tenant_id: 'tenant-1',
  grant_id: 'grant-1',
  grant_generation: 2,
  consent_version: 3,
  actor_type: 'agent',
  actor_mode: 'mode_a',
  actor_assurance: 'public_client_transaction',
  act: { sub: 'client:client-1' },
  source_token_jti: 'source-jti',
  correlation_id: 'correlation-1',
};

describe('parseAgentAdminApiDownscopeTokenClaims', () => {
  it('accepts a verified, internally downscoped claim set', () => {
    expect(parseAgentAdminApiDownscopeTokenClaims(claims)).toEqual(claims);
  });

  it.each([
    ['permission/scope mismatch', { scope: 'admin:users:read' }],
    ['duplicate permission', { permissions: ['admin:users:read', 'admin:users:read'] }],
    ['invalid subject namespace', { sub: 'user:admin-1' }],
    ['Mode A machine assurance', { actor_assurance: 'machine_key' }],
    ['Mode B weak assurance', { actor_mode: 'mode_b', actor_assurance: 'confidential_client' }],
    ['missing source fence', { source_token_jti: '' }],
  ])('rejects %s', (_label, override) => {
    expect(parseAgentAdminApiDownscopeTokenClaims({ ...claims, ...override })).toBeNull();
  });
});

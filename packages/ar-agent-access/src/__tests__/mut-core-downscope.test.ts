import { describe, expect, it } from 'vitest';
import { parseAgentAdminApiDownscopeTokenClaims } from '../core/downscope';

const modeA = {
  sub: 'admin_user:u1',
  jti: 'jti-1',
  scope: 'admin:users:read admin:clients:read',
  permissions: ['admin:users:read', 'admin:clients:read'],
  client_id: 'client-1',
  tenant_id: 't1',
  grant_id: 'grant-1',
  grant_generation: 1,
  consent_version: 1,
  actor_type: 'agent',
  actor_mode: 'mode_a',
  actor_assurance: 'confidential_client',
  act: { sub: 'client:client-1' },
  source_token_jti: 'src-1',
  correlation_id: 'corr-1',
};

const bulk = {
  control_tenant_id: 'control',
  target_tenant_id: 't1',
  plan_id: 'plan-1',
  plan_version: 1,
  execution_id: 'exec-1',
  execution_attempt: 1,
  execution_fence: 1,
  stage: 'apply',
  plan_digest: 'pd',
  approval_digest: 'ad',
  child_capability_digest: 'cd',
};

const modeB = {
  ...modeA,
  actor_mode: 'mode_b',
  actor_assurance: 'machine_key',
  act: { sub: 'machine:p1' },
  act_principal_id: 'p1',
  act_credential_id: 'cred-1',
};

const modeBBulk = { ...modeB, bulk };

describe('parseAgentAdminApiDownscopeTokenClaims', () => {
  it.each([
    ['mode A', modeA],
    ['mode A public client', { ...modeA, actor_assurance: 'public_client_transaction' }],
    ['mode B', modeB],
    ['mode B bulk', modeBBulk],
    ['bulk validate stage', { ...modeB, bulk: { ...bulk, stage: 'validate' } }],
    ['bulk verify stage', { ...modeB, bulk: { ...bulk, stage: 'verify' } }],
    ['larger counters', { ...modeA, grant_generation: 2, consent_version: 3 }],
    [
      'larger bulk counters',
      { ...modeB, bulk: { ...bulk, plan_version: 2, execution_attempt: 3, execution_fence: 4 } },
    ],
    [
      'scope with extra whitespace',
      { ...modeA, scope: '  admin:users:read \t admin:clients:read ' },
    ],
  ])('returns the same object for valid %s claims', (_label, claims) => {
    expect(parseAgentAdminApiDownscopeTokenClaims(claims)).toBe(claims);
  });

  it.each([
    ['null', null],
    ['array', [modeA]],
    ['string', 'claims'],
    ['missing act', { ...modeA, act: undefined }],
    ['null act', { ...modeA, act: null }],
    ['array act', { ...modeA, act: ['client:client-1'] }],
  ])('rejects non-record input: %s', (_label, value) => {
    expect(parseAgentAdminApiDownscopeTokenClaims(value)).toBeNull();
  });

  it.each([
    ['numeric sub', { sub: 1 }],
    ['non admin_user sub', { sub: 'user:u1' }],
    ['bare admin_user prefix', { sub: 'admin_user:' }],
    ['numeric jti', { jti: 1 }],
    ['empty jti', { jti: '' }],
    ['numeric scope', { scope: 1 }],
    ['non-array permissions', { permissions: 'admin:users:read' }],
    ['empty permissions', { permissions: [], scope: '' }],
    [
      'non-string permission',
      { permissions: ['admin:users:read', 7], scope: 'admin:users:read 7' },
    ],
    ['empty permission', { permissions: ['admin:users:read', ''], scope: 'admin:users:read' }],
    [
      'duplicate permission',
      {
        permissions: ['admin:users:read', 'admin:users:read'],
        scope: 'admin:users:read admin:users:read',
      },
    ],
    ['numeric client_id', { client_id: 1 }],
    ['empty client_id', { client_id: '' }],
    ['numeric tenant_id', { tenant_id: 1 }],
    ['empty tenant_id', { tenant_id: '' }],
    ['numeric grant_id', { grant_id: 1 }],
    ['empty grant_id', { grant_id: '' }],
    ['fractional grant_generation', { grant_generation: 1.5 }],
    ['zero grant_generation', { grant_generation: 0 }],
    ['string consent_version', { consent_version: '1' }],
    ['zero consent_version', { consent_version: 0 }],
    ['wrong actor_type', { actor_type: 'user' }],
    ['unknown actor_mode', { actor_mode: 'mode_c' }],
    ['unknown actor_assurance', { actor_assurance: 'password' }],
    ['numeric act.sub', { act: { sub: 1 } }],
    ['empty act.sub', { act: { sub: '' } }],
    ['numeric source_token_jti', { source_token_jti: 1 }],
    ['empty source_token_jti', { source_token_jti: '' }],
    ['numeric correlation_id', { correlation_id: 1 }],
    ['empty correlation_id', { correlation_id: '' }],
    ['mode A with machine assurance', { actor_assurance: 'machine_key' }],
    ['scope fewer than permissions', { scope: 'admin:users:read' }],
    ['scope more than permissions', { scope: 'admin:users:read admin:clients:read admin:x:read' }],
    ['scope in a different order', { scope: 'admin:clients:read admin:users:read' }],
    ['scope with different value', { scope: 'admin:users:read admin:clients:write' }],
    ['bulk on mode A', { bulk }],
  ])('rejects mode A claims with %s', (_label, override) => {
    expect(parseAgentAdminApiDownscopeTokenClaims({ ...modeA, ...override })).toBeNull();
  });

  it.each([
    ['public assurance', { actor_assurance: 'public_client_transaction' }],
    ['confidential assurance', { actor_assurance: 'confidential_client' }],
    ['missing principal id', { act_principal_id: undefined }],
    ['empty principal id', { act_principal_id: '', act: { sub: 'machine:' } }],
    ['missing credential id', { act_credential_id: undefined }],
    ['numeric credential id', { act_credential_id: 5 }],
    ['empty credential id', { act_credential_id: '' }],
    ['act.sub not bound to principal', { act: { sub: 'machine:p2' } }],
    ['act.sub without machine prefix', { act: { sub: 'p1' } }],
  ])('rejects mode B claims with %s', (_label, override) => {
    expect(parseAgentAdminApiDownscopeTokenClaims({ ...modeB, ...override })).toBeNull();
  });

  it.each([
    ['null bulk', null],
    ['array bulk', [bulk]],
    ['numeric control tenant', { ...bulk, control_tenant_id: 1 }],
    ['numeric target tenant', { ...bulk, target_tenant_id: 1 }],
    ['target tenant differs from tenant_id', { ...bulk, target_tenant_id: 't2' }],
    ['numeric plan id', { ...bulk, plan_id: 1 }],
    ['fractional plan version', { ...bulk, plan_version: 1.1 }],
    ['zero plan version', { ...bulk, plan_version: 0 }],
    ['numeric execution id', { ...bulk, execution_id: 1 }],
    ['string execution attempt', { ...bulk, execution_attempt: '1' }],
    ['zero execution attempt', { ...bulk, execution_attempt: 0 }],
    ['missing execution fence', { ...bulk, execution_fence: undefined }],
    ['zero execution fence', { ...bulk, execution_fence: 0 }],
    ['unknown stage', { ...bulk, stage: 'rollback' }],
    ['empty stage', { ...bulk, stage: '' }],
    ['numeric plan digest', { ...bulk, plan_digest: 1 }],
    ['numeric approval digest', { ...bulk, approval_digest: 1 }],
    ['numeric child capability digest', { ...bulk, child_capability_digest: 1 }],
  ])('rejects bulk claims with %s', (_label, bulkValue) => {
    expect(parseAgentAdminApiDownscopeTokenClaims({ ...modeB, bulk: bulkValue })).toBeNull();
  });
});

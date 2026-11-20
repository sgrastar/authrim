import { describe, expect, it } from 'vitest';
import {
  parseAgentAccessTokenClaims,
  parseModeAAgentAccessTokenClaims,
} from '../core/token-claims';

type ClaimOverrideCase = [label: string, override: Record<string, unknown>];

const modeA = {
  sub: 'admin_user:u1',
  jti: 'jti-1',
  scope: 'agent:read',
  client_id: 'client-1',
  tenant_id: 't1',
  grant_id: 'g1',
  grant_generation: 1,
  consent_version: 1,
  actor_mode: 'mode_a',
  actor_assurance: 'public_client_transaction',
  token_binding: 'bearer',
  act: { sub: 'client:client-1' },
};

const modeB = {
  ...modeA,
  actor_mode: 'mode_b',
  actor_assurance: 'machine_key',
  token_binding: 'dpop',
  act: { sub: 'machine:p1' },
  act_principal_id: 'p1',
  act_credential_id: 'cred-1',
  cnf: { jkt: 'thumb' },
};

describe('parseModeAAgentAccessTokenClaims', () => {
  it.each<ClaimOverrideCase>([
    ['public bearer', modeA],
    ['confidential client', { ...modeA, actor_assurance: 'confidential_client' }],
    ['dpop binding with cnf', { ...modeA, token_binding: 'dpop', cnf: { jkt: 'thumb' } }],
    [
      'authorization details',
      {
        ...modeA,
        authorization_details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 5 }],
      },
    ],
  ])('accepts %s', (_label, claims) => {
    expect(parseModeAAgentAccessTokenClaims(claims)).toBe(claims);
    expect(parseAgentAccessTokenClaims(claims)).toBe(claims);
  });

  it.each<[label: string, value: unknown]>([
    ['null', null],
    ['array', [modeA]],
    ['missing act', { ...modeA, act: undefined }],
    ['array act', { ...modeA, act: [] }],
  ])('rejects non-record %s', (_label, value) => {
    expect(parseModeAAgentAccessTokenClaims(value)).toBeNull();
    expect(parseAgentAccessTokenClaims(value)).toBeNull();
  });

  it.each<ClaimOverrideCase>([
    ...(['sub', 'jti', 'scope', 'client_id', 'tenant_id', 'grant_id'] as const).flatMap(
      (field): ClaimOverrideCase[] => [
        [`empty ${field}`, { [field]: '' }],
        [`numeric ${field}`, { [field]: 1 }],
      ]
    ),
    ['empty act.sub', { act: { sub: '' } }],
    ['fractional grant_generation', { grant_generation: 1.5 }],
    ['string consent_version', { consent_version: '1' }],
    ['mode_b actor mode', { actor_mode: 'mode_b' }],
    ['machine assurance', { actor_assurance: 'machine_key' }],
    ['unknown binding', { token_binding: 'mtls' }],
    ['non-record cnf', { cnf: 'thumb' }],
    ['non-string jkt', { cnf: { jkt: 1 } }],
    ['invalid authorization details', { authorization_details: [{ type: 'other' }] }],
    ['empty authorization details', { authorization_details: [] }],
  ])('rejects mode A claims with %s', (_label, override) => {
    expect(parseModeAAgentAccessTokenClaims({ ...modeA, ...override })).toBeNull();
  });
});

describe('parseAgentAccessTokenClaims mode B', () => {
  it('accepts a DPoP-bound machine token', () => {
    expect(parseAgentAccessTokenClaims(modeB)).toBe(modeB);
    expect(parseModeAAgentAccessTokenClaims(modeB)).toBeNull();
  });

  it.each<ClaimOverrideCase>([
    ['missing cnf', { cnf: undefined }],
    ['array cnf', { cnf: ['thumb'] }],
    ['empty jkt', { cnf: { jkt: '' } }],
    ...(
      [
        'sub',
        'jti',
        'scope',
        'client_id',
        'tenant_id',
        'grant_id',
        'act_principal_id',
        'act_credential_id',
      ] as const
    ).flatMap((field): ClaimOverrideCase[] => [
      [`empty ${field}`, { [field]: '' }],
      [`numeric ${field}`, { [field]: 2 }],
    ]),
    ['empty act.sub', { act: { sub: '' } }],
    ['fractional grant_generation', { grant_generation: 0.5 }],
    ['missing consent_version', { consent_version: undefined }],
    ['other actor mode', { actor_mode: 'mode_c' }],
    ['confidential assurance', { actor_assurance: 'confidential_client' }],
    ['bearer binding', { token_binding: 'bearer' }],
    ['act.sub not bound to principal', { act: { sub: 'machine:p2' } }],
    ['act.sub without prefix', { act: { sub: 'p1' } }],
  ])('rejects mode B claims with %s', (_label, override) => {
    expect(parseAgentAccessTokenClaims({ ...modeB, ...override })).toBeNull();
  });
});

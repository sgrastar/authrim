import { describe, expect, it } from 'vitest';
import { checkSAMLChallengeForFlow, continueSAMLChallenge } from '../saml-authorization-challenge';

const samlChallenge = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'tenant_test',
  type: 'reauth',
  metadata: {
    protocol: 'saml',
    saml_request_id: '_request-1',
    saml_sp_entity_id: 'https://sp.example.test/entity',
    tenant_id: 'tenant_test',
    sessionUserId: 'user_1',
    reauth_issued_at: 1_000_000,
    ...overrides,
  },
});

const flow = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'tenant_test',
  targetType: 'saml_sp',
  targetId: 'https://sp.example.test/entity',
  samlSpId: 'https://sp.example.test/entity',
  clientId: null,
  samlRequestId: '_request-1',
  samlSpEntityId: 'https://sp.example.test/entity',
  ...overrides,
});

describe('checkSAMLChallengeForFlow', () => {
  it('accepts a challenge for the request, SP and tenant the Flow was started for', () => {
    expect(checkSAMLChallengeForFlow(samlChallenge(), flow())).toMatchObject({
      ok: true,
      binding: { requestId: '_request-1', tenantId: 'tenant_test' },
    });
  });

  it.each([
    ['another AuthnRequest', { samlRequestId: '_request-2' }],
    ['no AuthnRequest', { samlRequestId: null }],
    ['another SP (the target)', { samlSpId: 'https://other.example.test/entity' }],
    ['another SP (the entity id sent)', { samlSpEntityId: 'https://other.example.test/entity' }],
    ['no SP', { samlSpId: null }],
    // The Flow assignment is looked up by the target, so it must name this SP too.
    ['another SP as the Flow target', { targetId: 'https://other.example.test/entity' }],
    ['no Flow target id', { targetId: null }],
    ['a tenant-level Flow target', { targetType: 'tenant', targetId: null }],
    ['an OIDC client Flow target', { targetType: 'oidc_client' }],
    ['another tenant', { tenantId: 'tenant_other' }],
    ['a target that also names an OIDC client', { clientId: 'client_1' }],
  ])('does not accept it for %s', (_name, change) => {
    expect(checkSAMLChallengeForFlow(samlChallenge(), flow(change))).toEqual({
      ok: false,
      reason: 'not_bound',
    });
  });

  it.each([
    ['not a re-authentication', { type: 'login' }],
    ['of another tenant than its metadata says', { tenantId: 'tenant_other' }],
  ])('does not accept a SAML challenge that is %s', (_name, change) => {
    expect(checkSAMLChallengeForFlow({ ...samlChallenge(), ...change }, flow())).toMatchObject({
      ok: false,
    });
  });

  it('does not accept a SAML challenge whose binding is missing a part', () => {
    expect(
      checkSAMLChallengeForFlow(samlChallenge({ saml_request_id: undefined }), flow())
    ).toEqual({ ok: false, reason: 'not_bound' });
  });

  it('does not accept the challenge of an OIDC authorization request', () => {
    const oidc = {
      tenantId: 'tenant_test',
      type: 'reauth',
      metadata: { client_id: 'client_1', sessionUserId: 'user_1', reauth_issued_at: 1_000_000 },
    };
    expect(checkSAMLChallengeForFlow(oidc, flow())).toEqual({
      ok: false,
      reason: 'wrong_protocol',
    });
  });
});

describe('continueSAMLChallenge', () => {
  it('continues a SAML challenge at the SSO endpoint, for the request it is bound to', () => {
    expect(continueSAMLChallenge(samlChallenge(), 'tenant_test')).toEqual({
      kind: 'continue',
      type: 'reauth',
      redirectUrl:
        '/saml/idp/sso?saml_request_id=_request-1&saml_sp_entity_id=https%3A%2F%2Fsp.example.test%2Fentity&return_to=saml_sso',
    });
  });

  it('leaves the challenge of an OIDC authorization request to /authorize', () => {
    expect(
      continueSAMLChallenge(
        { tenantId: 'tenant_test', type: 'reauth', metadata: { client_id: 'client_1' } },
        'tenant_test'
      )
    ).toBeNull();
  });

  it.each([
    ['of another tenant', samlChallenge(), 'tenant_other'],
    ['that is not a re-authentication', { ...samlChallenge(), type: 'login' }, 'tenant_test'],
    ['without a request', samlChallenge({ saml_request_id: '' }), 'tenant_test'],
  ])('refuses a SAML challenge %s', (_name, challenge, tenantId) => {
    expect(continueSAMLChallenge(challenge, tenantId)).toEqual({ kind: 'invalid' });
  });
});

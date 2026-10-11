import { describe, expect, it } from 'vitest';
import {
  canAuthenticateWithPIIStatus,
  canIssueTokenWithPIIStatus,
  canServeUserInfoWithPIIStatus,
  getPIIStatusBehavior,
  resolveOIDCPIIRequirement,
  shouldRetryPIIWrite,
} from '../pii-compensation-policy';

describe('pii compensation policy', () => {
  it('allows login and non-PII token issuance for failed PII state', () => {
    expect(canAuthenticateWithPIIStatus('failed')).toBe(true);
    expect(canIssueTokenWithPIIStatus('failed', { requiresPII: false })).toEqual({ ok: true });
    expect(shouldRetryPIIWrite('failed')).toBe(true);
  });

  it('blocks token and UserInfo PII release until PII state is active', () => {
    expect(canIssueTokenWithPIIStatus('failed', { requiresPII: true })).toMatchObject({
      ok: false,
      error: 'temporarily_unavailable',
    });
    expect(canServeUserInfoWithPIIStatus('pending', { requiresPII: true })).toMatchObject({
      ok: false,
      error: 'temporarily_unavailable',
    });
    expect(canIssueTokenWithPIIStatus('active', { requiresPII: true })).toEqual({ ok: true });
  });

  it('treats deleted as terminal for authentication and token issuance', () => {
    const behavior = getPIIStatusBehavior('deleted');

    expect(behavior.terminal).toBe(true);
    expect(behavior.loginAllowed).toBe(false);
    expect(canIssueTokenWithPIIStatus('deleted', { requiresPII: false })).toMatchObject({
      ok: false,
      error: 'invalid_grant',
    });
  });

  it('detects PII requirements from OIDC scopes', () => {
    expect(resolveOIDCPIIRequirement({ scopes: 'openid profile email' })).toEqual({
      requiresPII: true,
      reasons: ['scope:profile', 'scope:email'],
    });
    expect(resolveOIDCPIIRequirement({ scopes: ['openid'] })).toEqual({
      requiresPII: false,
      reasons: [],
    });
  });

  it('detects PII requirements from claims request and ASC rules', () => {
    const requirement = resolveOIDCPIIRequirement({
      scopes: 'openid',
      targets: ['id_token', 'userinfo'],
      claimsRequest: {
        id_token: { updated_at: null },
        userinfo: { email: null, '::email_domain': null },
        _asc: {
          sao: {
            userinfo: [{ loc: '/address/postal_code', else: 'omit' }],
          },
        },
      },
    });

    expect(requirement).toEqual({
      requiresPII: true,
      reasons: [
        'claims.userinfo:email',
        'claims.userinfo:::email_domain',
        'claims._asc.sao.userinfo:/address/postal_code',
      ],
    });
  });
});

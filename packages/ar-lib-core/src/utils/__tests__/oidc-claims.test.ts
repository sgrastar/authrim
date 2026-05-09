import { describe, expect, it } from 'vitest';
import {
  evaluateClaimsForTarget,
  parseClaimsRequest,
  PREDEFINED_TRANSFORMED_CLAIMS,
} from '../oidc-claims';

describe('OIDC claims parameter and ASC utilities', () => {
  it('accepts _asc as a top-level claims key', () => {
    const result = parseClaimsRequest(
      JSON.stringify({
        userinfo: { email: null },
        _asc: {
          sao: {
            userinfo: [{ loc: '/email', method: 'exists', else: 'omit' }],
          },
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(result.request?._asc?.sao?.userinfo).toHaveLength(1);
  });

  it('rejects unsupported top-level claims keys', () => {
    const result = parseClaimsRequest(JSON.stringify({ access_token: { email: null } }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_description).toContain('Invalid claims section');
    }
  });

  it('enforces claim-level policy for claims without corresponding scope', () => {
    const parsed = parseClaimsRequest(JSON.stringify({ userinfo: { email: null } }));
    expect(parsed.ok).toBe(true);

    const denied = evaluateClaimsForTarget({
      target: 'userinfo',
      claimsRequest: parsed.request,
      availableClaims: { sub: 'user-1', email: 'test@example.com' },
      grantedScopes: ['openid'],
      clientPolicy: { claims_parameter_policy: { email: 'scope_required' } },
    });
    expect(denied.ok).toBe(true);
    if (denied.ok) expect(denied.claims.email).toBeUndefined();

    const allowed = evaluateClaimsForTarget({
      target: 'userinfo',
      claimsRequest: parsed.request,
      availableClaims: { sub: 'user-1', email: 'test@example.com' },
      grantedScopes: ['openid'],
      clientPolicy: { claims_parameter_policy: { email: 'claims_allowed' } },
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.claims.email).toBe('test@example.com');
  });

  it('omits normal essential claims when unavailable', () => {
    const parsed = parseClaimsRequest(JSON.stringify({ id_token: { email: { essential: true } } }));
    expect(parsed.ok).toBe(true);

    const result = evaluateClaimsForTarget({
      target: 'id_token',
      claimsRequest: parsed.request,
      availableClaims: { sub: 'user-1' },
      grantedScopes: ['openid'],
      clientPolicy: { claims_parameter_policy: { email: 'claims_allowed' } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.email).toBeUndefined();
  });

  it('returns an error for an essential acr values mismatch', () => {
    const parsed = parseClaimsRequest(
      JSON.stringify({
        id_token: {
          acr: { essential: true, values: ['urn:authrim:acr:mfa'] },
        },
      })
    );
    expect(parsed.ok).toBe(true);

    const result = evaluateClaimsForTarget({
      target: 'id_token',
      claimsRequest: parsed.request,
      availableClaims: { sub: 'user-1', acr: 'urn:authrim:acr:basic' },
      grantedScopes: ['openid'],
      clientPolicy: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('login_required');
  });

  it('evaluates predefined transformed age claims only when ASC may run', () => {
    expect(PREDEFINED_TRANSFORMED_CLAIMS.age_over_18.claim).toBe('birthdate');
    const parsed = parseClaimsRequest(
      JSON.stringify({
        id_token: {
          '::age_over_18': { value: true },
        },
      })
    );
    expect(parsed.ok).toBe(true);

    const unprotected = evaluateClaimsForTarget({
      target: 'id_token',
      claimsRequest: parsed.request,
      availableClaims: { birthdate: '2000-01-01' },
      grantedScopes: ['openid'],
      clientPolicy: { claims_parameter_policy: { birthdate: 'claims_allowed' } },
      requestIntegrityProtected: false,
    });
    expect(unprotected.ok).toBe(true);
    if (unprotected.ok) expect(unprotected.claims['::age_over_18']).toBeUndefined();

    const protectedResult = evaluateClaimsForTarget({
      target: 'id_token',
      claimsRequest: parsed.request,
      availableClaims: { birthdate: '2000-01-01' },
      grantedScopes: ['openid'],
      clientPolicy: { claims_parameter_policy: { birthdate: 'claims_allowed' } },
      requestIntegrityProtected: true,
    });
    expect(protectedResult.ok).toBe(true);
    if (protectedResult.ok) expect(protectedResult.claims['::age_over_18']).toBe(true);
  });

  it('applies SAO omit and ignores normal value restrictions when SAO is active', () => {
    const parsed = parseClaimsRequest(
      JSON.stringify({
        userinfo: {
          email: { value: 'other@example.com' },
          address: null,
        },
        _asc: {
          sao: {
            userinfo: [
              { loc: '/address/postal_code', method: 'exists', else: 'omit', what: ['/address'] },
            ],
          },
        },
      })
    );
    expect(parsed.ok).toBe(true);

    const result = evaluateClaimsForTarget({
      target: 'userinfo',
      claimsRequest: parsed.request,
      availableClaims: {
        email: 'test@example.com',
        address: { country: 'JP' },
      },
      grantedScopes: ['openid'],
      clientPolicy: {
        claims_parameter_policy: { email: 'claims_allowed', address: 'claims_allowed' },
      },
      requestIntegrityProtected: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.email).toBe('test@example.com');
      expect(result.claims.address).toBeUndefined();
    }
  });

  it('keeps normal value restrictions when SAO is disabled for the client', () => {
    const parsed = parseClaimsRequest(
      JSON.stringify({
        userinfo: {
          email: { value: 'other@example.com' },
        },
        _asc: {
          sao: {
            userinfo: [{ loc: '/email', method: 'exists', else: 'omit' }],
          },
        },
      })
    );
    expect(parsed.ok).toBe(true);

    const result = evaluateClaimsForTarget({
      target: 'userinfo',
      claimsRequest: parsed.request,
      availableClaims: { email: 'test@example.com' },
      grantedScopes: ['openid'],
      clientPolicy: {
        asc_sao_enabled: false,
        claims_parameter_policy: { email: 'claims_allowed' },
      },
      requestIntegrityProtected: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.email).toBeUndefined();
  });

  it('applies SAO abort when protected', () => {
    const parsed = parseClaimsRequest(
      JSON.stringify({
        userinfo: { address: null },
        _asc: {
          sao: {
            userinfo: [{ loc: '/address/postal_code', method: 'exists', else: 'abort' }],
          },
        },
      })
    );
    expect(parsed.ok).toBe(true);

    const result = evaluateClaimsForTarget({
      target: 'userinfo',
      claimsRequest: parsed.request,
      availableClaims: { address: { country: 'JP' } },
      grantedScopes: ['openid'],
      clientPolicy: { claims_parameter_policy: { address: 'claims_allowed' } },
      requestIntegrityProtected: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_description).toContain('SAO abort');
  });

  it('applies ID token SAO to initial response claims without explicit requested claims', () => {
    const parsed = parseClaimsRequest(
      JSON.stringify({
        id_token: {},
        _asc: {
          sao: {
            id_token: [{ loc: '/acr', method: 'simple', value: 'mfa', else: 'abort' }],
          },
        },
      })
    );
    expect(parsed.ok).toBe(true);

    const result = evaluateClaimsForTarget({
      target: 'id_token',
      claimsRequest: parsed.request,
      initialClaims: { sub: 'user-1', acr: 'basic' },
      availableClaims: { sub: 'user-1', acr: 'basic' },
      grantedScopes: ['openid'],
      clientPolicy: {},
      requestIntegrityProtected: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_description).toContain('SAO abort');
  });

  it('rejects invalid SAO what pointers', () => {
    const result = parseClaimsRequest(
      JSON.stringify({
        userinfo: { address: null },
        _asc: {
          sao: {
            userinfo: [{ loc: '/address', method: 'exists', else: 'omit', what: ['address'] }],
          },
        },
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_description).toContain('what');
  });

  it('treats year zero and invalid transformed-claim dates as unavailable', () => {
    const parsed = parseClaimsRequest(
      JSON.stringify({
        id_token: {
          '::age_over_18': { value: true },
        },
      })
    );
    expect(parsed.ok).toBe(true);

    for (const birthdate of ['0000-01-01', '2000-99-01', '2000-02-31']) {
      const result = evaluateClaimsForTarget({
        target: 'id_token',
        claimsRequest: parsed.request,
        availableClaims: { birthdate },
        grantedScopes: ['openid'],
        clientPolicy: { claims_parameter_policy: { birthdate: 'claims_allowed' } },
        requestIntegrityProtected: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.claims['::age_over_18']).toBeUndefined();
    }
  });
});

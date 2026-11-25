/**
 * Callback Handler Tests
 * Hybrid fragment relay and FAPI 2.0 failure classification. Attribute mapping and the rest of the
 * callback run against the real handler in the callback-*.mutation.test.ts files.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyFapi2CallbackError,
  createHybridFragmentRelayResponse,
  extractUnverifiedJarmState,
} from '../handlers/callback';

describe('Hybrid fragment relay', () => {
  it('relays only allowlisted fragment fields with restrictive browser headers', async () => {
    const response = createHybridFragmentRelayResponse();
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(html).toContain("['code', 'id_token', 'state', 'error', 'error_description']");
    expect(html).toContain("history.replaceState(null, '', location.pathname + location.search)");
    expect(html).not.toContain('document.write');
    expect(html).not.toContain('innerHTML');
  });
});

describe('FAPI2 diagnostic error classification', () => {
  it('turns an undecodable JARM response into a stable diagnostic error', () => {
    expect(() => extractUnverifiedJarmState('not-a-jwt')).toThrow('Malformed JARM response');
    expect(classifyFapi2CallbackError(new Error('Malformed JARM response'))).toBe('malformed_jarm');
  });

  it('distinguishes missing and invalid JARM claims without exporting raw errors', () => {
    expect(
      classifyFapi2CallbackError({
        code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        claim: 'aud',
        reason: 'missing',
      })
    ).toBe('missing_audience');
    expect(
      classifyFapi2CallbackError({
        code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        claim: 'iss',
        reason: 'check_failed',
      })
    ).toBe('issuer_mismatch');
  });

  it('classifies signature, algorithm, state, and token response failures', () => {
    expect(classifyFapi2CallbackError({ code: 'ERR_JOSE_ALG_NOT_ALLOWED' })).toBe(
      'unexpected_signing_algorithm'
    );
    expect(classifyFapi2CallbackError({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' })).toBe(
      'invalid_signature'
    );
    expect(classifyFapi2CallbackError(new Error('JARM response state mismatch'))).toBe(
      'state_mismatch'
    );
    expect(classifyFapi2CallbackError(new Error('Token response has invalid expires_in'))).toBe(
      'invalid_expires_in'
    );
  });
});

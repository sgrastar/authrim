/**
 * Start handler tests. The handler's behaviour (rate limiting, redirect validation, silent
 * sign-in, FAPI, ...) is covered against the real handler in the start-*.mutation.test.ts files.
 */

import { describe, it, expect } from 'vitest';
import { classifyExternalStartDiagnosticFailure } from '../handlers/start';

describe('external start diagnostic failure classification', () => {
  it.each([
    'Discovery document issuer mismatch',
    'Failed to fetch OIDC discovery document: 500',
    'Discovery document missing required jwks_uri',
  ])(
    'classifies metadata validation errors without exposing them as generic failures: %s',
    (message) => {
      expect(classifyExternalStartDiagnosticFailure(new Error(message))).toBe(
        'discovery_validation_failed'
      );
    }
  );

  it.each(['ISSUER problem', 'bad JWKS', 'DISCOVERY failed'])(
    'matches the keywords in any case: %s',
    (message) => {
      expect(classifyExternalStartDiagnosticFailure(new Error(message))).toBe(
        'discovery_validation_failed'
      );
    }
  );

  it('classifies a thrown non-Error by its text', () => {
    expect(classifyExternalStartDiagnosticFailure('issuer unreachable')).toBe(
      'discovery_validation_failed'
    );
    expect(classifyExternalStartDiagnosticFailure(undefined)).toBe('authorization_request_failed');
    expect(classifyExternalStartDiagnosticFailure({ message: 'issuer' })).toBe(
      'authorization_request_failed'
    );
  });

  it('keeps unrelated authorization construction failures distinct', () => {
    expect(classifyExternalStartDiagnosticFailure(new Error('Invalid redirect URI'))).toBe(
      'authorization_request_failed'
    );
  });
});

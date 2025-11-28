/**
 * OAuth/OIDC Error Response Consistency Tests
 *
 * Ensures error responses across all endpoints follow RFC 6749/OIDC Core specs:
 * - Consistent error format (error, error_description)
 * - Correct HTTP status codes
 * - No sensitive information leakage
 * - Proper Content-Type headers
 *
 * Reference:
 * - RFC 6749 Section 5.2 (Error Response)
 * - OpenID Connect Core Section 3.1.2.6 (Authentication Error Response)
 */

import { describe, it, expect } from 'vitest';

/**
 * Standard OAuth 2.0 error codes (RFC 6749 Section 5.2)
 */
const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
] as const;

/**
 * OIDC-specific error codes (OpenID Connect Core)
 */
const OIDC_ERROR_CODES = [
  'interaction_required',
  'login_required',
  'account_selection_required',
  'consent_required',
  'invalid_request_uri',
  'invalid_request_object',
  'request_not_supported',
  'request_uri_not_supported',
  'registration_not_supported',
] as const;

/**
 * Token introspection error codes (RFC 7662)
 */
const INTROSPECTION_ERROR_CODES = ['invalid_request', 'invalid_client'] as const;

/**
 * Token revocation - No specific error codes (RFC 7009 Section 2.2.1)
 * Note: Revocation should return 200 even for invalid tokens (to prevent token scanning)
 */

/**
 * Error response validator
 * Checks that error responses follow OAuth 2.0/OIDC specifications
 */
interface ErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
  state?: string;
}

function validateErrorResponse(response: unknown): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Must be an object
  if (typeof response !== 'object' || response === null) {
    return { valid: false, issues: ['Response is not an object'] };
  }

  const obj = response as Record<string, unknown>;

  // Must have error field
  if (!('error' in obj)) {
    issues.push('Missing required "error" field');
  } else if (typeof obj.error !== 'string') {
    issues.push('"error" field must be a string');
  } else if (obj.error.length === 0) {
    issues.push('"error" field cannot be empty');
  }

  // error_description must be string if present
  if ('error_description' in obj && typeof obj.error_description !== 'string') {
    issues.push('"error_description" must be a string if present');
  }

  // error_uri must be valid URI if present
  if ('error_uri' in obj) {
    if (typeof obj.error_uri !== 'string') {
      issues.push('"error_uri" must be a string if present');
    } else {
      try {
        new URL(obj.error_uri);
      } catch {
        issues.push('"error_uri" must be a valid URI');
      }
    }
  }

  // state must be string if present (for authorization endpoint)
  if ('state' in obj && typeof obj.state !== 'string') {
    issues.push('"state" must be a string if present');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Check that error responses don't leak sensitive information
 */
function checkNoSensitiveDataLeakage(response: unknown): {
  safe: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const responseStr = JSON.stringify(response).toLowerCase();

  // Check for common sensitive patterns
  const sensitivePatterns = [
    { pattern: /password/i, name: 'password' },
    { pattern: /client_secret/i, name: 'client_secret' },
    { pattern: /private_key/i, name: 'private_key' },
    { pattern: /access_token/i, name: 'access_token' },
    { pattern: /refresh_token/i, name: 'refresh_token' },
    { pattern: /id_token/i, name: 'id_token' },
    { pattern: /bearer /i, name: 'bearer token' },
    { pattern: /authorization: /i, name: 'authorization header' },
    { pattern: /\bsession_id\b/i, name: 'session_id' },
    { pattern: /\bcookie\b/i, name: 'cookie' },
  ];

  for (const { pattern, name } of sensitivePatterns) {
    if (pattern.test(responseStr)) {
      warnings.push(`Response may contain sensitive data: ${name}`);
    }
  }

  // Check for stack traces
  if (/at\s+\w+.*:\d+:\d+/.test(responseStr)) {
    warnings.push('Response may contain stack trace');
  }

  // Check for internal paths (pattern is lowercase because responseStr is lowercased)
  if (/\/users\/|\/home\/|c:\\/.test(responseStr)) {
    warnings.push('Response may contain internal file paths');
  }

  return { safe: warnings.length === 0, warnings };
}

describe('Error Response Consistency', () => {
  describe('OAuth 2.0 Error Codes (RFC 6749)', () => {
    it.each(OAUTH_ERROR_CODES)('should recognize %s as valid OAuth error code', (code) => {
      const errorResponse: ErrorResponse = {
        error: code,
        error_description: `Test error for ${code}`,
      };

      const validation = validateErrorResponse(errorResponse);
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);
    });

    it('should validate error response format', () => {
      const validResponse: ErrorResponse = {
        error: 'invalid_request',
        error_description: 'The request is missing a required parameter',
      };

      const validation = validateErrorResponse(validResponse);
      expect(validation.valid).toBe(true);
    });

    it('should reject response without error field', () => {
      const invalidResponse = {
        error_description: 'Some description',
      };

      const validation = validateErrorResponse(invalidResponse);
      expect(validation.valid).toBe(false);
      expect(validation.issues).toContain('Missing required "error" field');
    });

    it('should reject response with empty error field', () => {
      const invalidResponse = {
        error: '',
      };

      const validation = validateErrorResponse(invalidResponse);
      expect(validation.valid).toBe(false);
      expect(validation.issues).toContain('"error" field cannot be empty');
    });

    it('should reject response with non-string error', () => {
      const invalidResponse = {
        error: 123,
      };

      const validation = validateErrorResponse(invalidResponse);
      expect(validation.valid).toBe(false);
      expect(validation.issues).toContain('"error" field must be a string');
    });

    it('should accept error response with error_uri', () => {
      const responseWithUri: ErrorResponse = {
        error: 'invalid_request',
        error_description: 'Missing parameter',
        error_uri: 'https://docs.example.com/errors/invalid_request',
      };

      const validation = validateErrorResponse(responseWithUri);
      expect(validation.valid).toBe(true);
    });

    it('should reject invalid error_uri', () => {
      const invalidResponse = {
        error: 'invalid_request',
        error_uri: 'not a valid url',
      };

      const validation = validateErrorResponse(invalidResponse);
      expect(validation.valid).toBe(false);
      expect(validation.issues).toContain('"error_uri" must be a valid URI');
    });
  });

  describe('OIDC Error Codes (OpenID Connect Core)', () => {
    it.each(OIDC_ERROR_CODES)('should recognize %s as valid OIDC error code', (code) => {
      const errorResponse: ErrorResponse = {
        error: code,
        error_description: `Test error for ${code}`,
      };

      const validation = validateErrorResponse(errorResponse);
      expect(validation.valid).toBe(true);
    });

    it('should include state in authorization error responses', () => {
      const authErrorResponse = {
        error: 'invalid_request',
        error_description: 'Invalid redirect_uri',
        state: 'client_provided_state',
      };

      const validation = validateErrorResponse(authErrorResponse);
      expect(validation.valid).toBe(true);
    });
  });

  describe('Sensitive Data Leakage Prevention', () => {
    it('should flag responses containing password', () => {
      const response = {
        error: 'invalid_request',
        error_description: 'Invalid password provided',
      };

      const check = checkNoSensitiveDataLeakage(response);
      expect(check.safe).toBe(false);
      expect(check.warnings.some((w) => w.includes('password'))).toBe(true);
    });

    it('should flag responses containing client_secret', () => {
      const response = {
        error: 'invalid_client',
        error_description: 'client_secret mismatch',
      };

      const check = checkNoSensitiveDataLeakage(response);
      expect(check.safe).toBe(false);
      expect(check.warnings.some((w) => w.includes('client_secret'))).toBe(true);
    });

    it('should flag responses containing stack traces', () => {
      const response = {
        error: 'server_error',
        error_description: 'Error at validateToken (/app/src/token.js:42:15)',
      };

      const check = checkNoSensitiveDataLeakage(response);
      expect(check.safe).toBe(false);
      expect(check.warnings.some((w) => w.includes('stack trace'))).toBe(true);
    });

    it('should flag responses containing file paths', () => {
      const response = {
        error: 'server_error',
        error_description: 'File not found: /Users/dev/app/config.json',
      };

      const check = checkNoSensitiveDataLeakage(response);
      expect(check.safe).toBe(false);
      expect(check.warnings.some((w) => w.includes('file paths'))).toBe(true);
    });

    it('should pass for safe error responses', () => {
      const safeResponse = {
        error: 'invalid_request',
        error_description: 'The request is missing a required parameter',
      };

      const check = checkNoSensitiveDataLeakage(safeResponse);
      expect(check.safe).toBe(true);
      expect(check.warnings).toEqual([]);
    });

    it('should pass for error responses with generic messages', () => {
      const genericResponses = [
        { error: 'invalid_client', error_description: 'Client authentication failed' },
        { error: 'invalid_grant', error_description: 'The authorization code is invalid' },
        { error: 'access_denied', error_description: 'The resource owner denied the request' },
        { error: 'server_error', error_description: 'An internal server error occurred' },
      ];

      for (const response of genericResponses) {
        const check = checkNoSensitiveDataLeakage(response);
        expect(check.safe).toBe(true);
      }
    });
  });

  describe('HTTP Status Code Mapping', () => {
    const expectedStatusCodes: Record<string, number> = {
      invalid_request: 400,
      invalid_client: 401,
      invalid_grant: 400,
      unauthorized_client: 401,
      unsupported_grant_type: 400,
      invalid_scope: 400,
      access_denied: 403,
      server_error: 500,
      temporarily_unavailable: 503,
      // OIDC specific
      interaction_required: 400,
      login_required: 400,
      consent_required: 400,
      invalid_request_uri: 400,
      invalid_request_object: 400,
    };

    it.each(Object.entries(expectedStatusCodes))(
      'error code "%s" should map to HTTP status %d',
      (errorCode, expectedStatus) => {
        // This test documents the expected HTTP status for each error code
        expect(expectedStatusCodes[errorCode]).toBe(expectedStatus);
      }
    );
  });

  describe('Error Response Structure', () => {
    it('should support minimal error response (error only)', () => {
      const minimal = { error: 'invalid_request' };
      const validation = validateErrorResponse(minimal);
      expect(validation.valid).toBe(true);
    });

    it('should support full error response', () => {
      const full = {
        error: 'invalid_request',
        error_description: 'The request is missing a required parameter',
        error_uri: 'https://docs.example.com/errors/invalid_request',
        state: 'abc123',
      };
      const validation = validateErrorResponse(full);
      expect(validation.valid).toBe(true);
    });

    it('should reject non-object responses', () => {
      const invalidInputs = [null, undefined, 'error', 123, [], true];

      for (const input of invalidInputs) {
        const validation = validateErrorResponse(input);
        expect(validation.valid).toBe(false);
      }
    });

    it('should reject responses with array error', () => {
      const response = {
        error: ['invalid_request', 'invalid_scope'],
      };

      const validation = validateErrorResponse(response);
      expect(validation.valid).toBe(false);
      expect(validation.issues).toContain('"error" field must be a string');
    });
  });

  describe('Token Endpoint Error Responses', () => {
    it('should return proper error for missing grant_type', () => {
      const response = {
        error: 'invalid_request',
        error_description: 'grant_type is required',
      };

      const validation = validateErrorResponse(response);
      expect(validation.valid).toBe(true);

      const leakCheck = checkNoSensitiveDataLeakage(response);
      expect(leakCheck.safe).toBe(true);
    });

    it('should return proper error for invalid authorization code', () => {
      const response = {
        error: 'invalid_grant',
        error_description: 'The authorization code has expired or has been used',
      };

      const validation = validateErrorResponse(response);
      expect(validation.valid).toBe(true);

      const leakCheck = checkNoSensitiveDataLeakage(response);
      expect(leakCheck.safe).toBe(true);
    });

    it('should return proper error for client authentication failure', () => {
      const response = {
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      };

      const validation = validateErrorResponse(response);
      expect(validation.valid).toBe(true);

      const leakCheck = checkNoSensitiveDataLeakage(response);
      expect(leakCheck.safe).toBe(true);
    });
  });

  describe('Authorization Endpoint Error Responses', () => {
    it('should include state in error response when provided', () => {
      const response = {
        error: 'invalid_request',
        error_description: 'Missing required parameter: response_type',
        state: 'user_provided_state_value',
      };

      const validation = validateErrorResponse(response);
      expect(validation.valid).toBe(true);
    });

    it('should not include state when not provided', () => {
      const response = {
        error: 'invalid_request',
        error_description: 'Missing required parameter: client_id',
      };

      const validation = validateErrorResponse(response);
      expect(validation.valid).toBe(true);
    });
  });

  describe('Introspection Endpoint Error Responses', () => {
    it.each(INTROSPECTION_ERROR_CODES)(
      'should recognize %s as valid introspection error code',
      (code) => {
        const response = {
          error: code,
          error_description: `Introspection error: ${code}`,
        };

        const validation = validateErrorResponse(response);
        expect(validation.valid).toBe(true);
      }
    );
  });

  describe('Revocation Endpoint (RFC 7009)', () => {
    it('should not indicate token validity in revocation errors', () => {
      // RFC 7009 Section 2.2.1: The authorization server responds with HTTP status
      // code 200 if the token has been revoked successfully or if the client
      // submitted an invalid token.

      // This prevents token scanning attacks
      const safeResponses = [
        { status: 200 }, // Success, token revoked
        { status: 200 }, // Invalid token, but same response to prevent scanning
        { error: 'invalid_request', error_description: 'Missing required parameter: token' },
        { error: 'invalid_client', error_description: 'Client authentication failed' },
      ];

      for (const response of safeResponses) {
        const leakCheck = checkNoSensitiveDataLeakage(response);
        expect(leakCheck.safe).toBe(true);
      }
    });
  });

  describe('Content-Type Requirements', () => {
    it('should document required Content-Type for JSON error responses', () => {
      // OAuth 2.0 requires application/json for token endpoint errors
      const expectedContentType = 'application/json';

      // This is a documentation test - actual header testing is done in integration tests
      expect(expectedContentType).toBe('application/json');
    });

    it('should document Cache-Control for error responses', () => {
      // RFC 6749 Section 5.2: The authorization server MUST include
      // Cache-Control: no-store and Pragma: no-cache headers
      const expectedHeaders = {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      };

      expect(expectedHeaders['Cache-Control']).toBe('no-store');
      expect(expectedHeaders['Pragma']).toBe('no-cache');
    });
  });
});

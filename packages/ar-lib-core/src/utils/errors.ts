/**
 * OIDC Error Handling Utilities
 *
 * Provides centralized error handling for OpenID Connect and OAuth 2.0 errors.
 * Ensures consistent error responses across all endpoints.
 */

import type { Context } from 'hono';
import { ERROR_CODES, HTTP_STATUS } from '../constants';
import { createLogger } from './logger';

const log = createLogger().module('OIDC_ERROR');

/**
 * OIDC Error class
 * Represents an OAuth 2.0 or OpenID Connect error with standardized properties
 */
export class OIDCError extends Error {
  public readonly error: string;
  public readonly error_description?: string;
  public readonly error_uri?: string;
  public readonly statusCode: number;

  constructor(
    error: string,
    error_description?: string,
    statusCode: number = HTTP_STATUS.BAD_REQUEST,
    error_uri?: string
  ) {
    super(error_description || error);
    this.name = 'OIDCError';
    this.error = error;
    if (error_description !== undefined) {
      this.error_description = error_description;
    }
    if (error_uri !== undefined) {
      this.error_uri = error_uri;
    }
    this.statusCode = statusCode;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OIDCError);
    }
  }

  /**
   * Convert error to JSON response object
   */
  toJSON() {
    const response: {
      error: string;
      error_description?: string;
      error_uri?: string;
    } = {
      error: this.error,
    };

    if (this.error_description) {
      response.error_description = this.error_description;
    }

    if (this.error_uri) {
      response.error_uri = this.error_uri;
    }

    return response;
  }
}

/**
 * Handle OIDC error and return JSON response
 */
export function handleOIDCError(_c: Context, error: OIDCError): Response {
  // Log error for debugging (PII-safe: only error code, no description in production)
  // SECURITY: error_description may contain user input or sensitive details
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    log.error(`OIDC Error [${error.statusCode}]`, { errorCode: error.error });
  } else {
    log.error(`OIDC Error [${error.statusCode}]`, {
      errorCode: error.error,
      description: error.error_description,
    });
  }

  // Use Response constructor directly to avoid type issues with c.json()
  return new Response(JSON.stringify(error.toJSON()), {
    status: error.statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Handle token endpoint error
 * Includes no-cache headers as per OAuth 2.0 spec
 */
export function handleTokenError(_c: Context, error: OIDCError): Response {
  // Log error for debugging (PII-safe: only error code, no description in production)
  // SECURITY: error_description may contain user input or sensitive details
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    log.error(`OIDC Error [${error.statusCode}]`, { errorCode: error.error });
  } else {
    log.error(`OIDC Error [${error.statusCode}]`, {
      errorCode: error.error,
      description: error.error_description,
    });
  }

  return new Response(JSON.stringify(error.toJSON()), {
    status: error.statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

/**
 * Handle UserInfo endpoint error
 * Includes WWW-Authenticate header as per OAuth 2.0 Bearer Token spec
 */
export function handleUserInfoError(_c: Context, error: OIDCError): Response {
  // Log error for debugging (PII-safe: only error code, no description in production)
  // SECURITY: error_description may contain user input or sensitive details
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    log.error(`OIDC Error [${error.statusCode}]`, { errorCode: error.error });
  } else {
    log.error(`OIDC Error [${error.statusCode}]`, {
      errorCode: error.error,
      description: error.error_description,
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // RFC 6750 Section 3.1: Include error_description for better diagnostics
  if (error.statusCode === HTTP_STATUS.UNAUTHORIZED && error.error_description) {
    // Escape double quotes in error_description for header safety
    const escapedDescription = error.error_description.replace(/"/g, '\\"');
    headers['WWW-Authenticate'] =
      `Bearer error="${error.error}", error_description="${escapedDescription}"`;
  }

  return new Response(JSON.stringify(error.toJSON()), {
    status: error.statusCode,
    headers,
  });
}

/**
 * Redirect with error parameters (for authorization endpoint)
 * https://tools.ietf.org/html/rfc6749#section-4.1.2.1
 */
export function redirectWithError(
  redirectUri: string,
  error: string,
  errorDescription?: string,
  state?: string,
  errorUri?: string
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);

  if (errorDescription) {
    url.searchParams.set('error_description', errorDescription);
  }

  if (errorUri) {
    url.searchParams.set('error_uri', errorUri);
  }

  if (state) {
    url.searchParams.set('state', state);
  }

  return Response.redirect(url.toString(), HTTP_STATUS.FOUND);
}

/**
 * Pre-defined error factory functions for common errors
 *
 * Organized by RFC/specification:
 * - OAuth 2.0 Core (RFC 6749)
 * - Bearer Token (RFC 6750)
 * - OIDC Core 1.0
 * - Device Authorization Grant (RFC 8628)
 * - DPoP (RFC 9449)
 * - Dynamic Client Registration (RFC 7591)
 * - CIBA (OpenID Connect Client Initiated Backchannel Authentication)
 * - Token Exchange (RFC 8693)
 * - OpenID4VCI (OpenID for Verifiable Credential Issuance)
 */
export const ErrorFactory = {
  // =========================================================================
  // OAuth 2.0 Core Errors (RFC 6749)
  // =========================================================================

  /**
   * Invalid request error
   * The request is missing a required parameter or is otherwise malformed.
   */
  invalidRequest: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_REQUEST,
      description || 'The request is missing a required parameter or is otherwise malformed',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid client error
   * Client authentication failed.
   */
  invalidClient: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_CLIENT,
      description || 'Client authentication failed',
      HTTP_STATUS.UNAUTHORIZED
    ),

  /**
   * Invalid grant error
   * The provided authorization grant is invalid, expired, or revoked.
   */
  invalidGrant: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_GRANT,
      description || 'The provided authorization grant is invalid, expired, or revoked',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Unauthorized client error
   * The client is not authorized to use this authorization grant type.
   */
  unauthorizedClient: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.UNAUTHORIZED_CLIENT,
      description || 'The client is not authorized to use this authorization grant type',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Unsupported grant type error
   * The authorization grant type is not supported.
   */
  unsupportedGrantType: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.UNSUPPORTED_GRANT_TYPE,
      description || 'The authorization grant type is not supported',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid scope error
   * The requested scope is invalid, unknown, or malformed.
   */
  invalidScope: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_SCOPE,
      description || 'The requested scope is invalid, unknown, or malformed',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Access denied error
   * The resource owner or authorization server denied the request.
   */
  accessDenied: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.ACCESS_DENIED,
      description || 'The resource owner or authorization server denied the request',
      HTTP_STATUS.FORBIDDEN
    ),

  /**
   * Unsupported response type error
   * The authorization server does not support this response type.
   */
  unsupportedResponseType: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.UNSUPPORTED_RESPONSE_TYPE,
      description || 'The authorization server does not support this response type',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Server error
   * The authorization server encountered an unexpected error.
   */
  serverError: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.SERVER_ERROR,
      description || 'The authorization server encountered an unexpected error',
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    ),

  /**
   * Temporarily unavailable error
   * The server is temporarily overloaded or under maintenance.
   */
  temporarilyUnavailable: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.TEMPORARILY_UNAVAILABLE,
      description || 'The server is temporarily unavailable due to overload or maintenance',
      HTTP_STATUS.SERVICE_UNAVAILABLE
    ),

  // =========================================================================
  // Bearer Token Errors (RFC 6750)
  // =========================================================================

  /**
   * Invalid token error
   * The access token is invalid, expired, or revoked.
   */
  invalidToken: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_TOKEN,
      description || 'The access token is invalid, expired, or revoked',
      HTTP_STATUS.UNAUTHORIZED
    ),

  /**
   * Insufficient scope error
   * The token does not have the required scope for this resource.
   */
  insufficientScope: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INSUFFICIENT_SCOPE,
      description || 'The token does not have the required scope for this resource',
      HTTP_STATUS.FORBIDDEN
    ),

  // =========================================================================
  // OIDC Core 1.0 Errors
  // =========================================================================

  /**
   * Interaction required error
   * The authorization server requires end-user interaction.
   */
  interactionRequired: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INTERACTION_REQUIRED,
      description || 'The authorization server requires end-user interaction',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Login required error
   * The authorization server requires end-user authentication.
   */
  loginRequired: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.LOGIN_REQUIRED,
      description || 'The authorization server requires end-user authentication',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Account selection required error
   * The end-user must select an account.
   */
  accountSelectionRequired: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.ACCOUNT_SELECTION_REQUIRED,
      description || 'The end-user must select an account',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Consent required error
   * The authorization server requires end-user consent.
   */
  consentRequired: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.CONSENT_REQUIRED,
      description || 'The authorization server requires end-user consent',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid request URI error
   * The request_uri parameter is invalid.
   */
  invalidRequestUri: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_REQUEST_URI,
      description || 'The request_uri parameter is invalid',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid request object error
   * The request parameter contains an invalid Request Object.
   */
  invalidRequestObject: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_REQUEST_OBJECT,
      description || 'The request parameter contains an invalid Request Object',
      HTTP_STATUS.BAD_REQUEST
    ),

  // =========================================================================
  // Device Authorization Grant Errors (RFC 8628)
  // =========================================================================

  /**
   * Authorization pending error
   * The user has not yet completed authorization (polling should continue).
   */
  authorizationPending: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.AUTHORIZATION_PENDING,
      description || 'The authorization request is still pending',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Slow down error
   * The client is polling too frequently (should increase interval).
   */
  slowDown: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.SLOW_DOWN,
      description || 'Polling too frequently, please slow down',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Expired token error
   * The device code has expired.
   */
  expiredToken: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.EXPIRED_TOKEN,
      description || 'The device code has expired',
      HTTP_STATUS.BAD_REQUEST
    ),

  // =========================================================================
  // DPoP Errors (RFC 9449)
  // =========================================================================

  /**
   * Invalid DPoP proof error
   * The DPoP proof is invalid or malformed.
   */
  invalidDpopProof: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_DPOP_PROOF,
      description || 'The DPoP proof is invalid or malformed',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Use DPoP nonce error
   * The server requires a DPoP nonce (client should retry with provided nonce).
   */
  useDpopNonce: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.USE_DPOP_NONCE,
      description || 'A DPoP nonce is required, please retry with the provided nonce',
      HTTP_STATUS.BAD_REQUEST
    ),

  // =========================================================================
  // Dynamic Client Registration Errors (RFC 7591)
  // =========================================================================

  /**
   * Invalid client metadata error
   * The client metadata is invalid or malformed.
   */
  invalidClientMetadata: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_CLIENT_METADATA,
      description || 'The client metadata is invalid or malformed',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid redirect URI error
   * The redirect URI is invalid or not allowed.
   */
  invalidRedirectUri: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_REDIRECT_URI,
      description || 'The redirect URI is invalid or not allowed',
      HTTP_STATUS.BAD_REQUEST
    ),

  // =========================================================================
  // CIBA Errors (OpenID Connect Client Initiated Backchannel Authentication)
  // =========================================================================

  /**
   * Invalid binding message error
   * The binding message is invalid or exceeds allowed length.
   */
  invalidBindingMessage: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_BINDING_MESSAGE,
      description || 'The binding message is invalid or exceeds allowed length',
      HTTP_STATUS.BAD_REQUEST
    ),

  // =========================================================================
  // Token Exchange Errors (RFC 8693)
  // =========================================================================

  /**
   * Invalid target error
   * The token exchange target is invalid.
   */
  invalidTarget: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_TARGET,
      description || 'The token exchange target is invalid',
      HTTP_STATUS.BAD_REQUEST
    ),

  // =========================================================================
  // OpenID4VCI Errors (OpenID for Verifiable Credential Issuance)
  // =========================================================================

  /**
   * Unsupported credential format error
   * The credential format is not supported.
   */
  unsupportedCredentialFormat: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.UNSUPPORTED_CREDENTIAL_FORMAT,
      description || 'The credential format is not supported',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid proof error
   * The proof (key proof or similar) is invalid.
   */
  invalidProof: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_PROOF,
      description || 'The proof is invalid',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Issuance pending error
   * The credential issuance is pending (deferred issuance).
   */
  issuancePending: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.ISSUANCE_PENDING,
      description || 'The credential issuance is pending',
      HTTP_STATUS.OK // Note: 200 for deferred issuance per spec
    ),
};

/**
 * Wrap async handler with error handling
 */
export function withErrorHandling<T extends Context>(
  handler: (c: T) => Promise<Response>,
  errorHandler: (c: T, error: OIDCError) => Response = handleOIDCError
) {
  return async (c: T): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof OIDCError) {
        return errorHandler(c, error);
      }

      // Convert unknown errors to server errors
      // PII Protection: Don't log full error object (may contain user data in stack)
      log.error('Unexpected error', {}, error as Error);
      return errorHandler(
        c,
        // SECURITY: Do not expose internal error details in response
        ErrorFactory.serverError('An unexpected error occurred')
      );
    }
  };
}

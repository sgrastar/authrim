/**
 * OIDC Error Handling Utilities
 *
 * Provides centralized error handling for OpenID Connect and OAuth 2.0 errors.
 * Ensures consistent error responses across all endpoints.
 */

import type { Context } from 'hono';
import { ERROR_CODES, HTTP_STATUS } from '../constants';

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
    this.error_description = error_description;
    this.error_uri = error_uri;
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
export function handleOIDCError(c: Context, error: OIDCError): Response {
  // Log error for debugging
  console.error(`OIDC Error [${error.statusCode}]:`, {
    error: error.error,
    description: error.error_description,
    stack: error.stack,
  });

  return c.json(error.toJSON(), error.statusCode);
}

/**
 * Handle token endpoint error
 * Includes no-cache headers as per OAuth 2.0 spec
 */
export function handleTokenError(c: Context, error: OIDCError): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return handleOIDCError(c, error);
}

/**
 * Handle UserInfo endpoint error
 * Includes WWW-Authenticate header as per OAuth 2.0 Bearer Token spec
 */
export function handleUserInfoError(c: Context, error: OIDCError): Response {
  if (error.statusCode === HTTP_STATUS.UNAUTHORIZED) {
    c.header('WWW-Authenticate', `Bearer error="${error.error}"`);
  }
  return handleOIDCError(c, error);
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
 */
export const ErrorFactory = {
  /**
   * Invalid request error
   */
  invalidRequest: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_REQUEST,
      description || 'The request is missing a required parameter or is otherwise malformed',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid client error
   */
  invalidClient: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_CLIENT,
      description || 'Client authentication failed',
      HTTP_STATUS.UNAUTHORIZED
    ),

  /**
   * Invalid grant error
   */
  invalidGrant: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_GRANT,
      description || 'The provided authorization grant is invalid, expired, or revoked',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Unauthorized client error
   */
  unauthorizedClient: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.UNAUTHORIZED_CLIENT,
      description || 'The client is not authorized to use this authorization grant type',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Unsupported grant type error
   */
  unsupportedGrantType: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.UNSUPPORTED_GRANT_TYPE,
      description || 'The authorization grant type is not supported',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid scope error
   */
  invalidScope: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_SCOPE,
      description || 'The requested scope is invalid, unknown, or malformed',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Invalid token error
   */
  invalidToken: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INVALID_TOKEN,
      description || 'The access token is invalid, expired, or revoked',
      HTTP_STATUS.UNAUTHORIZED
    ),

  /**
   * Server error
   */
  serverError: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.SERVER_ERROR,
      description || 'The authorization server encountered an unexpected error',
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    ),

  /**
   * Access denied error
   */
  accessDenied: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.ACCESS_DENIED,
      description || 'The resource owner or authorization server denied the request',
      HTTP_STATUS.FORBIDDEN
    ),

  /**
   * Unsupported response type error
   */
  unsupportedResponseType: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.UNSUPPORTED_RESPONSE_TYPE,
      description || 'The authorization server does not support this response type',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Interaction required error (OIDC specific)
   */
  interactionRequired: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.INTERACTION_REQUIRED,
      description || 'The authorization server requires end-user interaction',
      HTTP_STATUS.BAD_REQUEST
    ),

  /**
   * Login required error (OIDC specific)
   */
  loginRequired: (description?: string): OIDCError =>
    new OIDCError(
      ERROR_CODES.LOGIN_REQUIRED,
      description || 'The authorization server requires end-user authentication',
      HTTP_STATUS.BAD_REQUEST
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
      console.error('Unexpected error:', error);
      return errorHandler(
        c,
        ErrorFactory.serverError(
          error instanceof Error ? error.message : 'An unexpected error occurred'
        )
      );
    }
  };
}

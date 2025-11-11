import type { Context } from 'hono';
import type { Env } from '../types/env';
import {
  validateResponseType,
  validateClientId,
  validateRedirectUri,
  validateScope,
  validateState,
  validateNonce,
} from '../utils/validation';
import { storeAuthCode } from '../utils/kv';
import type { AuthCodeData } from '../utils/kv';

/**
 * Authorization Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthorizationEndpoint
 *
 * Handles authorization requests and returns authorization codes
 */
export async function authorizeHandler(c: Context<{ Bindings: Env }>) {
  // Parse query parameters
  const response_type = c.req.query('response_type');
  const client_id = c.req.query('client_id');
  const redirect_uri = c.req.query('redirect_uri');
  const scope = c.req.query('scope');
  const state = c.req.query('state');
  const nonce = c.req.query('nonce');
  const code_challenge = c.req.query('code_challenge');
  const code_challenge_method = c.req.query('code_challenge_method');

  // Validate response_type
  const responseTypeValidation = validateResponseType(response_type);
  if (!responseTypeValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: responseTypeValidation.error,
      },
      400
    );
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Validate redirect_uri (allow http for development)
  const allowHttp = c.env.ALLOW_HTTP_REDIRECT === 'true';
  const redirectUriValidation = validateRedirectUri(redirect_uri, allowHttp);
  if (!redirectUriValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: redirectUriValidation.error,
      },
      400
    );
  }

  // From here on, we have a valid redirect_uri, so errors should be returned via redirect

  // Validate scope
  const scopeValidation = validateScope(scope);
  if (!scopeValidation.valid) {
    return redirectWithError(redirect_uri!, 'invalid_scope', scopeValidation.error, state);
  }

  // Validate state (optional)
  const stateValidation = validateState(state);
  if (!stateValidation.valid) {
    return redirectWithError(redirect_uri!, 'invalid_request', stateValidation.error, state);
  }

  // Validate nonce (optional)
  const nonceValidation = validateNonce(nonce);
  if (!nonceValidation.valid) {
    return redirectWithError(redirect_uri!, 'invalid_request', nonceValidation.error, state);
  }

  // Validate PKCE parameters if provided
  if (code_challenge) {
    if (!code_challenge_method) {
      return redirectWithError(
        redirect_uri!,
        'invalid_request',
        'code_challenge_method is required when code_challenge is provided',
        state
      );
    }

    // Only support S256 for security (plain is deprecated)
    if (code_challenge_method !== 'S256') {
      return redirectWithError(
        redirect_uri!,
        'invalid_request',
        'Unsupported code_challenge_method. Only S256 is supported',
        state
      );
    }

    // Validate code_challenge format (base64url, 43-128 characters)
    const base64urlPattern = /^[A-Za-z0-9_-]{43,128}$/;
    if (!base64urlPattern.test(code_challenge)) {
      return redirectWithError(
        redirect_uri!,
        'invalid_request',
        'Invalid code_challenge format',
        state
      );
    }
  }

  // Generate authorization code (UUID v4 for cryptographic security)
  const code = crypto.randomUUID();

  // For MVP, use a static subject (user identifier)
  // In a real implementation, this would come from user authentication
  const sub = 'user-' + crypto.randomUUID();

  // Store authorization code with metadata
  const authCodeData: AuthCodeData = {
    client_id: client_id!,
    redirect_uri: redirect_uri!,
    scope: scope!,
    sub,
    timestamp: Date.now(),
  };

  // Add optional parameters only if they are provided
  if (nonce) {
    authCodeData.nonce = nonce;
  }
  if (code_challenge && code_challenge_method) {
    authCodeData.code_challenge = code_challenge;
    authCodeData.code_challenge_method = code_challenge_method;
  }

  try {
    await storeAuthCode(c.env, code, authCodeData);
  } catch (error) {
    console.error('Failed to store authorization code:', error);
    return redirectWithError(
      redirect_uri!,
      'server_error',
      'Failed to process authorization request',
      state
    );
  }

  // Build redirect URL with authorization code
  const redirectUrl = new URL(redirect_uri!);
  redirectUrl.searchParams.set('code', code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  // Redirect to client's redirect_uri
  return c.redirect(redirectUrl.toString(), 302);
}

/**
 * Helper function to redirect with OAuth error parameters
 * https://tools.ietf.org/html/rfc6749#section-4.1.2.1
 */
function redirectWithError(
  redirectUri: string,
  error: string,
  errorDescription?: string,
  state?: string
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (errorDescription) {
    url.searchParams.set('error_description', errorDescription);
  }
  if (state) {
    url.searchParams.set('state', state);
  }

  return Response.redirect(url.toString(), 302);
}

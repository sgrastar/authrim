/**
 * PAR (Pushed Authorization Request) Endpoint Handler
 * RFC 9126 - OAuth 2.0 Pushed Authorization Requests
 *
 * This endpoint allows clients to push authorization request parameters
 * directly to the authorization server, receiving a request_uri in return.
 * This enhances security by:
 * - Preventing request parameter tampering
 * - Reducing URL length limitations
 * - Providing better privacy for request parameters
 */

import type { Context } from 'hono';
import type { Env } from '../types/env';
import { OIDCError } from '../utils/errors';
import { ERROR_CODES, HTTP_STATUS } from '../constants';
import { validateClientId, validateRedirectUri, validateScope } from '../utils/validation';

/**
 * PAR request parameters interface
 */
interface PARRequestParams {
  client_id: string;
  response_type: string;
  redirect_uri: string;
  scope: string;
  state?: string | undefined;
  nonce?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  response_mode?: string | undefined;
  prompt?: string | undefined;
  display?: string | undefined;
  max_age?: string | undefined;
  ui_locales?: string | undefined;
  id_token_hint?: string | undefined;
  login_hint?: string | undefined;
  acr_values?: string | undefined;
  claims?: string | undefined;
}

/**
 * Validate PAR request parameters
 */
function validatePARParams(formData: Record<string, unknown>): PARRequestParams {
  const client_id = formData.client_id;
  const response_type = formData.response_type;
  const redirect_uri = formData.redirect_uri;
  const scope = formData.scope;

  // Validate required parameters
  if (!client_id || typeof client_id !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'client_id is required');
  }
  if (!response_type || typeof response_type !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'response_type is required');
  }
  if (!redirect_uri || typeof redirect_uri !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'redirect_uri is required');
  }
  if (!scope || typeof scope !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'scope is required');
  }

  return {
    client_id,
    response_type,
    redirect_uri,
    scope,
    state: typeof formData.state === 'string' ? formData.state : undefined,
    nonce: typeof formData.nonce === 'string' ? formData.nonce : undefined,
    code_challenge: typeof formData.code_challenge === 'string' ? formData.code_challenge : undefined,
    code_challenge_method: typeof formData.code_challenge_method === 'string' ? formData.code_challenge_method : undefined,
    response_mode: typeof formData.response_mode === 'string' ? formData.response_mode : undefined,
    prompt: typeof formData.prompt === 'string' ? formData.prompt : undefined,
    display: typeof formData.display === 'string' ? formData.display : undefined,
    max_age: typeof formData.max_age === 'string' ? formData.max_age : undefined,
    ui_locales: typeof formData.ui_locales === 'string' ? formData.ui_locales : undefined,
    id_token_hint: typeof formData.id_token_hint === 'string' ? formData.id_token_hint : undefined,
    login_hint: typeof formData.login_hint === 'string' ? formData.login_hint : undefined,
    acr_values: typeof formData.acr_values === 'string' ? formData.acr_values : undefined,
    claims: typeof formData.claims === 'string' ? formData.claims : undefined,
  };
}

/**
 * Generate a secure request URI
 */
function generateRequestUri(): string {
  // RFC 9126: request URI MUST be a URN using urn:ietf:params:oauth:request_uri: scheme
  return `urn:ietf:params:oauth:request_uri:${crypto.randomUUID()}`;
}

/**
 * PAR endpoint handler
 * POST /as/par
 */
export async function parHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // RFC 9126: PAR endpoint MUST only accept POST requests
    if (c.req.method !== 'POST') {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        'PAR endpoint only accepts POST requests',
        HTTP_STATUS.METHOD_NOT_ALLOWED
      );
    }

    // Parse request body (application/x-www-form-urlencoded)
    const contentType = c.req.header('content-type');
    if (!contentType?.includes('application/x-www-form-urlencoded')) {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        'Content-Type must be application/x-www-form-urlencoded'
      );
    }

    const formData = await c.req.parseBody();

    // Validate request parameters
    const params = validatePARParams(formData as Record<string, unknown>);

    // Validate client_id
    const clientValidation = validateClientId(params.client_id);
    if (!clientValidation.valid) {
      throw new OIDCError(ERROR_CODES.INVALID_CLIENT, clientValidation.error || 'Invalid client_id');
    }

    // Verify client exists (optional: implement client authentication here)
    const client = await c.env.CLIENTS.get(params.client_id);
    if (!client) {
      throw new OIDCError(ERROR_CODES.INVALID_CLIENT, 'Client not found');
    }

    const clientData = JSON.parse(client);

    // Validate redirect_uri against registered URIs
    const redirectValidation = validateRedirectUri(params.redirect_uri);
    if (!redirectValidation.valid) {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        redirectValidation.error || 'Invalid redirect_uri'
      );
    }

    if (!clientData.redirect_uris.includes(params.redirect_uri)) {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        'redirect_uri not registered for this client'
      );
    }

    // Validate scope
    const scopeValidation = validateScope(params.scope);
    if (!scopeValidation.valid) {
      throw new OIDCError(ERROR_CODES.INVALID_SCOPE, scopeValidation.error || 'Invalid scope');
    }

    // Validate response_type
    const supportedResponseTypes = ['code', 'code id_token', 'code token', 'code id_token token'];
    if (!supportedResponseTypes.includes(params.response_type)) {
      throw new OIDCError(
        ERROR_CODES.UNSUPPORTED_RESPONSE_TYPE,
        `Unsupported response_type. Supported types: ${supportedResponseTypes.join(', ')}`
      );
    }

    // PKCE validation
    if (params.code_challenge) {
      if (!params.code_challenge_method) {
        throw new OIDCError(
          ERROR_CODES.INVALID_REQUEST,
          'code_challenge_method is required when code_challenge is present'
        );
      }
      // RFC 7636: code_challenge MUST be 43-128 characters
      if (params.code_challenge.length < 43 || params.code_challenge.length > 128) {
        throw new OIDCError(
          ERROR_CODES.INVALID_REQUEST,
          'code_challenge must be between 43 and 128 characters'
        );
      }
    }

    // Generate request_uri
    const requestUri = generateRequestUri();

    // Store request parameters in KV with TTL
    // RFC 9126: Recommended lifetime is short (e.g., 10 minutes)
    const REQUEST_URI_EXPIRY = 600; // 10 minutes

    const requestData = {
      client_id: params.client_id,
      response_type: params.response_type,
      redirect_uri: params.redirect_uri,
      scope: params.scope,
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.code_challenge,
      code_challenge_method: params.code_challenge_method,
      response_mode: params.response_mode,
      prompt: params.prompt,
      display: params.display,
      max_age: params.max_age,
      ui_locales: params.ui_locales,
      id_token_hint: params.id_token_hint,
      login_hint: params.login_hint,
      acr_values: params.acr_values,
      claims: params.claims,
      created_at: Date.now(),
    };

    // Store in KV namespace (we'll use STATE_STORE for request URIs)
    await c.env.STATE_STORE.put(
      `request_uri:${requestUri}`,
      JSON.stringify(requestData),
      { expirationTtl: REQUEST_URI_EXPIRY }
    );

    // RFC 9126: Return request_uri and expires_in
    return c.json(
      {
        request_uri: requestUri,
        expires_in: REQUEST_URI_EXPIRY,
      },
      201
    );
  } catch (error) {
    console.error('PAR error:', error);

    if (error instanceof OIDCError) {
      return c.json(
        {
          error: error.error,
          error_description: error.error_description,
        },
        error.statusCode as 200 | 201 | 400 | 401 | 404 | 405 | 500
      );
    }

    return c.json(
      {
        error: ERROR_CODES.SERVER_ERROR,
        error_description: 'An unexpected error occurred',
      },
      HTTP_STATUS.INTERNAL_SERVER_ERROR as 200 | 201 | 400 | 401 | 404 | 405 | 500
    );
  }
}

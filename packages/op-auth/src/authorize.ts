import type { Context } from 'hono';
import type { Env } from '@enrai/shared';
import {
  validateResponseType,
  validateClientId,
  validateRedirectUri,
  validateScope,
  validateState,
  validateNonce,
} from '@enrai/shared';
import { storeAuthCode } from '@enrai/shared';
import type { AuthCodeData } from '@enrai/shared';
import { generateSecureRandomString } from '@enrai/shared';

/**
 * Authorization Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthorizationEndpoint
 *
 * Handles authorization requests and returns authorization codes
 * Per OIDC Core 3.1.2.1: MUST support both GET and POST methods
 * RFC 9126: Supports request_uri parameter for PAR
 */
export async function authorizeHandler(c: Context<{ Bindings: Env }>) {
  // Parse parameters from either GET (query string) or POST (form body)
  // OIDC Core 3.1.2.1: Authorization Servers MUST support the use of the HTTP GET and POST methods
  let response_type: string | undefined;
  let client_id: string | undefined;
  let redirect_uri: string | undefined;
  let scope: string | undefined;
  let state: string | undefined;
  let nonce: string | undefined;
  let code_challenge: string | undefined;
  let code_challenge_method: string | undefined;
  let claims: string | undefined;
  let request_uri: string | undefined;
  let response_mode: string | undefined;

  if (c.req.method === 'POST') {
    // Parse POST body (application/x-www-form-urlencoded)
    try {
      const body = await c.req.parseBody();
      request_uri = typeof body.request_uri === 'string' ? body.request_uri : undefined;
      response_type = typeof body.response_type === 'string' ? body.response_type : undefined;
      client_id = typeof body.client_id === 'string' ? body.client_id : undefined;
      redirect_uri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
      scope = typeof body.scope === 'string' ? body.scope : undefined;
      state = typeof body.state === 'string' ? body.state : undefined;
      nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
      code_challenge = typeof body.code_challenge === 'string' ? body.code_challenge : undefined;
      code_challenge_method = typeof body.code_challenge_method === 'string' ? body.code_challenge_method : undefined;
      claims = typeof body.claims === 'string' ? body.claims : undefined;
      response_mode = typeof body.response_mode === 'string' ? body.response_mode : undefined;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        },
        400
      );
    }
  } else {
    // Parse GET query parameters
    request_uri = c.req.query('request_uri');
    response_type = c.req.query('response_type');
    client_id = c.req.query('client_id');
    redirect_uri = c.req.query('redirect_uri');
    scope = c.req.query('scope');
    state = c.req.query('state');
    nonce = c.req.query('nonce');
    code_challenge = c.req.query('code_challenge');
    code_challenge_method = c.req.query('code_challenge_method');
    claims = c.req.query('claims');
    response_mode = c.req.query('response_mode');
  }

  // RFC 9126: If request_uri is present, fetch parameters from PAR storage
  if (request_uri) {
    // Validate request_uri format
    if (!request_uri.startsWith('urn:ietf:params:oauth:request_uri:')) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid request_uri format',
        },
        400
      );
    }

    // Retrieve request parameters from KV storage
    const requestData = await c.env.STATE_STORE.get(`request_uri:${request_uri}`);

    if (!requestData) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired request_uri',
        },
        400
      );
    }

    try {
      const parsedData = JSON.parse(requestData) as {
        client_id: string;
        response_type: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        nonce?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        claims?: string;
        response_mode?: string;
      };

      // RFC 9126: When using request_uri, client_id from query MUST match client_id from PAR
      if (client_id && client_id !== parsedData.client_id) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'client_id mismatch',
          },
          400
        );
      }

      // Load parameters from PAR request
      response_type = parsedData.response_type;
      client_id = parsedData.client_id;
      redirect_uri = parsedData.redirect_uri;
      scope = parsedData.scope;
      state = parsedData.state;
      nonce = parsedData.nonce;
      code_challenge = parsedData.code_challenge;
      code_challenge_method = parsedData.code_challenge_method;
      claims = parsedData.claims;
      response_mode = parsedData.response_mode;

      // RFC 9126: request_uri is single-use, delete after retrieval
      await c.env.STATE_STORE.delete(`request_uri:${request_uri}`);
    } catch {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to process request_uri',
        },
        500
      );
    }
  }

  // Validate response_type
  const responseTypeValidation = validateResponseType(response_type);
  if (!responseTypeValidation.valid) {
    // OAuth 2.0 spec: use 'unsupported_response_type' for invalid response_type
    return c.json(
      {
        error: 'unsupported_response_type',
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
  // Type narrowing: redirect_uri is guaranteed to be a string at this point
  const validRedirectUri: string = redirect_uri as string;

  // Validate scope
  const scopeValidation = validateScope(scope);
  if (!scopeValidation.valid) {
    return redirectWithError(c, validRedirectUri, 'invalid_scope', scopeValidation.error, state);
  }

  // Validate state (optional)
  const stateValidation = validateState(state);
  if (!stateValidation.valid) {
    return redirectWithError(c, validRedirectUri, 'invalid_request', stateValidation.error, state);
  }

  // Validate nonce (optional)
  const nonceValidation = validateNonce(nonce);
  if (!nonceValidation.valid) {
    return redirectWithError(c, validRedirectUri, 'invalid_request', nonceValidation.error, state);
  }

  // Validate response_mode (optional)
  // Supported modes: query, fragment, form_post
  if (response_mode) {
    const supportedResponseModes = ['query', 'fragment', 'form_post'];
    if (!supportedResponseModes.includes(response_mode)) {
      return redirectWithError(
        c,
        validRedirectUri,
        'invalid_request',
        `Unsupported response_mode. Supported modes: ${supportedResponseModes.join(', ')}`,
        state
      );
    }

    // Validate response_mode compatibility with response_type
    // For response_type=code, only query and form_post are appropriate
    // fragment is typically used for implicit/hybrid flows
    if (response_type === 'code' && response_mode === 'fragment') {
      return redirectWithError(
        c,
        validRedirectUri,
        'invalid_request',
        'response_mode=fragment is not compatible with response_type=code',
        state
      );
    }
  }

  // Validate claims parameter (optional, per OIDC Core 5.5)
  if (claims) {
    try {
      const parsedClaims: unknown = JSON.parse(claims);

      // Validate claims structure
      if (typeof parsedClaims !== 'object' || parsedClaims === null || Array.isArray(parsedClaims)) {
        return redirectWithError(
          c,
          validRedirectUri,
          'invalid_request',
          'claims parameter must be a JSON object',
          state
        );
      }

      // Validate that claims object contains valid sections (userinfo and/or id_token)
      const validSections = ['userinfo', 'id_token'];
      const claimsSections = Object.keys(parsedClaims as Record<string, unknown>);

      if (claimsSections.length === 0) {
        return redirectWithError(
          c,
          validRedirectUri,
          'invalid_request',
          'claims parameter must contain at least one of: userinfo, id_token',
          state
        );
      }

      for (const section of claimsSections) {
        if (!validSections.includes(section)) {
          return redirectWithError(
            c,
            validRedirectUri,
            'invalid_request',
            `Invalid claims section: ${section}. Must be one of: ${validSections.join(', ')}`,
            state
          );
        }

        // Validate section contains an object
        const claimsObj = parsedClaims as Record<string, unknown>;
        if (typeof claimsObj[section] !== 'object' || claimsObj[section] === null) {
          return redirectWithError(
            c,
            validRedirectUri,
            'invalid_request',
            `claims.${section} must be an object`,
            state
          );
        }
      }
    } catch {
      return redirectWithError(
        c,
        validRedirectUri,
        'invalid_request',
        'claims parameter must be valid JSON',
        state
      );
    }
  }

  // Validate PKCE parameters if provided
  if (code_challenge) {
    if (!code_challenge_method) {
      return redirectWithError(
        c,
        validRedirectUri,
        'invalid_request',
        'code_challenge_method is required when code_challenge is provided',
        state
      );
    }

    // Only support S256 for security (plain is deprecated)
    if (code_challenge_method !== 'S256') {
      return redirectWithError(
        c,
        validRedirectUri,
        'invalid_request',
        'Unsupported code_challenge_method. Only S256 is supported',
        state
      );
    }

    // Validate code_challenge format (base64url, 43-128 characters)
    const base64urlPattern = /^[A-Za-z0-9_-]{43,128}$/;
    if (!base64urlPattern.test(code_challenge)) {
      return redirectWithError(
        c,
        validRedirectUri,
        'invalid_request',
        'Invalid code_challenge format',
        state
      );
    }
  }

  // Generate authorization code (cryptographically secure random string, base64url format, ~128 characters)
  // Using 96 bytes results in approximately 128 characters in base64url encoding
  const code = generateSecureRandomString(96);

  // For MVP, use a static subject (user identifier)
  // In a real implementation, this would come from user authentication
  const sub = 'user-' + crypto.randomUUID();

  // Type narrowing: client_id and scope are guaranteed to be strings at this point
  const validClientId: string = client_id as string;
  const validScope: string = scope as string;

  // Store authorization code with metadata
  const authCodeData: AuthCodeData = {
    client_id: validClientId,
    redirect_uri: validRedirectUri,
    scope: validScope,
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
  if (claims) {
    authCodeData.claims = claims;
  }

  try {
    await storeAuthCode(c.env, code, authCodeData);
  } catch (error) {
    console.error('Failed to store authorization code:', error);
    return redirectWithError(
      c,
      validRedirectUri,
      'server_error',
      'Failed to process authorization request',
      state
    );
  }

  // Determine response mode (default is 'query' for response_type=code)
  const effectiveResponseMode = response_mode || 'query';

  // Handle response based on response_mode
  if (effectiveResponseMode === 'form_post') {
    // OAuth 2.0 Form Post Response Mode
    // Return HTML page with auto-submitting form
    return createFormPostResponse(c, validRedirectUri, code, state);
  } else {
    // Default: query response mode (redirect with query parameters)
    const redirectUrl = new URL(validRedirectUri);
    redirectUrl.searchParams.set('code', code);
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    // Redirect to client's redirect_uri
    return c.redirect(redirectUrl.toString(), 302);
  }
}

/**
 * Helper function to redirect with OAuth error parameters
 * https://tools.ietf.org/html/rfc6749#section-4.1.2.1
 */
function redirectWithError(
  c: Context<{ Bindings: Env }>,
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

  return c.redirect(url.toString(), 302);
}

/**
 * Create Form Post Response
 * OAuth 2.0 Form Post Response Mode
 * https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html
 *
 * Returns an HTML page with an auto-submitting form that POSTs the
 * authorization response parameters to the client's redirect_uri
 */
function createFormPostResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  code: string,
  state?: string
): Response {
  // Build form inputs
  const inputs: string[] = [
    `<input type="hidden" name="code" value="${escapeHtml(code)}" />`,
  ];

  if (state) {
    inputs.push(`<input type="hidden" name="state" value="${escapeHtml(state)}" />`);
  }

  // Generate HTML page with auto-submitting form
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      text-align: center;
      color: white;
    }
    .spinner {
      width: 50px;
      height: 50px;
      margin: 0 auto 20px;
      border: 4px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .message {
      font-size: 18px;
      margin-bottom: 10px;
    }
    .note {
      font-size: 14px;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p class="message">Redirecting to application...</p>
    <p class="note">Please wait</p>
  </div>
  <form id="auth-form" method="post" action="${escapeHtml(redirectUri)}">
    ${inputs.join('\n    ')}
  </form>
  <script>
    // Auto-submit form immediately
    document.getElementById('auth-form').submit();
  </script>
</body>
</html>`;

  return c.html(html, 200);
}

/**
 * Escape HTML special characters to prevent XSS
 * Essential for safely embedding user-provided values in HTML
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

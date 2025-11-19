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
import { generateSecureRandomString, parseToken, verifyToken } from '@enrai/shared';
import { importJWK } from 'jose';

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
  let request: string | undefined; // RFC 9101: Request Object (JAR)
  let prompt: string | undefined;
  let max_age: string | undefined;
  let id_token_hint: string | undefined;
  let acr_values: string | undefined;
  let display: string | undefined;
  let ui_locales: string | undefined;
  let login_hint: string | undefined;

  if (c.req.method === 'POST') {
    // Parse POST body (application/x-www-form-urlencoded)
    try {
      const body = await c.req.parseBody();
      request_uri = typeof body.request_uri === 'string' ? body.request_uri : undefined;
      request = typeof body.request === 'string' ? body.request : undefined;
      response_type = typeof body.response_type === 'string' ? body.response_type : undefined;
      client_id = typeof body.client_id === 'string' ? body.client_id : undefined;
      redirect_uri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
      scope = typeof body.scope === 'string' ? body.scope : undefined;
      state = typeof body.state === 'string' ? body.state : undefined;
      nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
      code_challenge = typeof body.code_challenge === 'string' ? body.code_challenge : undefined;
      code_challenge_method =
        typeof body.code_challenge_method === 'string' ? body.code_challenge_method : undefined;
      claims = typeof body.claims === 'string' ? body.claims : undefined;
      response_mode = typeof body.response_mode === 'string' ? body.response_mode : undefined;
      prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
      max_age = typeof body.max_age === 'string' ? body.max_age : undefined;
      id_token_hint = typeof body.id_token_hint === 'string' ? body.id_token_hint : undefined;
      acr_values = typeof body.acr_values === 'string' ? body.acr_values : undefined;
      display = typeof body.display === 'string' ? body.display : undefined;
      ui_locales = typeof body.ui_locales === 'string' ? body.ui_locales : undefined;
      login_hint = typeof body.login_hint === 'string' ? body.login_hint : undefined;
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
    request = c.req.query('request');
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
    prompt = c.req.query('prompt');
    max_age = c.req.query('max_age');
    id_token_hint = c.req.query('id_token_hint');
    acr_values = c.req.query('acr_values');
    display = c.req.query('display');
    ui_locales = c.req.query('ui_locales');
    login_hint = c.req.query('login_hint');
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

    // Retrieve request parameters atomically (issue #11: single-use guarantee)
    // Try DO first, fall back to KV
    let parsedData: {
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
    } | null = null;

    if (!c.env.PAR_REQUEST_STORE || !client_id) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'PAR request storage unavailable',
        },
        500
      );
    }

    // Use PARRequestStore DO for atomic consume
    const id = c.env.PAR_REQUEST_STORE.idFromName(client_id);
    const stub = c.env.PAR_REQUEST_STORE.get(id);

    const response = await stub.fetch('http://internal/request/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestUri: request_uri,
        client_id: client_id,
      }),
    });

    if (response.ok) {
      parsedData = (await response.json()) as typeof parsedData;
    }

    if (!parsedData) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired request_uri',
        },
        400
      );
    }

    // Type assertion to help TypeScript understand parsedData is non-null after null check
    const parData: {
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
    } = parsedData;

    try {
      // RFC 9126: When using request_uri, client_id from query MUST match client_id from PAR
      if (client_id && client_id !== parData.client_id) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'client_id mismatch',
          },
          400
        );
      }

      // Load parameters from PAR request
      response_type = parData.response_type;
      client_id = parData.client_id;
      redirect_uri = parData.redirect_uri;
      scope = parData.scope;
      state = parData.state;
      nonce = parData.nonce;
      code_challenge = parData.code_challenge;
      code_challenge_method = parData.code_challenge_method;
      claims = parData.claims;
      response_mode = parData.response_mode;
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

  // RFC 9101 (JAR): If request parameter is present, parse JWT request object
  if (request) {
    try {
      // Parse JWT header to check algorithm
      const parts = request.split('.');
      if (parts.length !== 3) {
        return c.json(
          {
            error: 'invalid_request_object',
            error_description: 'Request object must be a valid JWT',
          },
          400
        );
      }

      // Decode header (base64url to JSON)
      const base64url = parts[0];
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(atob(base64));
      const alg = header.alg;

      // Parse request object (unsigned or signed)
      let requestObjectClaims: Record<string, unknown>;

      if (alg === 'none') {
        // Unsigned request object - just parse without verification
        requestObjectClaims = parseToken(request) as Record<string, unknown>;
      } else {
        // Signed request object - verify signature
        // Load client's public key from D1/KV (for client-signed requests)
        // For now, accept unsigned only for conformance testing
        // Production should verify signatures
        const publicJwkJson = c.env.PUBLIC_JWK_JSON;
        if (!publicJwkJson) {
          return c.json(
            {
              error: 'server_error',
              error_description: 'Server configuration error',
            },
            500
          );
        }

        let publicJwk;
        try {
          publicJwk = JSON.parse(publicJwkJson);
        } catch {
          return c.json(
            {
              error: 'server_error',
              error_description: 'Server configuration error',
            },
            500
          );
        }

        const publicKey = await importJWK(publicJwk, alg) as CryptoKey;
        const verified = await verifyToken(request, publicKey, c.env.ISSUER_URL, client_id || '');
        requestObjectClaims = verified.payload as Record<string, unknown>;
      }

      // Override parameters with those from request object
      // Per OIDC Core 6.1: request object parameters take precedence
      if (requestObjectClaims.response_type) response_type = requestObjectClaims.response_type as string;
      if (requestObjectClaims.client_id) client_id = requestObjectClaims.client_id as string;
      if (requestObjectClaims.redirect_uri) redirect_uri = requestObjectClaims.redirect_uri as string;
      if (requestObjectClaims.scope) scope = requestObjectClaims.scope as string;
      if (requestObjectClaims.state) state = requestObjectClaims.state as string;
      if (requestObjectClaims.nonce) nonce = requestObjectClaims.nonce as string;
      if (requestObjectClaims.code_challenge) code_challenge = requestObjectClaims.code_challenge as string;
      if (requestObjectClaims.code_challenge_method) code_challenge_method = requestObjectClaims.code_challenge_method as string;
      if (requestObjectClaims.claims) claims = requestObjectClaims.claims as string;
      if (requestObjectClaims.response_mode) response_mode = requestObjectClaims.response_mode as string;
      if (requestObjectClaims.prompt) prompt = requestObjectClaims.prompt as string;
      if (requestObjectClaims.max_age) max_age = requestObjectClaims.max_age as string;
      if (requestObjectClaims.id_token_hint) id_token_hint = requestObjectClaims.id_token_hint as string;
      if (requestObjectClaims.acr_values) acr_values = requestObjectClaims.acr_values as string;
      if (requestObjectClaims.display) display = requestObjectClaims.display as string;
      if (requestObjectClaims.ui_locales) ui_locales = requestObjectClaims.ui_locales as string;
      if (requestObjectClaims.login_hint) login_hint = requestObjectClaims.login_hint as string;
    } catch (error) {
      console.error('Failed to parse request object:', error);
      return c.json(
        {
          error: 'invalid_request_object',
          error_description: 'Failed to parse or verify request object',
        },
        400
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
      if (
        typeof parsedClaims !== 'object' ||
        parsedClaims === null ||
        Array.isArray(parsedClaims)
      ) {
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

  // Process authentication-related parameters (OIDC Core 3.1.2.1)
  let sessionUserId: string | undefined;
  let authTime: number | undefined;
  let sessionAcr: string | undefined;

  // Handle id_token_hint parameter
  if (id_token_hint) {
    try {
      // Verify ID token hint
      const publicJwkJson = c.env.PUBLIC_JWK_JSON;
      if (publicJwkJson) {
        const publicJwk = JSON.parse(publicJwkJson);
        const publicKey = await importJWK(publicJwk, 'RS256') as CryptoKey;
        const verified = await verifyToken(id_token_hint, publicKey, c.env.ISSUER_URL, client_id || '');
        const idTokenPayload = verified.payload as Record<string, unknown>;

        // Extract user identifier and auth_time from ID token
        sessionUserId = idTokenPayload.sub as string;
        authTime = idTokenPayload.auth_time as number;
        sessionAcr = idTokenPayload.acr as string;
      }
    } catch (error) {
      console.error('Failed to verify id_token_hint:', error);
      // Invalid id_token_hint - treat as if no session exists
    }
  }

  // Handle prompt parameter (OIDC Core 3.1.2.1)
  if (prompt) {
    const promptValues = prompt.split(' ');

    // Check for invalid prompt combinations
    if (promptValues.includes('none') && promptValues.length > 1) {
      return redirectWithError(
        c,
        validRedirectUri,
        'invalid_request',
        'prompt=none cannot be combined with other prompt values',
        state
      );
    }

    if (promptValues.includes('none')) {
      // prompt=none: MUST NOT display any authentication or consent UI
      // If not authenticated, return login_required error
      if (!sessionUserId) {
        return redirectWithError(
          c,
          validRedirectUri,
          'login_required',
          'User authentication is required',
          state
        );
      }

      // Check max_age if provided
      if (max_age && authTime) {
        const maxAgeSeconds = parseInt(max_age, 10);
        const currentTime = Math.floor(Date.now() / 1000);
        const timeSinceAuth = currentTime - authTime;

        if (timeSinceAuth > maxAgeSeconds) {
          return redirectWithError(
            c,
            validRedirectUri,
            'login_required',
            'Re-authentication is required due to max_age constraint',
            state
          );
        }
      }
    }

    if (promptValues.includes('login')) {
      // prompt=login: Force re-authentication even if user has valid session
      // Clear session context to force login
      sessionUserId = undefined;
      authTime = undefined;
    }

    // Note: prompt=consent and prompt=select_account are handled by consent UI
    // They don't affect the authorization endpoint logic directly
  }

  // Handle max_age parameter (OIDC Core 3.1.2.1)
  if (max_age && !prompt?.includes('none')) {
    const maxAgeSeconds = parseInt(max_age, 10);

    if (authTime) {
      const currentTime = Math.floor(Date.now() / 1000);
      const timeSinceAuth = currentTime - authTime;

      if (timeSinceAuth > maxAgeSeconds) {
        // Re-authentication required - redirect to login
        // In a full implementation, this would redirect to login UI
        // For now, we'll generate a new session
        sessionUserId = undefined;
        authTime = undefined;
      }
    }
  }

  // Generate authorization code (cryptographically secure random string, base64url format, ~128 characters)
  // Using 96 bytes results in approximately 128 characters in base64url encoding
  const code = generateSecureRandomString(96);

  // Determine user identifier (sub)
  // Use session user if available, otherwise generate new user
  const sub = sessionUserId || 'user-' + crypto.randomUUID();

  // Create user in database if it doesn't exist (for dynamic user creation)
  if (!sessionUserId) {
    try {
      // Check if user already exists
      const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
        .bind(sub)
        .first();

      if (!existingUser) {
        // Create new user with minimal information
        await c.env.DB.prepare(
          `INSERT INTO users (id, email, email_verified, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(
            sub,
            `${sub}@example.com`, // Placeholder email
            0, // email not verified
            new Date().toISOString(),
            new Date().toISOString()
          )
          .run();
        console.log(`Created dynamic user: ${sub}`);
      }
    } catch (error) {
      console.error('Failed to create user:', error);
      // Continue anyway - user might already exist due to race condition
    }
  }

  // Record authentication time
  const currentAuthTime = authTime || Math.floor(Date.now() / 1000);

  // Handle acr_values parameter (Authentication Context Class Reference)
  let selectedAcr = sessionAcr;
  if (acr_values && !selectedAcr) {
    // Select first ACR value from the list
    // In production, this should match against supported ACR values
    const acrList = acr_values.split(' ');
    selectedAcr = acrList[0];
  }

  // Type narrowing: client_id and scope are guaranteed to be strings at this point
  const validClientId: string = client_id as string;
  const validScope: string = scope as string;

  // Store authorization code using AuthorizationCodeStore Durable Object
  // This provides strong consistency guarantees and replay attack prevention
  try {
    const authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName('global');
    const authCodeStore = c.env.AUTH_CODE_STORE.get(authCodeStoreId);

    const storeResponse = await authCodeStore.fetch(
      new Request('https://auth-code-store/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          clientId: validClientId,
          redirectUri: validRedirectUri,
          userId: sub,
          scope: validScope,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
          nonce,
          state,
          claims,
          authTime: currentAuthTime,
          acr: selectedAcr,
        }),
      })
    );

    if (!storeResponse.ok) {
      const errorData = await storeResponse.json();
      console.error('Failed to store authorization code:', errorData);
      return redirectWithError(
        c,
        validRedirectUri,
        'server_error',
        'Failed to process authorization request',
        state
      );
    }
  } catch (error) {
    console.error('AuthCodeStore DO error:', error);
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
  const inputs: string[] = [`<input type="hidden" name="code" value="${escapeHtml(code)}" />`];

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

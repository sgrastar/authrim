import type { Context } from 'hono';
import type { Env } from '@enrai/shared';
import {
  validateGrantType,
  validateAuthCode,
  validateClientId,
  validateRedirectUri,
} from '@enrai/shared';
import {
  getAuthCode,
  markAuthCodeAsUsed,
  revokeToken,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
} from '@enrai/shared';
import {
  createIDToken,
  createAccessToken,
  calculateAtHash,
  createRefreshToken,
  parseToken,
  verifyToken,
} from '@enrai/shared';
import { importPKCS8, importJWK, type KeyLike } from 'jose';
import { extractDPoPProof, validateDPoPProof } from '@enrai/shared';

/**
 * Token Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#TokenEndpoint
 *
 * Exchanges authorization codes for ID tokens and access tokens
 * Also supports refresh token flow (RFC 6749 Section 6)
 */
export async function tokenHandler(c: Context<{ Bindings: Env }>) {
  // Verify Content-Type is application/x-www-form-urlencoded
  const contentType = c.req.header('Content-Type');
  if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400
    );
  }

  // Parse form data
  let formData: Record<string, string>;
  try {
    const body = await c.req.parseBody();
    formData = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
    );
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Failed to parse request body',
      },
      400
    );
  }

  const grant_type = formData.grant_type;

  // Route to appropriate handler based on grant_type
  if (grant_type === 'refresh_token') {
    return await handleRefreshTokenGrant(c, formData);
  } else if (grant_type === 'authorization_code') {
    return await handleAuthorizationCodeGrant(c, formData);
  }

  // If grant_type is not supported
  return c.json(
    {
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grant_type}' is not supported`,
    },
    400
  );
}

/**
 * Handle Authorization Code Grant
 * https://openid.net/specs/openid-connect-core-1_0.html#TokenEndpoint
 */
async function handleAuthorizationCodeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const grant_type = formData.grant_type;
  const code = formData.code;
  const redirect_uri = formData.redirect_uri;
  const code_verifier = formData.code_verifier;

  // Extract client credentials from either form data or Authorization header
  // Supports both client_secret_post and client_secret_basic authentication
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for HTTP Basic authentication (client_secret_basic)
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.substring(6);
      const credentials = atob(base64Credentials);
      const [basicClientId, basicClientSecret] = credentials.split(':', 2);

      // Use Basic auth credentials if form data doesn't provide them
      if (!client_id && basicClientId) {
        client_id = basicClientId;
      }
      if (!client_secret && basicClientSecret) {
        client_secret = basicClientSecret;
      }
    } catch {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid Authorization header format',
        },
        401
      );
    }
  }

  // Validate grant_type
  const grantTypeValidation = validateGrantType(grant_type);
  if (!grantTypeValidation.valid) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: grantTypeValidation.error,
      },
      400
    );
  }

  // Validate authorization code
  const codeValidation = validateAuthCode(code);
  if (!codeValidation.valid) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: codeValidation.error,
      },
      400
    );
  }

  // Type narrowing: code is guaranteed to be a string at this point
  const validCode: string = code as string;

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Validate redirect_uri
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

  // Retrieve authorization code data from KV
  const authCodeData = await getAuthCode(c.env, validCode);
  if (!authCodeData) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Authorization code is invalid or expired',
      },
      400
    );
  }

  // Check if authorization code has already been used (code reuse attack detection)
  // Per RFC 6749 Section 4.1.2: The authorization server MUST revoke tokens issued with the reused code
  if (authCodeData.used && authCodeData.jti) {
    console.warn(
      `Authorization code reuse detected! Code: ${code}, previously issued token JTI: ${authCodeData.jti}`
    );

    // Revoke the previously issued access token
    const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);
    await revokeToken(c.env, authCodeData.jti, expiresIn);

    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Authorization code has already been used',
      },
      400
    );
  }

  // Verify client_id matches
  if (authCodeData.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Authorization code was issued to a different client',
      },
      400
    );
  }

  // Verify redirect_uri matches
  if (authCodeData.redirect_uri !== redirect_uri) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'redirect_uri does not match the one used in authorization request',
      },
      400
    );
  }

  // Verify PKCE if code_challenge was used in authorization request
  if (authCodeData.code_challenge) {
    if (!code_verifier) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'code_verifier is required for PKCE',
        },
        400
      );
    }

    // Verify code_verifier against code_challenge
    const isValid = await verifyPKCE(code_verifier, authCodeData.code_challenge);
    if (!isValid) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Invalid code_verifier',
        },
        400
      );
    }
  }

  // Load private key for signing tokens
  // NOTE: Key loading moved BEFORE code deletion to avoid losing code on key loading failure
  const privateKeyPEM = c.env.PRIVATE_KEY_PEM;
  const keyId = c.env.KEY_ID || 'default';

  if (!privateKeyPEM) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'Server configuration error',
      },
      500
    );
  }

  let privateKey;
  try {
    privateKey = await importPKCS8(privateKeyPEM, 'RS256');
  } catch (error) {
    console.error('Failed to import private key:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  // Token expiration
  const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);

  // DPoP support (RFC 9449)
  // Extract and validate DPoP proof if present
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  let dpopJkt: string | undefined;
  let tokenType: 'Bearer' | 'DPoP' = 'Bearer';

  if (dpopProof) {
    // Validate DPoP proof
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      c.req.url,
      undefined, // No access token yet (this is token issuance)
      c.env.NONCE_STORE
    );

    if (!dpopValidation.valid) {
      return c.json(
        {
          error: dpopValidation.error || 'invalid_dpop_proof',
          error_description: dpopValidation.error_description || 'DPoP proof validation failed',
        },
        400
      );
    }

    // DPoP proof is valid, bind access token to the public key
    dpopJkt = dpopValidation.jkt;
    tokenType = 'DPoP';
  }

  // Note: For Authorization Code Flow (response_type=code), scope-based claims
  // (profile, email, etc.) should be returned from the UserInfo endpoint, NOT in the ID token.
  // Only response_type=id_token (Implicit Flow) should include these claims in the ID token.
  // See OpenID Connect Core 5.4: "The Claims requested by the profile, email, address, and
  // phone scope values are returned from the UserInfo Endpoint"

  // Generate Access Token FIRST (needed for at_hash in ID token)
  const accessTokenClaims: {
    iss: string;
    sub: string;
    aud: string;
    scope: string;
    client_id: string;
    claims?: string;
    cnf?: { jkt: string };
  } = {
    iss: c.env.ISSUER_URL,
    sub: authCodeData.sub,
    aud: c.env.ISSUER_URL, // For MVP, access token audience is the issuer
    scope: authCodeData.scope,
    client_id: client_id,
  };

  // Add claims parameter if it was requested during authorization
  if (authCodeData.claims) {
    accessTokenClaims.claims = authCodeData.claims;
  }

  // Add DPoP confirmation (cnf) claim if DPoP is used
  if (dpopJkt) {
    accessTokenClaims.cnf = { jkt: dpopJkt };
  }

  let accessToken: string;
  let tokenJti: string;
  try {
    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
    tokenJti = result.jti;
  } catch (error) {
    console.error('Failed to create access token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Calculate at_hash for ID Token
  // https://openid.net/specs/openid-connect-core-1_0.html#CodeIDToken
  let atHash: string;
  try {
    atHash = await calculateAtHash(accessToken);
  } catch (error) {
    console.error('Failed to calculate at_hash:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to calculate token hash',
      },
      500
    );
  }

  // Generate ID Token with at_hash
  const idTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: authCodeData.sub,
    aud: client_id,
    nonce: authCodeData.nonce,
    at_hash: atHash, // OIDC spec requirement for code flow
  };

  let idToken: string;
  try {
    // For Authorization Code Flow, ID token should only contain standard claims
    // Scope-based claims (profile, email) are returned from UserInfo endpoint
    idToken = await createIDToken(
      idTokenClaims,
      privateKey,
      keyId,
      expiresIn
    );
  } catch (error) {
    console.error('Failed to create ID token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Generate Refresh Token
  // https://tools.ietf.org/html/rfc6749#section-6
  let refreshToken: string;
  let refreshTokenJti: string;
  const refreshTokenExpiresIn = parseInt(c.env.REFRESH_TOKEN_EXPIRY, 10);

  try {
    const refreshTokenClaims = {
      iss: c.env.ISSUER_URL,
      sub: authCodeData.sub,
      aud: client_id,
      scope: authCodeData.scope,
      client_id: client_id,
    };

    const result = await createRefreshToken(
      refreshTokenClaims,
      privateKey,
      keyId,
      refreshTokenExpiresIn
    );
    refreshToken = result.token;
    refreshTokenJti = result.jti;

    // Store refresh token metadata in KV for validation and revocation
    await storeRefreshToken(c.env, refreshTokenJti, {
      jti: refreshTokenJti,
      client_id: client_id,
      sub: authCodeData.sub,
      scope: authCodeData.scope,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + refreshTokenExpiresIn,
    });
  } catch (error) {
    console.error('Failed to create refresh token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create refresh token',
      },
      500
    );
  }

  // Mark authorization code as used and store token JTI for revocation on code reuse
  // Per RFC 6749 Section 4.1.2: Authorization codes are single-use
  // We mark it as used instead of deleting to detect reuse attacks
  // NOTE: Only mark as used after successful token generation to allow retry on transient errors
  await markAuthCodeAsUsed(c.env, validCode, {
    ...authCodeData,
    jti: tokenJti,
  });

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: tokenType, // 'Bearer' or 'DPoP' depending on DPoP usage
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: authCodeData.scope, // OAuth 2.0 spec: include scope for clarity
  });
}

/**
 * Handle Refresh Token Grant
 * https://tools.ietf.org/html/rfc6749#section-6
 */
async function handleRefreshTokenGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const refreshTokenValue = formData.refresh_token;
  const scope = formData.scope; // Optional: requested scope (must be subset of original)

  // Extract client credentials from either form data or Authorization header
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for HTTP Basic authentication (client_secret_basic)
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.substring(6);
      const credentials = atob(base64Credentials);
      const [basicClientId, basicClientSecret] = credentials.split(':', 2);

      if (!client_id && basicClientId) {
        client_id = basicClientId;
      }
      if (!client_secret && basicClientSecret) {
        client_secret = basicClientSecret;
      }
    } catch {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid Authorization header format',
        },
        401
      );
    }
  }

  // Validate refresh_token parameter
  if (!refreshTokenValue) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      },
      400
    );
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Parse refresh token to get JTI (without verification yet)
  let refreshTokenPayload;
  try {
    refreshTokenPayload = parseToken(refreshTokenValue);
  } catch {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Invalid refresh token format',
      },
      400
    );
  }

  const jti = refreshTokenPayload.jti as string;
  if (!jti) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token missing JTI',
      },
      400
    );
  }

  // Retrieve refresh token metadata from KV
  const refreshTokenData = await getRefreshToken(c.env, jti);
  if (!refreshTokenData) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token is invalid or expired',
      },
      400
    );
  }

  // Verify client_id matches
  if (refreshTokenData.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token was issued to a different client',
      },
      400
    );
  }

  // Load public key for verification
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

  let publicKey;
  try {
    const jwk = JSON.parse(publicJwkJson) as Parameters<typeof importJWK>[0];
    publicKey = await importJWK(jwk, 'RS256') as KeyLike;
  } catch (err) {
    console.error('Failed to import public key:', err);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load verification key',
      },
      500
    );
  }

  // Verify refresh token signature
  try {
    await verifyToken(refreshTokenValue, publicKey, c.env.ISSUER_URL, client_id);
  } catch (error) {
    console.error('Refresh token verification failed:', error);
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token signature verification failed',
      },
      400
    );
  }

  // If scope is requested, validate it's a subset of the original scope
  let grantedScope = refreshTokenData.scope;
  if (scope) {
    const requestedScopes = scope.split(' ');
    const originalScopes = refreshTokenData.scope.split(' ');

    // Check if all requested scopes are in the original scope
    const isSubset = requestedScopes.every((s) => originalScopes.includes(s));
    if (!isSubset) {
      return c.json(
        {
          error: 'invalid_scope',
          error_description: 'Requested scope exceeds original scope',
        },
        400
      );
    }
    grantedScope = scope;
  }

  // Load private key for signing new tokens
  const privateKeyPEM = c.env.PRIVATE_KEY_PEM;
  const keyId = c.env.KEY_ID || 'default';

  if (!privateKeyPEM) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'Server configuration error',
      },
      500
    );
  }

  let privateKey;
  try {
    privateKey = await importPKCS8(privateKeyPEM, 'RS256');
  } catch (error) {
    console.error('Failed to import private key:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  // Token expiration
  const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);

  // DPoP support (RFC 9449)
  // Extract and validate DPoP proof if present
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  let dpopJkt: string | undefined;
  let tokenType: 'Bearer' | 'DPoP' = 'Bearer';

  if (dpopProof) {
    // Validate DPoP proof
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      c.req.url,
      undefined, // No access token yet (this is token refresh)
      c.env.NONCE_STORE
    );

    if (!dpopValidation.valid) {
      return c.json(
        {
          error: dpopValidation.error || 'invalid_dpop_proof',
          error_description: dpopValidation.error_description || 'DPoP proof validation failed',
        },
        400
      );
    }

    // DPoP proof is valid, bind access token to the public key
    dpopJkt = dpopValidation.jkt;
    tokenType = 'DPoP';
  }

  // Generate new Access Token
  let accessToken: string;
  try {
    const accessTokenClaims: {
      iss: string;
      sub: string;
      aud: string;
      scope: string;
      client_id: string;
      cnf?: { jkt: string };
    } = {
      iss: c.env.ISSUER_URL,
      sub: refreshTokenData.sub,
      aud: c.env.ISSUER_URL,
      scope: grantedScope,
      client_id: client_id,
    };

    // Add DPoP confirmation (cnf) claim if DPoP is used
    if (dpopJkt) {
      accessTokenClaims.cnf = { jkt: dpopJkt };
    }

    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
  } catch (err) {
    console.error('Failed to create access token:', err);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Generate new ID Token (optional for refresh flow, but included for consistency)
  let idToken: string;
  try {
    const atHash = await calculateAtHash(accessToken);
    const idTokenClaims = {
      iss: c.env.ISSUER_URL,
      sub: refreshTokenData.sub,
      aud: client_id,
      at_hash: atHash,
    };

    idToken = await createIDToken(idTokenClaims, privateKey, keyId, expiresIn);
  } catch (error) {
    console.error('Failed to create ID token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Implement refresh token rotation (security best practice)
  // Delete old refresh token and issue a new one
  await deleteRefreshToken(c.env, jti);

  let newRefreshToken: string;
  let newRefreshTokenJti: string;
  const refreshTokenExpiresIn = parseInt(c.env.REFRESH_TOKEN_EXPIRY, 10);

  try {
    const refreshTokenClaims = {
      iss: c.env.ISSUER_URL,
      sub: refreshTokenData.sub,
      aud: client_id,
      scope: grantedScope,
      client_id: client_id,
    };

    const result = await createRefreshToken(
      refreshTokenClaims,
      privateKey,
      keyId,
      refreshTokenExpiresIn
    );
    newRefreshToken = result.token;
    newRefreshTokenJti = result.jti;

    // Store new refresh token metadata
    await storeRefreshToken(c.env, newRefreshTokenJti, {
      jti: newRefreshTokenJti,
      client_id: client_id,
      sub: refreshTokenData.sub,
      scope: grantedScope,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + refreshTokenExpiresIn,
    });
  } catch (error) {
    console.error('Failed to create new refresh token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create refresh token',
      },
      500
    );
  }

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: tokenType, // 'Bearer' or 'DPoP' depending on DPoP usage
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: newRefreshToken,
    scope: grantedScope,
  });
}

/**
 * Verify PKCE code_verifier against code_challenge
 * https://tools.ietf.org/html/rfc7636#section-4.6
 *
 * @param codeVerifier - Code verifier from token request
 * @param codeChallenge - Code challenge from authorization request
 * @returns Promise<boolean> - True if verification succeeds
 */
async function verifyPKCE(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  // Validate code_verifier format (43-128 characters, unreserved characters per RFC 7636)
  // RFC 7636 Section 4.1: code_verifier = 43*128unreserved
  // unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
  const codeVerifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;
  if (!codeVerifierPattern.test(codeVerifier)) {
    return false;
  }

  // Hash code_verifier with SHA-256
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to base64url
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const base64 = btoa(String.fromCharCode(...hashArray));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Compare with code_challenge
  return base64url === codeChallenge;
}

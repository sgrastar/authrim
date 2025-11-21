import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  validateGrantType,
  validateAuthCode,
  validateClientId,
  validateRedirectUri,
} from '@authrim/shared';
import {
  revokeToken,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  getClient,
} from '@authrim/shared';
import {
  createIDToken,
  createAccessToken,
  calculateAtHash,
  createRefreshToken,
  parseToken,
  verifyToken,
} from '@authrim/shared';
import {
  encryptJWT,
  isIDTokenEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
  validateJWTBearerAssertion,
  parseTrustedIssuers,
  type JWEAlgorithm,
  type JWEEncryption,
  type IDTokenClaims,
} from '@authrim/shared';
import { importPKCS8, importJWK, type CryptoKey } from 'jose';
import { extractDPoPProof, validateDPoPProof } from '@authrim/shared';

/**
 * Response from AuthCodeStore Durable Object
 */
interface AuthCodeStoreResponse {
  userId: string;
  scope: string;
  redirectUri: string;
  nonce?: string;
  state?: string;
  createdAt?: number;
  claims?: string; // JSON string of claims parameter
  authTime?: number;
  acr?: string;
}

/**
 * Get signing key from KeyManager
 * If no active key exists, generates a new one
 */
async function getSigningKeyFromKeyManager(
  env: Env
): Promise<{ privateKey: CryptoKey; kid: string }> {
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  if (!env.KEY_MANAGER_SECRET) {
    throw new Error('KEY_MANAGER_SECRET not configured');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Authentication header for KeyManager
  const authHeaders = {
    'Authorization': `Bearer ${env.KEY_MANAGER_SECRET}`,
  };

  // Try to get active key (using internal endpoint that returns privatePEM)
  console.log('Fetching active key with auth:', { hasSecret: !!env.KEY_MANAGER_SECRET, secretLength: env.KEY_MANAGER_SECRET?.length });
  const activeResponse = await keyManager.fetch('http://dummy/internal/active-with-private', {
    method: 'GET',
    headers: authHeaders,
  });

  console.log('Active key response:', { status: activeResponse.status, ok: activeResponse.ok });

  let keyData: { kid: string; privatePEM: string };

  if (activeResponse.ok) {
    keyData = await activeResponse.json() as { kid: string; privatePEM: string };
    console.log('Got active key from KeyManager:', { kid: keyData.kid, hasPEM: !!keyData.privatePEM, pemLength: keyData.privatePEM?.length });
  } else {
    // No active key, generate and activate one
    console.log('No active signing key found, generating new key');
    console.log('Rotate request auth headers:', { hasAuth: !!authHeaders.Authorization, authLength: authHeaders.Authorization?.length });
    const rotateResponse = await keyManager.fetch('http://dummy/internal/rotate', {
      method: 'POST',
      headers: authHeaders,
    });

    if (!rotateResponse.ok) {
      const errorText = await rotateResponse.text();
      console.error('Failed to rotate key:', rotateResponse.status, errorText);
      throw new Error('Failed to generate signing key');
    }

    const rotateText = await rotateResponse.text();
    console.log('Received rotate response:', {
      textLength: rotateText.length,
      hasPrivatePEM: rotateText.includes('privatePEM'),
      textStart: rotateText.substring(0, 200)
    });

    const rotateData = JSON.parse(rotateText) as { success: boolean; key: { kid: string; privatePEM: string } };
    keyData = rotateData.key;
    console.log('Generated new key from KeyManager:', { kid: keyData.kid, hasPEM: !!keyData.privatePEM, pemLength: keyData.privatePEM?.length, pemStart: keyData.privatePEM?.substring(0, 50) });
  }

  // Import private key
  console.log('Attempting to import private key...');
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  return { privateKey, kid: keyData.kid };
}

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
  } else if (grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
    return await handleJWTBearerGrant(c, formData);
  } else if (grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
    return await handleDeviceCodeGrant(c, formData);
  } else if (grant_type === 'urn:openid:params:grant-type:ciba') {
    return await handleCIBAGrant(c, formData);
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
  const validCode: string = code;

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

  // Consume authorization code using AuthorizationCodeStore Durable Object
  // This replaces KV-based getAuthCode() with strong consistency guarantees
  const authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName('global');
  const authCodeStore = c.env.AUTH_CODE_STORE.get(authCodeStoreId);

  let authCodeData;
  try {
    const consumeResponse = await authCodeStore.fetch(
      new Request('https://auth-code-store/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: validCode,
          clientId: client_id,
          codeVerifier: code_verifier,
        }),
      })
    );

    if (!consumeResponse.ok) {
      const errorData = (await consumeResponse.json()) as {
        error: string;
        error_description: string;
      };

      return c.json(
        {
          error: errorData.error || 'invalid_grant',
          error_description:
            errorData.error_description || 'Authorization code is invalid or expired',
        },
        400
      );
    }

    // AuthCodeStore DO returns: { userId, scope, redirectUri, nonce?, state? }
    const consumedData = (await consumeResponse.json()) as AuthCodeStoreResponse;

    // Map AuthCodeStore DO response to expected format
    authCodeData = {
      sub: consumedData.userId, // Map userId to sub for JWT claims
      scope: consumedData.scope,
      redirect_uri: consumedData.redirectUri, // Keep for compatibility
      nonce: consumedData.nonce,
      state: consumedData.state,
      auth_time: consumedData.authTime || Math.floor(Date.now() / 1000), // OIDC Core: Time when End-User authentication occurred
      acr: consumedData.acr, // OIDC Core: Authentication Context Class Reference
      claims: consumedData.claims,
    };
  } catch (error) {
    console.error('AuthCodeStore DO error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to validate authorization code',
      },
      500
    );
  }

  // Verify redirect_uri matches (additional safety check)
  if (authCodeData.redirect_uri !== redirect_uri) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'redirect_uri does not match the one used in authorization request',
      },
      400
    );
  }

  // Load private key for signing tokens from KeyManager
  // NOTE: Key loading moved BEFORE code deletion to avoid losing code on key loading failure
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key from KeyManager:', error);
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
    // Validate DPoP proof (issue #12: DPoP JTI replay protection via DO)
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      c.req.url,
      undefined, // No access token yet (this is token issuance)
      c.env.DPOP_JTI_STORE, // DPoPJTIStore DO for atomic JTI replay protection
      client_id // Bind JTI to client_id for additional security
    );

    if (!dpopValidation.valid) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
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

  // Generate ID Token with at_hash and auth_time
  const idTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: authCodeData.sub,
    aud: client_id,
    nonce: authCodeData.nonce,
    at_hash: atHash, // OIDC spec requirement for code flow
    auth_time: authCodeData.auth_time, // OIDC Core Section 2: Time when End-User authentication occurred
    ...(authCodeData.acr && { acr: authCodeData.acr }),
  };

  let idToken: string;
  try {
    // For Authorization Code Flow, ID token should only contain standard claims
    // Scope-based claims (profile, email) are returned from UserInfo endpoint
    idToken = await createIDToken(idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>, privateKey, keyId, expiresIn);

    // JWE: Check if client requires ID token encryption (RFC 7516)
    const clientMetadata = await getClient(c.env, client_id);
    if (clientMetadata && isIDTokenEncryptionRequired(clientMetadata)) {
      const alg = clientMetadata.id_token_encrypted_response_alg as string;
      const enc = clientMetadata.id_token_encrypted_response_enc as string;

      // Validate encryption algorithms
      try {
        validateJWEOptions(alg, enc);
      } catch (validationError) {
        console.error('Invalid JWE options:', validationError);
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description: `Client encryption configuration is invalid: ${validationError instanceof Error ? validationError.message : 'Unknown error'}`,
          },
          400
        );
      }

      // Get client's public key for encryption
      const publicKey = await getClientPublicKey(clientMetadata);
      if (!publicKey) {
        console.error('Client requires encryption but no public key available');
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description: 'Client requires ID token encryption but no public key (jwks or jwks_uri) is configured',
          },
          400
        );
      }

      // Encrypt the signed ID token (nested JWT: JWS inside JWE)
      try {
        idToken = await encryptJWT(idToken, publicKey, {
          alg: alg as JWEAlgorithm,
          enc: enc as JWEEncryption,
          cty: 'JWT', // Content type is JWT (the signed ID token)
          kid: publicKey.kid,
        });
      } catch (encryptError) {
        console.error('Failed to encrypt ID token:', encryptError);
        return c.json(
          {
            error: 'server_error',
            error_description: 'Failed to encrypt ID token',
          },
          500
        );
      }
    }
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

  // Authorization code has been consumed and marked as used by AuthCodeStore DO
  // Per RFC 6749 Section 4.1.2: Authorization codes are single-use
  // The DO guarantees atomic consumption and replay attack detection

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
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_client',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Fetch client metadata to verify client_secret (for confidential clients)
  const clientMetadata = await getClient(c.env, client_id);
  if (!clientMetadata) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      400
    );
  }

  // Verify client_secret for confidential clients
  // Public clients (e.g., SPAs, mobile apps) don't have a client_secret
  if (clientMetadata.client_secret) {
    if (!client_secret || client_secret !== clientMetadata.client_secret) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        },
        401
      );
    }
  }

  // Parse refresh token to get JTI (without verification yet)
  let refreshTokenPayload;
  try {
    refreshTokenPayload = parseToken(refreshTokenValue);
  } catch {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token missing JTI',
      },
      400
    );
  }

  // Retrieve refresh token metadata from RefreshTokenRotator DO
  const refreshTokenData = await getRefreshToken(c.env, jti, client_id);
  if (!refreshTokenData) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token was issued to a different client',
      },
      400
    );
  }

  // Load public key for verification
  // Decode JWT header to get kid (Key ID)
  let publicKey: CryptoKey | null = null;
  try {
    const parts = refreshTokenValue.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const headerBase64url = parts[0];
    const headerBase64 = headerBase64url.replace(/-/g, '+').replace(/_/g, '/');
    const headerJson = JSON.parse(atob(headerBase64)) as { kid?: string; alg?: string };
    const kid = headerJson.kid;

    // Fetch JWKS from KeyManager DO
    if (!c.env.KEY_MANAGER) {
      console.error('KEY_MANAGER binding not available');
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'server_error',
          error_description: 'KeyManager not configured',
        },
        500
      );
    }

    const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);
    const jwksResponse = await keyManager.fetch('http://internal/jwks', { method: 'GET' });

    if (!jwksResponse.ok) {
      console.error('Failed to fetch JWKS from KeyManager:', jwksResponse.status);
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to fetch verification keys',
        },
        500
      );
    }

    const jwks = (await jwksResponse.json()) as { keys: Array<{ kid?: string; [key: string]: unknown }> };
    // Find key by kid
    const jwk = kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0];

    if (!jwk) {
      console.error(`No matching public key found for kid: ${kid}`);
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'server_error',
          error_description: 'Verification key not found',
        },
        500
      );
    }

    publicKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
  } catch (err) {
    console.error('Failed to import public key:', err);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
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
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
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

  // Load private key for signing new tokens from KeyManager
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key from KeyManager:', error);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
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
    // Validate DPoP proof (issue #12: DPoP JTI replay protection via DO)
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      c.req.url,
      undefined, // No access token yet (this is token refresh)
      c.env.DPOP_JTI_STORE, // DPoPJTIStore DO for atomic JTI replay protection
      client_id // Bind JTI to client_id for additional security
    );

    if (!dpopValidation.valid) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Implement refresh token rotation using RefreshTokenRotator DO
  // This provides atomic rotation with theft detection
  if (!c.env.REFRESH_TOKEN_ROTATOR) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Refresh token rotation unavailable',
      },
      500
    );
  }

  const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(client_id);
  const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

  let newRefreshToken: string;
  let newRefreshTokenJti: string;
  const refreshTokenExpiresIn = parseInt(c.env.REFRESH_TOKEN_EXPIRY, 10);

  try {
    // Call RefreshTokenRotator DO to atomically rotate the token
    const rotateResponse = await rotator.fetch('http://internal/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentToken: jti,
        userId: refreshTokenData.sub,
        clientId: client_id,
      }),
    });

    if (!rotateResponse.ok) {
      const error = (await rotateResponse.json()) as {
        error?: string;
        error_description?: string;
      };
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: error.error || 'invalid_grant',
          error_description: error.error_description || 'Token rotation failed',
        },
        400
      );
    }

    const rotateResult = (await rotateResponse.json()) as {
      newToken: string;
    };
    newRefreshTokenJti = rotateResult.newToken;

    // Create JWT using the new JTI from RefreshTokenRotator
    const refreshTokenClaims = {
      iss: c.env.ISSUER_URL,
      sub: refreshTokenData.sub,
      aud: client_id,
      scope: grantedScope,
      client_id: client_id,
    };

    // Pass the JTI from RefreshTokenRotator to ensure consistency
    const result = await createRefreshToken(
      refreshTokenClaims,
      privateKey,
      keyId,
      refreshTokenExpiresIn,
      newRefreshTokenJti // Use the JTI from RefreshTokenRotator DO
    );
    newRefreshToken = result.token;
  } catch (error) {
    console.error('Failed to rotate refresh token:', error);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to rotate refresh token',
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

/**
 * Handle JWT Bearer Grant (RFC 7523)
 * https://datatracker.ietf.org/doc/html/rfc7523
 *
 * Service-to-service authentication using JWT assertions
 */
async function handleJWTBearerGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const assertion = formData.assertion;
  const scope = formData.scope;

  // Validate assertion parameter
  if (!assertion) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing required parameter: assertion',
      },
      400
    );
  }

  // Parse trusted issuers from environment
  const trustedIssuers = parseTrustedIssuers(c.env.TRUSTED_JWT_ISSUERS);

  if (trustedIssuers.size === 0) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'JWT Bearer grant is not configured (no trusted issuers)',
      },
      500
    );
  }

  // Validate JWT assertion
  const validation = await validateJWTBearerAssertion(
    assertion,
    c.env.ISSUER_URL,
    trustedIssuers
  );

  if (!validation.valid || !validation.claims) {
    return c.json(
      {
        error: validation.error || 'invalid_grant',
        error_description: validation.error_description || 'JWT assertion validation failed',
      },
      400
    );
  }

  const claims = validation.claims;

  // Determine scope: use requested scope or scope from assertion
  let grantedScope = scope || claims.scope || 'openid';

  // Validate scope against allowed scopes for the issuer
  const trustedIssuer = trustedIssuers.get(claims.iss);
  if (trustedIssuer?.allowed_scopes) {
    const requestedScopes = grantedScope.split(' ');
    const hasDisallowedScope = requestedScopes.some(
      (s) => !trustedIssuer.allowed_scopes?.includes(s)
    );

    if (hasDisallowedScope) {
      return c.json(
        {
          error: 'invalid_scope',
          error_description: 'Requested scope is not allowed for this issuer',
        },
        400
      );
    }
  }

  // Load private key for signing tokens from KeyManager
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key from KeyManager:', error);
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

  // Generate Access Token
  // For JWT Bearer flow, the subject (sub) comes from the assertion
  const accessTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: claims.sub, // Subject from JWT assertion
    aud: c.env.ISSUER_URL,
    scope: grantedScope,
    client_id: claims.iss, // Issuer acts as client_id for service accounts
  };

  let accessToken: string;
  try {
    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
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

  // JWT Bearer flow typically does NOT issue ID tokens or refresh tokens
  // It's for service-to-service authentication, not user authentication
  // Only access token is returned

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: grantedScope,
  });
}

/**
 * Handle Device Code Grant
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.4
 */
async function handleDeviceCodeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const deviceCode = formData.device_code;
  const client_id = formData.client_id;

  // Validate required parameters
  if (!deviceCode) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'device_code is required',
      },
      400
    );
  }

  if (!client_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'client_id is required',
      },
      400
    );
  }

  // Get device code metadata from DeviceCodeStore
  const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName('global');
  const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

  // Update poll time (for rate limiting)
  try {
    await deviceCodeStore.fetch(
      new Request('https://internal/update-poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      })
    );
  } catch (error) {
    console.error('Failed to update poll time:', error);
  }

  // Get device code metadata
  const getResponse = await deviceCodeStore.fetch(
    new Request('https://internal/get-by-device-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    })
  );

  const metadata = (await getResponse.json()) as {
    device_code: string;
    user_code: string;
    client_id: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    sub?: string;
    user_id?: string;
    last_poll_at?: number;
    poll_count?: number;
    created_at: number;
    expires_at: number;
  };

  if (!metadata || !metadata.device_code) {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'Device code has expired or is invalid',
      },
      400
    );
  }

  // Check if device code is for the correct client
  if (metadata.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Device code does not belong to this client',
      },
      400
    );
  }

  // Check status and return appropriate response
  if (metadata.status === 'pending') {
    // User has not yet approved - check if polling too fast
    const { isPollingTooFast, DEVICE_FLOW_CONSTANTS } = await import('@authrim/shared');

    if (isPollingTooFast(metadata, DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL)) {
      return c.json(
        {
          error: 'slow_down',
          error_description: 'You are polling too frequently. Please slow down.',
        },
        400
      );
    }

    return c.json(
      {
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the device',
      },
      400
    );
  }

  if (metadata.status === 'denied') {
    // Delete the device code (it's been denied)
    await deviceCodeStore.fetch(
      new Request('https://internal/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      })
    );

    return c.json(
      {
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      },
      403
    );
  }

  if (metadata.status === 'expired') {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'Device code has expired',
      },
      400
    );
  }

  // Status is 'approved' - issue tokens
  if (metadata.status !== 'approved' || !metadata.sub) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Device code is not approved',
      },
      400
    );
  }

  // Delete the device code (one-time use)
  await deviceCodeStore.fetch(
    new Request('https://internal/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    })
  );

  // Get private key for signing tokens
  let privateKey: CryptoKey;
  let keyId: string;
  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing keys',
      },
      500
    );
  }

  const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);

  // Generate ID Token
  const idTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub,
    aud: client_id,
    nonce: undefined, // Device flow doesn't use nonce
    auth_time: Math.floor(Date.now() / 1000),
  };

  let idToken: string;
  try {
    idToken = await createIDToken(
      idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
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

  // Generate Access Token
  const accessTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub,
    aud: c.env.ISSUER_URL,
    scope: metadata.scope,
    client_id,
  };

  let accessToken: string;
  try {
    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
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

  // Generate Refresh Token
  const refreshTokenExpiry = parseInt(c.env.REFRESH_TOKEN_EXPIRY, 10);
  let refreshToken: string;
  let refreshJti: string;
  try {
    const refreshTokenClaims = {
      sub: metadata.sub!,
      scope: metadata.scope,
      client_id,
    };
    const result = await createRefreshToken(refreshTokenClaims, privateKey, keyId, refreshTokenExpiry);
    refreshToken = result.token;
    refreshJti = result.jti;

    await storeRefreshToken(c.env, refreshJti, {
      jti: refreshJti,
      client_id,
      sub: metadata.sub!,
      scope: metadata.scope,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + refreshTokenExpiry,
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

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: metadata.scope,
  });
}

/**
 * Handle CIBA Grant
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html#token_endpoint
 */
async function handleCIBAGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const authReqId = formData.auth_req_id;
  const client_id = formData.client_id;

  // Validate required parameters
  if (!authReqId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'auth_req_id is required',
      },
      400
    );
  }

  if (!client_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'client_id is required',
      },
      400
    );
  }

  // Get CIBA request metadata from CIBARequestStore
  const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName('global');
  const cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);

  // Update poll time (for rate limiting in poll mode)
  try {
    await cibaRequestStore.fetch(
      new Request('https://internal/update-poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );
  } catch (error) {
    console.error('Failed to update poll time:', error);
  }

  // Get CIBA request metadata
  const getResponse = await cibaRequestStore.fetch(
    new Request('https://internal/get-by-auth-req-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  const metadata = (await getResponse.json()) as {
    auth_req_id: string;
    client_id: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    delivery_mode: 'poll' | 'ping' | 'push';
    interval: number;
    sub?: string;
    user_id?: string;
    nonce?: string;
    last_poll_at?: number;
    poll_count?: number;
    created_at: number;
    expires_at: number;
    token_issued?: boolean;
  };

  if (!metadata || !metadata.auth_req_id) {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'CIBA request has expired or is invalid',
      },
      400
    );
  }

  // Check if auth_req_id is for the correct client
  if (metadata.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'auth_req_id does not belong to this client',
      },
      400
    );
  }

  // Check if tokens have already been issued (one-time use)
  if (metadata.token_issued) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Tokens have already been issued for this auth_req_id',
      },
      400
    );
  }

  // Check status and return appropriate response
  if (metadata.status === 'pending') {
    // User has not yet approved - check if polling too fast (poll mode only)
    if (metadata.delivery_mode === 'poll') {
      const { isPollingTooFast } = await import('@authrim/shared');

      if (isPollingTooFast(metadata)) {
        return c.json(
          {
            error: 'slow_down',
            error_description: 'You are polling too frequently. Please slow down.',
          },
          400
        );
      }
    }

    return c.json(
      {
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the authentication request',
      },
      400
    );
  }

  if (metadata.status === 'denied') {
    // Delete the CIBA request (it's been denied)
    await cibaRequestStore.fetch(
      new Request('https://internal/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );

    return c.json(
      {
        error: 'access_denied',
        error_description: 'User denied the authentication request',
      },
      403
    );
  }

  if (metadata.status === 'expired') {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'CIBA request has expired',
      },
      400
    );
  }

  // Status is 'approved' - issue tokens
  if (metadata.status !== 'approved' || !metadata.sub) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'CIBA request is not approved',
      },
      400
    );
  }

  // Mark tokens as issued (one-time use enforcement)
  const markIssuedResponse = await cibaRequestStore.fetch(
    new Request('https://internal/mark-token-issued', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  if (!markIssuedResponse.ok) {
    const error = await markIssuedResponse.json();
    console.error('Failed to mark tokens as issued:', error);
    // If tokens were already issued, return error
    if (error.error_description?.includes('already issued')) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Tokens have already been issued for this auth_req_id',
        },
        400
      );
    }
  }

  // Get user data for token claims
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(metadata.user_id)
    .first();

  if (!user) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'User not found',
      },
      500
    );
  }

  // Get client metadata for encryption settings
  const clientMetadata = await getClient(c.env, metadata.client_id);

  if (!clientMetadata) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      400
    );
  }

  // Get signing key from KeyManager
  const { privateKey, kid } = await getSigningKeyFromKeyManager(c.env);

  // Extract DPoP proof if present
  const dpopProof = extractDPoPProof(c.req.raw);
  let dpopJkt: string | undefined;

  // Validate DPoP proof if provided
  if (dpopProof) {
    const { validateDPoPProof: validateDPoP } = await import('@authrim/shared');
    const dpopValidation = await validateDPoP(
      dpopProof,
      'POST',
      c.env.ISSUER_URL + '/token',
      c.env
    );

    if (dpopValidation.valid && dpopValidation.jkt) {
      dpopJkt = dpopValidation.jkt;
    }
  }

  // Token expiration times
  const expiresIn = parseInt(c.env.TOKEN_EXPIRY || '3600', 10);
  const refreshExpiresIn = parseInt(c.env.REFRESH_TOKEN_EXPIRY || '2592000', 10);

  // Create ID Token
  let idToken = await createIDToken(
    c.env.ISSUER_URL,
    metadata.sub,
    metadata.client_id,
    privateKey,
    kid,
    metadata.nonce,
    expiresIn,
    undefined, // at_hash will be calculated after access token creation
    undefined // auth_time
  );

  // Create Access Token
  const accessToken = await createAccessToken(
    c.env.ISSUER_URL,
    metadata.sub,
    metadata.client_id,
    privateKey,
    kid,
    expiresIn,
    metadata.scope,
    dpopJkt
  );

  // Calculate at_hash for ID token
  const atHash = await calculateAtHash(accessToken);

  // Recreate ID token with at_hash
  idToken = await createIDToken(
    c.env.ISSUER_URL,
    metadata.sub,
    metadata.client_id,
    privateKey,
    kid,
    metadata.nonce,
    expiresIn,
    atHash,
    undefined // auth_time
  );

  // Encrypt ID token if required
  if (isIDTokenEncryptionRequired(clientMetadata)) {
    const clientPublicKey = await getClientPublicKey(clientMetadata);

    if (!clientPublicKey) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Client encryption key not available',
        },
        500
      );
    }

    const alg = clientMetadata.id_token_encrypted_response_alg as JWEAlgorithm;
    const enc = clientMetadata.id_token_encrypted_response_enc as JWEEncryption;

    if (!validateJWEOptions(alg, enc)) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Invalid JWE algorithm or encryption method',
        },
        500
      );
    }

    idToken = await encryptJWT(idToken, clientPublicKey, alg, enc);
  }

  // Create Refresh Token
  const refreshToken = await createRefreshToken(
    metadata.client_id,
    metadata.sub,
    metadata.scope,
    privateKey,
    kid,
    refreshExpiresIn
  );

  // Store refresh token in KV
  await storeRefreshToken(c.env, refreshToken, {
    client_id: metadata.client_id,
    sub: metadata.sub,
    scope: metadata.scope,
    iat: Date.now() / 1000,
    exp: Date.now() / 1000 + refreshExpiresIn,
  });

  // Delete the CIBA request after successful token issuance
  await cibaRequestStore.fetch(
    new Request('https://internal/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: dpopJkt ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: metadata.scope,
  });
}

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  introspectTokenFromContext,
  getClient,
  encryptJWT,
  isUserInfoEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
  type JWEAlgorithm,
  type JWEEncryption,
} from '@authrim/shared';
import { SignJWT } from 'jose';

/**
 * UserInfo Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#UserInfo
 *
 * Returns claims about the authenticated user
 */
export async function userinfoHandler(c: Context<{ Bindings: Env }>) {
  // Perform comprehensive token validation (including DPoP if present)
  const introspection = await introspectTokenFromContext(c);

  if (!introspection.valid) {
    // Token validation failed - return error
    // Type narrowing: when valid is false, error is guaranteed to be present
    if (!introspection.error) {
      return c.json({ error: 'server_error', error_description: 'Unknown error' }, 500);
    }
    const error = introspection.error;
    c.header('WWW-Authenticate', error.wwwAuthenticate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(
      {
        error: error.error,
        error_description: error.error_description,
      },
      error.statusCode as any
    );
  }

  // Token is valid - extract claims
  // Type narrowing: when valid is true, claims is guaranteed to be present
  if (!introspection.claims) {
    return c.json({ error: 'server_error', error_description: 'Missing claims' }, 500);
  }
  const tokenClaims = introspection.claims;
  const sub = tokenClaims.sub as string;
  const scope = (tokenClaims.scope as string) || '';
  const claimsParam = (tokenClaims.claims as string) || undefined;

  if (!sub) {
    return c.json(
      {
        error: 'invalid_token',
        error_description: 'Token does not contain subject claim',
      },
      401
    );
  }

  // Parse claims parameter if present
  let requestedUserinfoClaims: Record<
    string,
    { essential?: boolean; value?: unknown; values?: unknown[] } | null
  > = {};
  if (claimsParam) {
    try {
      const parsedClaims: unknown = JSON.parse(claimsParam);
      if (typeof parsedClaims === 'object' && parsedClaims !== null && 'userinfo' in parsedClaims) {
        const claimsObj = parsedClaims as { userinfo?: unknown };
        if (claimsObj.userinfo && typeof claimsObj.userinfo === 'object') {
          requestedUserinfoClaims = claimsObj.userinfo as Record<
            string,
            { essential?: boolean; value?: unknown; values?: unknown[] } | null
          >;
        }
      }
    } catch (error) {
      console.error('Failed to parse claims parameter:', error);
      // Continue without claims parameter if parsing fails
    }
  }

  // Build user claims based on scope
  const scopes = scope.split(' ');
  const userClaims: Record<string, unknown> = {
    sub,
  };

  // Fetch user data from D1 database
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(sub).first();

  if (!user) {
    return c.json(
      {
        error: 'invalid_token',
        error_description: 'User not found',
      },
      401
    );
  }

  // Parse address JSON if present
  let address = null;
  if (user.address_json) {
    try {
      address = JSON.parse(user.address_json as string);
    } catch (error) {
      console.error('Failed to parse address JSON:', error);
    }
  }

  // Map D1 user record to OIDC userinfo claims
  const userData = {
    name: user.name || undefined,
    family_name: user.family_name || undefined,
    given_name: user.given_name || undefined,
    middle_name: user.middle_name || undefined,
    nickname: user.nickname || undefined,
    preferred_username: user.preferred_username || undefined,
    profile: user.profile || undefined,
    picture: user.picture || undefined,
    website: user.website || undefined,
    gender: user.gender || undefined,
    birthdate: user.birthdate || undefined,
    zoneinfo: user.zoneinfo || undefined,
    locale: user.locale || undefined,
    updated_at: user.updated_at ? (user.updated_at as number) : Math.floor(Date.now() / 1000),
    email: user.email || undefined,
    email_verified: user.email_verified === 1,
    phone_number: user.phone_number || undefined,
    phone_number_verified: user.phone_number_verified === 1,
    address: address || undefined,
  };

  // Get client metadata to check claims parameter settings
  // Extract client_id from token claims
  const client_id = tokenClaims.client_id as string;
  const clientMetadata = client_id ? await getClient(c.env, client_id) : null;

  // Check if client allows claims parameter to request claims without corresponding scope
  // Default: false (strict scope-based access control)
  // OIDC conformance tests: true (flexible claims parameter handling)
  const allowClaimsWithoutScope = clientMetadata?.allow_claims_without_scope === true;

  // Profile scope claims (OIDC Core 5.4)
  const profileClaims = [
    'name',
    'family_name',
    'given_name',
    'middle_name',
    'nickname',
    'preferred_username',
    'profile',
    'picture',
    'website',
    'gender',
    'birthdate',
    'zoneinfo',
    'locale',
    'updated_at',
  ];

  // Add profile claims if profile scope is granted OR if explicitly requested (when allowed)
  if (scopes.includes('profile')) {
    // Include all profile claims when profile scope is granted
    for (const claim of profileClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else if (allowClaimsWithoutScope) {
    // Include individual profile claims if explicitly requested via claims parameter
    // (only when client allows claims without scope)
    for (const claim of profileClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }
  // else: Strict mode - do not return profile claims without profile scope

  // Email scope claims
  const emailClaims = ['email', 'email_verified'];

  // Add email claims if email scope is granted OR if explicitly requested (when allowed)
  if (scopes.includes('email')) {
    // Include all email claims when email scope is granted
    for (const claim of emailClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else if (allowClaimsWithoutScope) {
    // Include individual email claims if explicitly requested via claims parameter
    // (only when client allows claims without scope)
    for (const claim of emailClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }
  // else: Strict mode - do not return email claims without email scope

  // Address scope claims (OIDC Core 5.4)
  if (scopes.includes('address')) {
    userClaims.address = userData.address;
  } else if (allowClaimsWithoutScope && 'address' in requestedUserinfoClaims) {
    // Include address if explicitly requested via claims parameter (only when allowed)
    userClaims.address = userData.address;
  }
  // else: Strict mode - do not return address without address scope

  // Phone scope claims (OIDC Core 5.4)
  const phoneClaims = ['phone_number', 'phone_number_verified'];

  // Add phone claims if phone scope is granted OR if explicitly requested (when allowed)
  if (scopes.includes('phone')) {
    // Include all phone claims when phone scope is granted
    for (const claim of phoneClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else if (allowClaimsWithoutScope) {
    // Include individual phone claims if explicitly requested via claims parameter
    // (only when client allows claims without scope)
    for (const claim of phoneClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }
  // else: Strict mode - do not return phone claims without phone scope

  // JWE: Check if client requires UserInfo encryption (RFC 7516)
  if (!client_id || !clientMetadata) {
    // If no client_id in token or metadata not found, return unencrypted response
    return c.json(userClaims);
  }

  // Check if client requires UserInfo encryption
  if (isUserInfoEncryptionRequired(clientMetadata)) {
    const alg = clientMetadata.userinfo_encrypted_response_alg as string;
    const enc = clientMetadata.userinfo_encrypted_response_enc as string;

    // Validate encryption algorithms
    try {
      validateJWEOptions(alg, enc);
    } catch (validationError) {
      console.error('Invalid JWE options for UserInfo:', validationError);
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
      console.error('Client requires UserInfo encryption but no public key available');
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description:
            'Client requires UserInfo encryption but no public key (jwks or jwks_uri) is configured',
        },
        400
      );
    }

    // For UserInfo encryption, we need to sign the claims first (JWT), then encrypt (JWE)
    // This creates a nested JWT: JWS inside JWE
    try {
      // Get signing key from KeyManager
      const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
      const keyManager = c.env.KEY_MANAGER.get(keyManagerId);
      const authHeaders = {
        Authorization: `Bearer ${c.env.KEY_MANAGER_SECRET}`,
      };

      const keyResponse = await keyManager.fetch(
        'http://key-manager/internal/active-with-private',
        {
          method: 'GET',
          headers: authHeaders,
        }
      );

      if (!keyResponse.ok) {
        console.error('Failed to fetch signing key from KeyManager:', keyResponse.status);
        return c.json(
          {
            error: 'server_error',
            error_description: 'Server configuration error',
          },
          500
        );
      }

      const keyData = await keyResponse.json<{
        kid: string;
        privatePEM: string;
      }>();

      if (!keyData.privatePEM) {
        console.error('Private key not available from KeyManager');
        return c.json(
          {
            error: 'server_error',
            error_description: 'Server configuration error',
          },
          500
        );
      }

      // Import private key for signing
      const { importPKCS8 } = await import('jose');
      const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

      // Sign UserInfo claims as JWT
      const signedUserInfo = await new SignJWT(userClaims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: keyData.kid })
        .setIssuedAt()
        .setIssuer(c.env.ISSUER_URL)
        .setAudience(client_id)
        .sign(privateKey);

      // Encrypt the signed JWT
      const encryptedUserInfo = await encryptJWT(signedUserInfo, publicKey, {
        alg: alg as JWEAlgorithm,
        enc: enc as JWEEncryption,
        cty: 'JWT', // Content type is JWT
        kid: publicKey.kid,
      });

      // Return encrypted UserInfo as JWT (not JSON)
      // OIDC Core 5.3.4: The response MUST be a JWT
      c.header('Content-Type', 'application/jwt');
      return c.body(encryptedUserInfo);
    } catch (encryptError) {
      console.error('Failed to encrypt UserInfo response:', encryptError);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to encrypt UserInfo response',
        },
        500
      );
    }
  }

  // No encryption required, return JSON response
  return c.json(userClaims);
}

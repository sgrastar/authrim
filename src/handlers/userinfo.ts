import type { Context } from 'hono';
import type { Env } from '../types/env';
import { introspectTokenFromContext } from '../utils/token-introspection';

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
    return c.json(
      {
        error: error.error,
        error_description: error.error_description,
      },
      error.statusCode as 401 | 500
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

  // Static user data for MVP
  // In production, fetch from user database based on sub
  const userData = {
    name: 'Test User',
    family_name: 'User',
    given_name: 'Test',
    middle_name: 'Demo',
    nickname: 'Tester',
    preferred_username: 'testuser',
    profile: 'https://example.com/testuser',
    picture: 'https://example.com/testuser/avatar.jpg',
    website: 'https://example.com',
    gender: 'unknown',
    birthdate: '1990-01-01',
    zoneinfo: 'Asia/Tokyo',
    locale: 'en-US',
    updated_at: Math.floor(Date.now() / 1000),
    email: 'test@example.com',
    email_verified: true,
    phone_number: '+81 90-1234-5678',
    phone_number_verified: true,
    address: {
      formatted: '1-2-3 Shibuya, Shibuya-ku, Tokyo 150-0002, Japan',
      street_address: '1-2-3 Shibuya',
      locality: 'Shibuya-ku',
      region: 'Tokyo',
      postal_code: '150-0002',
      country: 'Japan',
    },
  };

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

  // Add profile claims if profile scope is granted OR if explicitly requested
  if (scopes.includes('profile')) {
    // Include all profile claims when profile scope is granted
    for (const claim of profileClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else {
    // Include individual profile claims if explicitly requested via claims parameter
    for (const claim of profileClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }

  // Email scope claims
  const emailClaims = ['email', 'email_verified'];

  // Add email claims if email scope is granted OR if explicitly requested
  if (scopes.includes('email')) {
    // Include all email claims when email scope is granted
    for (const claim of emailClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else {
    // Include individual email claims if explicitly requested via claims parameter
    for (const claim of emailClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }

  // Address scope claims (OIDC Core 5.4)
  if (scopes.includes('address')) {
    userClaims.address = userData.address;
  } else if ('address' in requestedUserinfoClaims) {
    userClaims.address = userData.address;
  }

  // Phone scope claims (OIDC Core 5.4)
  const phoneClaims = ['phone_number', 'phone_number_verified'];

  // Add phone claims if phone scope is granted OR if explicitly requested
  if (scopes.includes('phone')) {
    // Include all phone claims when phone scope is granted
    for (const claim of phoneClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else {
    // Include individual phone claims if explicitly requested via claims parameter
    for (const claim of phoneClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }

  return c.json(userClaims);
}

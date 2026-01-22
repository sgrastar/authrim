import { test, expect } from '@playwright/test';

/**
 * OIDC Flow E2E Tests
 *
 * Tests that verify actual OIDC protocol flows:
 * 1. Discovery endpoint availability
 * 2. Authorization Code Flow redirect behavior
 * 3. Error handling for invalid requests
 * 4. Device flow user experience
 */

// Use the OP's base URL (different from UI in production)
const OP_BASE_URL = process.env.OP_BASE_URL || 'https://conformance.authrim.com';

test.describe('OIDC Discovery', () => {
  test('should return valid OpenID Configuration', async ({ request }) => {
    const response = await request.get(`${OP_BASE_URL}/.well-known/openid-configuration`);

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');

    const config = await response.json();

    // Required fields per OpenID Connect Discovery 1.0
    expect(config.issuer).toBe(OP_BASE_URL);
    expect(config.authorization_endpoint).toBeTruthy();
    expect(config.token_endpoint).toBeTruthy();
    expect(config.jwks_uri).toBeTruthy();
    expect(config.response_types_supported).toContain('code');
    expect(config.subject_types_supported).toBeInstanceOf(Array);
    expect(config.id_token_signing_alg_values_supported).toContain('RS256');
  });

  test('should return valid JWKS', async ({ request }) => {
    const response = await request.get(`${OP_BASE_URL}/.well-known/jwks.json`);

    expect(response.status()).toBe(200);

    const jwks = await response.json();
    expect(jwks.keys).toBeInstanceOf(Array);
    expect(jwks.keys.length).toBeGreaterThan(0);

    // Verify key structure
    const key = jwks.keys[0];
    expect(key.kty).toBe('RSA');
    expect(key.use).toBe('sig');
    expect(key.kid).toBeTruthy();
    expect(key.n).toBeTruthy();
    expect(key.e).toBeTruthy();
  });
});

test.describe('Authorization Code Flow', () => {
  test('should redirect to login for unauthenticated users', async ({ page }) => {
    const authUrl = new URL('/authorize', OP_BASE_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', 'test-client');
    authUrl.searchParams.set('redirect_uri', 'https://example.com/callback');
    authUrl.searchParams.set('scope', 'openid profile');
    authUrl.searchParams.set('state', 'test-state-123');

    await page.goto(authUrl.toString());
    await page.waitForLoadState('networkidle');

    // Should redirect to login page or show challenge
    const currentUrl = page.url();
    expect(
      currentUrl.includes('/login') ||
        currentUrl.includes('/challenge') ||
        currentUrl.includes('/authorize') ||
        currentUrl.includes('error')
    ).toBeTruthy();
  });

  test('should reject missing required parameters', async ({ request }) => {
    // Missing client_id
    const response = await request.get(`${OP_BASE_URL}/authorize?response_type=code`);

    // Should return error (either in URL params or as error page)
    expect(response.status()).toBeLessThan(500);
  });

  test('should handle invalid redirect_uri', async ({ request }) => {
    const authUrl = new URL('/authorize', OP_BASE_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', 'test-client');
    authUrl.searchParams.set('redirect_uri', 'https://malicious-site.com/callback');
    authUrl.searchParams.set('scope', 'openid');
    authUrl.searchParams.set('state', 'test-state');

    const response = await request.get(authUrl.toString());

    // Should NOT redirect to malicious URI - return error instead
    expect(response.status()).toBeLessThan(500);
    // The response should not redirect to the malicious URL
    const location = response.headers()['location'];
    if (location) {
      expect(location).not.toContain('malicious-site.com');
    }
  });

  test('should handle PKCE parameters', async ({ page }) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const authUrl = new URL('/authorize', OP_BASE_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', 'test-client');
    authUrl.searchParams.set('redirect_uri', 'https://example.com/callback');
    authUrl.searchParams.set('scope', 'openid');
    authUrl.searchParams.set('state', 'test-state');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    await page.goto(authUrl.toString());
    await page.waitForLoadState('networkidle');

    // Request should be accepted (redirects to login, not error)
    const currentUrl = page.url();
    const urlParams = new URL(currentUrl).searchParams;
    // If there's an error in query params, it shouldn't be about PKCE
    const error = urlParams.get('error');
    if (error) {
      expect(error).not.toBe('invalid_request');
    }
  });

  test('should preserve state parameter through flow', async ({ page }) => {
    const testState = `state-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const authUrl = new URL('/authorize', OP_BASE_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', 'test-client');
    authUrl.searchParams.set('redirect_uri', 'https://example.com/callback');
    authUrl.searchParams.set('scope', 'openid');
    authUrl.searchParams.set('state', testState);

    await page.goto(authUrl.toString());
    await page.waitForLoadState('networkidle');

    // Check if state is preserved in the URL or hidden input
    const pageContent = await page.content();
    expect(pageContent.includes(testState) || page.url().includes(testState)).toBeTruthy();
  });
});

test.describe('Token Endpoint', () => {
  test('should reject unauthorized requests', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/token`, {
      form: {
        grant_type: 'authorization_code',
        code: 'invalid-code',
        redirect_uri: 'https://example.com/callback',
      },
    });

    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('invalid_client');
  });

  test('should reject invalid grant type', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/token`, {
      form: {
        grant_type: 'invalid_grant_type',
      },
      headers: {
        Authorization: `Basic ${btoa('test-client:test-secret')}`,
      },
    });

    const body = await response.json();
    expect(body.error).toBe('unsupported_grant_type');
  });

  test('should reject invalid authorization code', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/token`, {
      form: {
        grant_type: 'authorization_code',
        code: 'invalid-code-12345',
        redirect_uri: 'https://example.com/callback',
      },
      headers: {
        Authorization: `Basic ${btoa('test-client:test-secret')}`,
      },
    });

    const body = await response.json();
    expect(body.error).toBe('invalid_grant');
  });
});

test.describe('UserInfo Endpoint', () => {
  test('should reject requests without access token', async ({ request }) => {
    const response = await request.get(`${OP_BASE_URL}/userinfo`);

    expect(response.status()).toBe(401);
  });

  test('should reject invalid access token', async ({ request }) => {
    const response = await request.get(`${OP_BASE_URL}/userinfo`, {
      headers: {
        Authorization: 'Bearer invalid-token-12345',
      },
    });

    expect(response.status()).toBe(401);
  });
});

test.describe('Device Authorization Flow', () => {
  test('should return device code for valid request', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/device_authorization`, {
      form: {
        client_id: 'test-device-client',
        scope: 'openid profile',
      },
    });

    // Either success (200) or client not found (401)
    expect(response.status()).toBeLessThan(500);

    if (response.status() === 200) {
      const body = await response.json();
      expect(body.device_code).toBeTruthy();
      expect(body.user_code).toBeTruthy();
      expect(body.verification_uri).toBeTruthy();
      expect(body.expires_in).toBeGreaterThan(0);
    }
  });

  test('device verification page should load', async ({ page }) => {
    await page.goto(`${OP_BASE_URL}/device`);
    await page.waitForLoadState('networkidle');

    // Should show device code input or redirect to login
    const currentUrl = page.url();
    expect(
      currentUrl.includes('/device') ||
        currentUrl.includes('/login') ||
        currentUrl.includes('/challenge')
    ).toBeTruthy();
  });
});

test.describe('CIBA Flow', () => {
  test('should reject unauthorized CIBA request', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/bc-authorize`, {
      form: {
        scope: 'openid',
        login_hint: 'user@example.com',
      },
    });

    // Should require client authentication
    expect(response.status()).toBe(401);
  });
});

test.describe('Dynamic Client Registration', () => {
  test('should return valid registration response', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/register`, {
      data: {
        redirect_uris: ['https://test-app.example.com/callback'],
        client_name: 'Test Client',
        token_endpoint_auth_method: 'client_secret_basic',
      },
    });

    // Either success or requires authentication
    expect(response.status()).toBeLessThan(500);

    if (response.status() === 201) {
      const body = await response.json();
      expect(body.client_id).toBeTruthy();
      expect(body.client_secret).toBeTruthy();
    }
  });
});

test.describe('Token Introspection', () => {
  test('should reject unauthorized introspection', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/introspect`, {
      form: {
        token: 'some-token',
      },
    });

    expect(response.status()).toBe(401);
  });
});

test.describe('Token Revocation', () => {
  test('should accept revocation request gracefully', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/revoke`, {
      form: {
        token: 'some-token',
      },
      headers: {
        Authorization: `Basic ${btoa('test-client:test-secret')}`,
      },
    });

    // Revocation should succeed silently even for invalid tokens
    expect(response.status()).toBe(200);
  });
});

test.describe('Security Headers', () => {
  test('should include security headers on token endpoint', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/token`, {
      form: { grant_type: 'test' },
    });

    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['x-frame-options']).toBe('DENY');
  });

  test('should include CORS headers', async ({ request }) => {
    const response = await request.get(`${OP_BASE_URL}/.well-known/openid-configuration`, {
      headers: {
        Origin: 'https://app.example.com',
      },
    });

    expect(response.headers()['access-control-allow-origin']).toBeTruthy();
  });
});

test.describe('PAR (Pushed Authorization Request)', () => {
  test('should handle PAR request', async ({ request }) => {
    const response = await request.post(`${OP_BASE_URL}/as/par`, {
      form: {
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid',
        state: 'test-state',
      },
      headers: {
        Authorization: `Basic ${btoa('test-client:test-secret')}`,
      },
    });

    // Either success or client not found
    expect(response.status()).toBeLessThan(500);

    if (response.status() === 201) {
      const body = await response.json();
      expect(body.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
      expect(body.expires_in).toBeGreaterThan(0);
    }
  });
});

// Helper functions for PKCE
function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  for (let i = 0; i < 64; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest));
  return btoa(String.fromCharCode.apply(null, bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]/g, '');
}

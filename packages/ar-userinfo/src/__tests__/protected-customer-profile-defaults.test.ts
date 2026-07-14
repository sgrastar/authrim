import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, IntrospectionResponse } from '@authrim/ar-lib-core';
import { DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getPublicKeyByKid: vi.fn(),
  verifyToken: vi.fn(),
  findById: vi.fn(),
  syncUser: vi.fn(),
  introspectTokenFromContext: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getPublicKeyByKid: mocks.getPublicKeyByKid,
    verifyToken: mocks.verifyToken,
    introspectTokenFromContext: mocks.introspectTokenFromContext,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findById;
      syncUser = mocks.syncUser;
    },
  };
});

import {
  createProtectedCustomerProfileRouter,
  DEFAULT_USERINFO_PROTECTED_AUDIENCE,
} from '../protected-customer-profile';

function encode(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function grantPayload(redactionLevel: 'masked' | 'raw' = 'masked') {
  return {
    authorization_details: [
      {
        type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
        grant_id: 'grant-1',
        request_id: 'request-1',
        investigation_id: 'investigation-1',
        request_surface: 'service_data',
        requested_action: 'detail_read',
        resource_class: 'customer_profile',
        resource_ids: ['user-1'],
        detail_classes: ['profile_export'],
        audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
        redaction_level: redactionLevel,
        target_subject_type: 'user',
        target_subject_id: 'user-1',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        policy_preset: 'technical_debug_default',
        reuse_scope: 'request',
        partial_access_allowed: false,
      },
    ],
    authrim_elevation: {
      grant_id: 'grant-1',
      request_id: 'request-1',
      investigation_id: 'investigation-1',
      resource_class: 'customer_profile',
      redaction_level: redactionLevel,
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      scope: {
        resource_class: 'customer_profile',
        resource_ids: ['user-1'],
        detail_classes: ['profile_export'],
        audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      },
    },
    act: { sub: 'admin_user:admin-1', client_id: 'service-client' },
    sub: 'user-1',
    aud: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
  };
}

function token(payload = grantPayload(), kid: string | null = 'key-1') {
  return `${encode(kid ? { alg: 'RS256', kid } : { alg: 'RS256' })}.${encode(payload)}.signature`;
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    tenant_id: 'tenant-a',
    subject_id: 'subject-1',
    account_id: 'account-1',
    email: 'user@example.com',
    email_verified: 1,
    name: 'Example User',
    family_name: 'User',
    given_name: 'Example',
    middle_name: 'Middle',
    nickname: 'EU',
    preferred_username: 'example',
    picture: 'https://example.com/picture.png',
    locale: 'ja-JP',
    zoneinfo: 'Asia/Tokyo',
    profile: 'https://example.com/profile',
    website: 'https://example.com',
    birthdate: '2000-01-01',
    gender: 'unspecified',
    phone_number: '+819012345678',
    phone_number_verified: 1,
    address_json: JSON.stringify({
      formatted: '1 Test Street',
      street_address: '1 Test Street',
      locality: 'Tokyo',
      region: 'Tokyo',
      postal_code: '100-0001',
      country: 'JP',
    }),
    active: 1,
    account_type: 'end_user',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function createEnv(introspection = false): Env {
  return {
    ISSUER_URL: 'https://tenant.example.com',
    ...(introspection
      ? {
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'userinfo-service',
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'service-secret',
        }
      : {}),
  } as Env;
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/profiles', createProtectedCustomerProfileRouter());
  return app;
}

describe('protected customer profile default adapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.getPublicKeyByKid.mockResolvedValue({ type: 'public' });
    mocks.verifyToken.mockImplementation(async (value: string) => {
      const [, payload] = value.split('.');
      return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    });
    mocks.findById.mockResolvedValue(projection());
    mocks.introspectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: { sub: 'actor-1' },
    });
  });

  it('verifies the token key and projects canonical PII through the default loader', async () => {
    const response = await createApp().request(
      'http://localhost/profiles/user-1',
      { headers: { Authorization: `Bearer ${token()}` } },
      createEnv()
    );
    expect(response.status).toBe(200);
    expect(mocks.getPublicKeyByKid).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'key-1');
    expect(mocks.verifyToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.any(String),
      { audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE }
    );
    await expect(response.json()).resolves.toMatchObject({
      profile: {
        sub: 'user-1',
        email: 'us**@example.com',
        phone_number: '*********5678',
        address: { locality: 'Tokyo', region: 'Tokyo', country: 'JP' },
      },
    });
  });

  it('normalizes absent canonical fields and malformed address JSON', async () => {
    mocks.findById.mockResolvedValue(
      projection({
        email: null,
        email_verified: 0,
        name: null,
        family_name: null,
        given_name: null,
        middle_name: null,
        nickname: null,
        preferred_username: null,
        picture: null,
        locale: null,
        zoneinfo: null,
        profile: null,
        website: null,
        birthdate: null,
        gender: null,
        phone_number: null,
        phone_number_verified: 0,
        address_json: '{invalid',
      })
    );
    const response = await createApp().request(
      'http://localhost/profiles/user-1',
      { headers: { Authorization: `Bearer ${token()}` } },
      createEnv()
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profile: { email: null, phone_number: null, address: null },
    });
  });

  it.each([
    ['missing kid', token(grantPayload(), null)],
    ['unknown kid', token(grantPayload(), 'unknown')],
  ])('rejects a downstream grant with a %s', async (label, grantToken) => {
    if (label === 'unknown kid') mocks.getPublicKeyByKid.mockResolvedValue(null);
    const response = await createApp().request(
      'http://localhost/profiles/user-1',
      { headers: { Authorization: `Bearer ${grantToken}` } },
      createEnv()
    );
    expect(response.status).toBe(403);
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('returns not_found when the canonical subject does not exist', async () => {
    mocks.findById.mockResolvedValue(null);
    const response = await createApp().request(
      'http://localhost/profiles/user-1',
      { headers: { Authorization: `Bearer ${token()}` } },
      createEnv()
    );
    expect(response.status).toBe(404);
  });

  it('performs authenticated online introspection before returning raw PII', async () => {
    const payload = grantPayload('raw');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        active: true,
        authorization_details: payload.authorization_details,
        act: payload.act,
      } satisfies IntrospectionResponse)
    );
    const response = await createApp().request(
      'http://localhost/profiles/user-1',
      { headers: { Authorization: `Bearer ${token(payload)}` } },
      createEnv(true)
    );
    expect(response.status).toBe(200);
    const introspectionRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(introspectionRequest.headers).toMatchObject({
      Authorization: `Basic ${btoa('userinfo-service:service-secret')}`,
    });
    expect(String(introspectionRequest.body)).toContain('token_type_hint=access_token');
    await expect(response.json()).resolves.toMatchObject({
      redaction_level: 'raw',
      profile: { email: 'user@example.com', middle_name: 'Middle' },
    });
  });

  it('fails closed when online introspection is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }));
    const payload = grantPayload('raw');
    const response = await createApp().request(
      'http://localhost/profiles/user-1',
      { headers: { Authorization: `Bearer ${token(payload)}` } },
      createEnv(true)
    );
    expect(response.status).toBe(403);
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an introspection error',
      {
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Expired token',
          statusCode: 401,
          wwwAuthenticate: 'Bearer error="invalid_token"',
        },
      },
      401,
      'Expired token',
    ],
    ['missing error details', { valid: false }, 401, 'The access token is invalid'],
    ['missing actor subject', { valid: true, claims: {} }, 401, 'actor subject'],
  ])('rejects delegated writes with %s', async (_label, introspection, status, message) => {
    mocks.introspectTokenFromContext.mockResolvedValue(introspection);
    const response = await createApp().request(
      'http://localhost/profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': `actor-${status}`,
        },
        body: JSON.stringify({ input: { name: 'Updated' } }),
      },
      createEnv()
    );
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_token',
      error_description: expect.stringContaining(message),
    });
  });

  it.each([[{ authrim_elevation: {} }], [{ token_use: 'elevation_grant_subject' }]])(
    'rejects product elevation claims from the default actor validator',
    async (claims) => {
      mocks.introspectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'actor-1', ...claims },
      });
      const response = await createApp().request(
        'http://localhost/profiles/users/user-1',
        {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer actor-token',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'elevation-actor',
          },
          body: JSON.stringify({ input: { name: 'Updated' } }),
        },
        createEnv()
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
    }
  );
});

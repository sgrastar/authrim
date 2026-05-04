import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, IntrospectionResponse } from '@authrim/ar-lib-core';
import {
  createProtectedCustomerProfileRouter,
  DEFAULT_USERINFO_PROTECTED_AUDIENCE,
} from '../protected-customer-profile';
import { DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE } from '@authrim/ar-lib-core';

function createTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })}.${encode(payload)}.signature`;
}

function createGrantToken(input?: {
  redactionLevel?: 'summary_only' | 'masked' | 'raw';
  resourceIds?: string[];
  detailClasses?: string[];
  targetSubjectId?: string;
  audience?: string;
}) {
  return createTestJwt({
    authorization_details: [
      {
        type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
        grant_id: 'egr_public_1',
        request_id: 'apr_public_1',
        investigation_id: 'inv_123',
        request_surface: 'service_data',
        requested_action: 'detail_read',
        resource_class: 'customer_profile',
        resource_ids: input?.resourceIds ?? ['user-1'],
        detail_classes: input?.detailClasses ?? ['profile_export'],
        audience: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
        redaction_level: input?.redactionLevel ?? 'masked',
        target_subject_type: 'user',
        target_subject_id: input?.targetSubjectId ?? 'user-1',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        policy_preset: 'technical_debug_default',
        reuse_scope: 'request',
        partial_access_allowed: false,
      },
    ],
    authrim_elevation: {
      grant_id: 'egr_public_1',
      request_id: 'apr_public_1',
      investigation_id: 'inv_123',
      resource_class: 'customer_profile',
      redaction_level: input?.redactionLevel ?? 'masked',
      target_subject_type: 'user',
      target_subject_id: input?.targetSubjectId ?? 'user-1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_audience: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      scope: {
        resource_class: 'customer_profile',
        resource_ids: input?.resourceIds ?? ['user-1'],
        detail_classes: input?.detailClasses ?? ['profile_export'],
        audience: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      },
    },
    act: {
      sub: 'admin_user:admin-1',
      client_id: 'svc-client-1',
    },
    sub: input?.targetSubjectId ?? 'user-1',
    aud: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
  });
}

function createApp(options?: {
  introspectionResponse?: IntrospectionResponse;
  verifyTokenImpl?: (token: string) => Promise<Record<string, unknown>>;
}) {
  const app = new Hono<{ Bindings: Env }>();
  const sampleProfile = {
    id: 'user-1',
    tenantId: 'tenant-a',
    name: 'Alice Example',
    familyName: 'Example',
    givenName: 'Alice',
    middleName: null,
    nickname: 'Ali',
    preferredUsername: 'alice',
    picture: null,
    locale: 'en-US',
    zoneinfo: 'Asia/Tokyo',
    profile: 'https://example.com/alice',
    website: null,
    birthdate: '2000-01-01',
    gender: 'female',
    email: 'alice@example.com',
    emailVerified: true,
    phoneNumber: '+819012345678',
    phoneNumberVerified: true,
    address: {
      formatted: '1 Example Street',
      street_address: '1 Example Street',
      locality: 'Tokyo',
      region: 'Tokyo',
      postal_code: '100-0001',
      country: 'JP',
    },
    updatedAt: 1700000000,
  };

  app.route(
    '/api/protected/customer-profiles',
    createProtectedCustomerProfileRouter({
      verifyToken: async ({ token }) => {
        if (options?.verifyTokenImpl) {
          return options.verifyTokenImpl(token);
        }
        const [, payload] = token.split('.');
        return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
          string,
          unknown
        >;
      },
      introspectToken: options?.introspectionResponse
        ? async () => options.introspectionResponse as IntrospectionResponse
        : undefined,
      async loadProfile({ userId }) {
        if (userId !== 'user-1') {
          return null;
        }
        return sampleProfile;
      },
    })
  );

  return app;
}

describe('protected customer profile route', () => {
  it('returns a masked customer profile for low-risk access', async () => {
    const app = createApp();
    const token = createGrantToken({ redactionLevel: 'masked' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redaction_level: 'masked',
      profile: {
        sub: 'user-1',
        email: 'al***@example.com',
        phone_number: '*********5678',
        address: {
          locality: 'Tokyo',
          region: 'Tokyo',
          country: 'JP',
        },
      },
    });
  });

  it('returns a summary profile when summary_only is granted', async () => {
    const app = createApp();
    const token = createGrantToken({ redactionLevel: 'summary_only' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profile: {
        sub: 'user-1',
        tenant_id: 'tenant-a',
        email_verified: true,
        phone_number_verified: true,
        updated_at: 1700000000,
      },
      correlation_id: 'inv_123',
      redaction_level: 'summary_only',
      requires_online_check: false,
      fail_closed: false,
    });
  });

  it('fails closed for raw access when online introspection is unavailable', async () => {
    const app = createApp();
    const token = createGrantToken({ redactionLevel: 'raw' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      reason_code: 'grant_online_check_required',
      requires_online_check: true,
      fail_closed: true,
    });
  });

  it('returns the raw customer profile after a successful online check', async () => {
    const token = createGrantToken({ redactionLevel: 'raw' });
    const app = createApp({
      introspectionResponse: {
        active: true,
        authorization_details: [
          {
            type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
            grant_id: 'egr_public_1',
            request_id: 'apr_public_1',
            investigation_id: 'inv_123',
            request_surface: 'service_data',
            requested_action: 'detail_read',
            resource_class: 'customer_profile',
            resource_ids: ['user-1'],
            detail_classes: ['profile_export'],
            audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
            redaction_level: 'raw',
            target_subject_type: 'user',
            target_subject_id: 'user-1',
            requester_subject_type: 'admin_user',
            requester_subject_id: 'admin-1',
            policy_preset: 'technical_debug_default',
            reuse_scope: 'request',
            partial_access_allowed: false,
          },
        ],
        act: {
          sub: 'admin_user:admin-1',
          client_id: 'svc-client-1',
        },
      } as IntrospectionResponse,
    });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redaction_level: 'raw',
      requires_online_check: true,
      fail_closed: true,
      profile: {
        sub: 'user-1',
        email: 'alice@example.com',
        phone_number: '+819012345678',
        address: {
          locality: 'Tokyo',
          street_address: '1 Example Street',
        },
      },
    });
  });

  it('denies when the target subject does not match the loaded profile', async () => {
    const app = createApp();
    const token = createGrantToken({ targetSubjectId: 'user-999' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      reason_code: 'subject_mismatch',
    });
  });
});

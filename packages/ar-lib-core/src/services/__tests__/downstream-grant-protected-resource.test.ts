import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  createDownstreamGrantServiceAuthorizer,
  DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
} from '../downstream-elevation-grant';
import {
  createDownstreamGrantProtectedResourceMiddleware,
  getDownstreamGrantProtectedResourceContext,
} from '../downstream-grant-protected-resource';

function createTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function createAccessToken(input: {
  redactionLevel?: 'masked' | 'raw';
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
        resource_ids: input.resourceIds ?? ['profile-1'],
        detail_classes: input.detailClasses ?? ['profile_export'],
        audience: input.audience ?? 'svc://customer-portal',
        redaction_level: input.redactionLevel ?? 'masked',
        target_subject_type: 'user',
        target_subject_id: input.targetSubjectId ?? 'user-1',
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
  });
}

describe('downstream grant protected resource middleware', () => {
  const profiles = new Map([
    ['profile-1', { id: 'profile-1', subjectId: 'user-1', displayName: 'Alice' }],
    ['profile-2', { id: 'profile-2', subjectId: 'user-2', displayName: 'Bob' }],
  ]);

  function createApp(options?: {
    introspectionResponse?: Record<string, unknown> | null;
    verifyTokenImpl?: (token: string) => Promise<Record<string, unknown>>;
  }) {
    const app = new Hono();
    const authorizer = createDownstreamGrantServiceAuthorizer({
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
    });

    app.use(
      '/profiles/:id',
      createDownstreamGrantProtectedResourceMiddleware({
        authorizer,
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
          ? async () => options.introspectionResponse as any
          : undefined,
        resolveResourceId(c) {
          return c.req.param('id')!;
        },
        async loadResource({ resourceId }) {
          return profiles.get(resourceId) ?? null;
        },
        async resolveRequiredDetailClasses() {
          return ['profile_export'];
        },
        async resolveLocalAuthorization({ decision, resource }) {
          return {
            allowed: decision.context.targetSubjectId === resource.subjectId,
            reasonCode: 'subject_mismatch',
          };
        },
      })
    );

    app.get('/profiles/:id', (c) => {
      const context = getDownstreamGrantProtectedResourceContext<{
        id: string;
        subjectId: string;
        displayName: string;
      }>(c);
      if (!context || !context.resource) {
        return c.json({ error: 'missing_context' }, 500);
      }

      return c.json({
        profile: context.resource,
        correlation_id: context.authorization.correlationId,
        redaction_level: context.authorization.redactionLevel,
      });
    });

    return app;
  }

  it('allows a low-risk offline-verified resource read', async () => {
    const app = createApp();
    const accessToken = createAccessToken({});

    const response = await app.request('http://example.com/profiles/profile-1', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profile: {
        id: 'profile-1',
        displayName: 'Alice',
      },
      redaction_level: 'masked',
    });
  });

  it('denies when the route resource id is outside the grant scope', async () => {
    const app = createApp();
    const accessToken = createAccessToken({
      resourceIds: ['profile-1'],
    });

    const response = await app.request('http://example.com/profiles/profile-2', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      reason_code: 'grant_resource_scope_mismatch',
    });
  });

  it('requires online introspection for high-risk raw access', async () => {
    const app = createApp();
    const accessToken = createAccessToken({
      redactionLevel: 'raw',
    });

    const response = await app.request('http://example.com/profiles/profile-1', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
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

  it('allows high-risk access after a successful online introspection check', async () => {
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
            resource_ids: ['profile-1'],
            detail_classes: ['profile_export'],
            audience: 'svc://customer-portal',
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
      },
    });
    const accessToken = createAccessToken({
      redactionLevel: 'raw',
    });

    const response = await app.request('http://example.com/profiles/profile-1', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redaction_level: 'raw',
    });
  });

  it('falls back to introspection when offline token verification cannot resolve a grant decision', async () => {
    const accessToken = createAccessToken({});
    const app = createApp({
      verifyTokenImpl: async () => ({
        iss: 'https://issuer.example.com',
        sub: 'user-1',
        aud: 'svc://customer-portal',
      }),
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
            resource_ids: ['profile-1'],
            detail_classes: ['profile_export'],
            audience: 'svc://customer-portal',
            redaction_level: 'masked',
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
      },
    });

    const response = await app.request('http://example.com/profiles/profile-1', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redaction_level: 'masked',
      profile: {
        id: 'profile-1',
      },
    });
  });

  it('applies local authorization after grant validation', async () => {
    const app = createApp();
    const accessToken = createAccessToken({
      targetSubjectId: 'user-999',
    });

    const response = await app.request('http://example.com/profiles/profile-1', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      reason_code: 'subject_mismatch',
    });
  });

  it('returns not found when the protected resource is absent', async () => {
    const app = createApp();
    const accessToken = createAccessToken({
      resourceIds: ['profile-404'],
    });

    const response = await app.request('http://example.com/profiles/profile-404', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'resource_not_found',
    });
  });

  it('does not leak missing resources before downstream authorization succeeds', async () => {
    const app = createApp();
    const accessToken = createAccessToken({
      resourceIds: ['profile-1'],
    });

    const response = await app.request('http://example.com/profiles/profile-404', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      reason_code: 'grant_resource_scope_mismatch',
    });
  });
});

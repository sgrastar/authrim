import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE } from '@authrim/ar-lib-core';
import {
  createProtectedCustomerProfileRouter,
  DEFAULT_USERINFO_PROTECTED_AUDIENCE,
} from '../../protected-customer-profile';

/** Fixtures for the downstream-grant read route and the canonical user projection behind it. */

function encode(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
}

export function grantPayload(
  options: {
    redaction?: 'summary_only' | 'masked' | 'raw';
    resourceIds?: string[];
    detailClasses?: string[];
    targetSubjectId?: string;
  } = {}
): Record<string, unknown> {
  const redaction = options.redaction ?? 'masked';
  const resourceIds = options.resourceIds ?? ['user-1'];
  const detailClasses = options.detailClasses ?? ['profile_export'];
  const target = options.targetSubjectId ?? 'user-1';
  return {
    client_id: 'service-client',
    authorization_details: [
      {
        type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
        grant_id: 'grant-1',
        request_id: 'request-1',
        investigation_id: 'investigation-1',
        request_surface: 'service_data',
        requested_action: 'detail_read',
        resource_class: 'customer_profile',
        resource_ids: resourceIds,
        detail_classes: detailClasses,
        audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
        redaction_level: redaction,
        target_subject_type: 'user',
        target_subject_id: target,
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
      redaction_level: redaction,
      target_subject_type: 'user',
      target_subject_id: target,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      scope: {
        resource_class: 'customer_profile',
        resource_ids: resourceIds,
        detail_classes: detailClasses,
        audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      },
    },
    act: { sub: 'admin_user:admin-1', client_id: 'service-client' },
    sub: target,
    aud: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
  };
}

/** A grant token; `header` replaces the JOSE header (default: a kid of `key-1`). */
export function grantToken(
  payload: Record<string, unknown> = grantPayload(),
  header: Record<string, unknown> = { alg: 'RS256', kid: 'key-1' }
): string {
  return `${encode(header)}.${encode(payload)}.signature`;
}

export function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    tenant_id: 'tenant-a',
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

export function profilesApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/profiles', createProtectedCustomerProfileRouter());
  return app;
}

export function profilesEnv(introspection = false): Env {
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

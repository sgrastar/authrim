import { describe, expect, it, vi } from 'vitest';
import { DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE } from '../downstream-elevation-grant';
import {
  DownstreamGrantProtectedResourceAccessError,
  fetchProtectedResourceWithDownstreamGrant,
} from '../downstream-grant-protected-resource-client';

function createTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('downstream protected resource client helpers', () => {
  it('exchanges, introspects, and fetches a protected resource', async () => {
    const accessToken = createTestJwt({
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
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 300,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'profile-1',
            displayName: 'Alice',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const result = await fetchProtectedResourceWithDownstreamGrant({
      tokenEndpoint: 'https://auth.example.com/token',
      introspectionEndpoint: 'https://auth.example.com/introspect',
      client: {
        clientId: 'svc-client-1',
        clientSecret: 'svc-secret',
      },
      subjectToken: 'subject-token',
      audience: 'svc://customer-portal',
      authorization: {
        expectedAudience: 'svc://customer-portal',
        requiredResourceClass: 'customer_profile',
        requiredResourceId: 'profile-1',
        requiredDetailClass: 'profile_export',
      },
      resourceUrl: 'https://service.example.com/profiles/profile-1',
      resourceFetchImpl: fetchMock as unknown as typeof fetch,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, , resourceCall] = fetchMock.mock.calls as [string, RequestInit][];
    expect(resourceCall[0]).toBe('https://service.example.com/profiles/profile-1');
    expect((resourceCall[1].headers as Headers).get('Authorization')).toBe(`Bearer ${accessToken}`);
    expect(result.authorization.allowed).toBe(true);
    expect(result.resourceData).toEqual({
      id: 'profile-1',
      displayName: 'Alice',
    });
  });

  it('does not fetch the resource when authorization fails', async () => {
    const accessToken = createTestJwt({
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
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 300,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      fetchProtectedResourceWithDownstreamGrant({
        tokenEndpoint: 'https://auth.example.com/token',
        client: {
          clientId: 'svc-client-1',
          clientSecret: 'svc-secret',
        },
        subjectToken: 'subject-token',
        audience: 'svc://customer-portal',
        authorization: {
          expectedAudience: 'svc://customer-portal',
          requiredResourceClass: 'customer_profile',
          requiredResourceId: 'profile-2',
          requiredDetailClass: 'profile_export',
        },
        resourceUrl: 'https://service.example.com/profiles/profile-2',
        resourceFetchImpl: fetchMock as unknown as typeof fetch,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(DownstreamGrantProtectedResourceAccessError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

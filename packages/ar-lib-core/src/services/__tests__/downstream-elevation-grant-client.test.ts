import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DownstreamGrantClientError,
  exchangeAndEvaluateDownstreamGrant,
  exchangeDownstreamGrantSubjectToken,
  introspectDownstreamGrantToken,
} from '../downstream-elevation-grant-client';
import { DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE } from '../downstream-elevation-grant';

function createTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downstream elevation grant client helpers', () => {
  it('exchanges elevation grant subject tokens with client_secret_basic auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'downstream-access-token',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
          expires_in: 300,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    );

    const result = await exchangeDownstreamGrantSubjectToken({
      tokenEndpoint: 'https://auth.example.com/token',
      client: {
        clientId: 'svc-client-1',
        clientSecret: 'svc-secret',
      },
      subjectToken: 'subject-token',
      audience: 'https://service.example.com',
      scope: ['profile_export', 'audit_detail'],
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.response.access_token).toBe('downstream-access-token');
    expect(result.authorizationHeader).toBe('Bearer downstream-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.example.com/token');
    expect(request.method).toBe('POST');
    expect(String(request.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange');
    expect(String(request.body)).toContain('subject_token=subject-token');
    expect(String(request.body)).toContain('subject_token_type=urn%3Aauthrim%3Atoken-type%3Aelevation-grant');
    expect(String(request.body)).toContain('scope=profile_export+audit_detail');
    expect((request.headers as Headers).get('Authorization')).toBe(
      `Basic ${Buffer.from('svc-client-1:svc-secret').toString('base64')}`
    );
  });

  it('introspects downstream grant tokens with client_secret_post auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          active: true,
          authrim_elevation: {
            grant_id: 'egr_public_1',
            request_id: 'apr_public_1',
            investigation_id: 'inv_123',
            target_subject_type: 'user',
            target_subject_id: 'user-1',
            requester_subject_type: 'admin_user',
            requester_subject_id: 'admin-1',
            resource_class: 'customer_profile',
            redaction_level: 'masked',
            target_audience: 'https://service.example.com',
            scope: {
              audience: 'https://service.example.com',
              resource_ids: ['user-1'],
              detail_classes: ['profile_export'],
            },
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    );

    const result = await introspectDownstreamGrantToken({
      introspectionEndpoint: 'https://auth.example.com/introspect',
      client: {
        clientId: 'svc-client-1',
        clientSecret: 'svc-secret',
        authMethod: 'client_secret_post',
      },
      accessToken: 'downstream-access-token',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.active).toBe(true);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((request.headers as Headers).get('Authorization')).toBeNull();
    expect(String(request.body)).toContain('token=downstream-access-token');
    expect(String(request.body)).toContain('client_id=svc-client-1');
    expect(String(request.body)).toContain('client_secret=svc-secret');
  });

  it('performs online introspection when the offline decision requires it', async () => {
    const rawAccessToken = createTestJwt({
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
          audience: 'https://service.example.com',
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
            access_token: rawAccessToken,
            issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
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
                resource_ids: ['user-1'],
                detail_classes: ['profile_export'],
                audience: 'https://service.example.com',
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
      );

    const result = await exchangeAndEvaluateDownstreamGrant({
      tokenEndpoint: 'https://auth.example.com/token',
      introspectionEndpoint: 'https://auth.example.com/introspect',
      client: {
        clientId: 'svc-client-1',
        clientSecret: 'svc-secret',
      },
      subjectToken: 'subject-token',
      audience: 'https://service.example.com',
      authorization: {
        expectedAudience: 'https://service.example.com',
        requiredResourceClass: 'customer_profile',
        requiredDetailClass: 'profile_export',
      },
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.offlineAuthorization.requiresOnlineCheck).toBe(true);
    expect(result.finalAuthorization.allowed).toBe(true);
    expect(result.finalAuthorization.decision?.source).toBe('introspection');
    expect(result.introspectionResponse?.active).toBe(true);
  });

  it('surfaces oauth errors from token exchange responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_target',
          error_description: 'Requested audience is not allowed for this client',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    );

    await expect(
      exchangeDownstreamGrantSubjectToken({
        tokenEndpoint: 'https://auth.example.com/token',
        client: {
          clientId: 'svc-client-1',
          clientSecret: 'svc-secret',
        },
        subjectToken: 'subject-token',
        audience: 'https://service.example.com',
        fetchImpl: fetchMock as typeof fetch,
      })
    ).rejects.toMatchObject<Partial<DownstreamGrantClientError>>({
      name: 'DownstreamGrantClientError',
      status: 400,
      errorCode: 'invalid_target',
    });
  });

  it('rejects oversized token exchange responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('x'.repeat(128), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );

    await expect(
      exchangeDownstreamGrantSubjectToken({
        tokenEndpoint: 'https://auth.example.com/token',
        client: {
          clientId: 'svc-client-1',
          clientSecret: 'svc-secret',
        },
        subjectToken: 'subject-token',
        fetchImpl: fetchMock as typeof fetch,
        maxResponseSize: 16,
      })
    ).rejects.toThrow('Response body exceeds limit');
  });
});

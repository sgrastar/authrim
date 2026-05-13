import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultConfig } from '../core/config.js';
import { runGeneratedApprovalsSmoke } from '../core/generated-approvals-smoke.js';

describe('generated approvals smoke', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the approval completion and protected resource smoke against a generated environment', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-approvals-smoke-'));
    const env = 'single';
    const envDir = join(baseDir, '.authrim', env);
    const keysDir = join(baseDir, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    await mkdir(keysDir, { recursive: true });

    const config = createDefaultConfig(env);
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.workers.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.workers.dev', sameAsApi: false },
    };

    await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(keysDir, 'admin_api_secret.txt'), 'admin-secret');

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/admin/users') && method === 'POST') {
        return new Response(JSON.stringify({ user: { id: 'user-1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/approvals') && method === 'POST') {
        return new Response(
          JSON.stringify({
            public_request_id: 'apr_public_1',
            approvals: [{ id: 'step-1' }],
            notification_results: [
              {
                completion_artifact: {
                  artifact_id: 'apc_1',
                  path: '/api/approval-artifacts/apc_1/portal',
                  expires_at: Date.now() + 300_000,
                },
              },
            ],
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/approval-artifacts/apc_1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            artifact_id: 'apc_1',
            completion_requirements: {
              method: 'portal_confirm',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/approval-artifacts/apc_1/portal') && method === 'GET') {
        return new Response(
          '<html><body><form action="/api/approval-artifacts/apc_1/complete"></form></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }

      if (url.endsWith('/api/approval-artifacts/apc_1/complete') && method === 'POST') {
        expect(init?.headers).toMatchObject({
          origin: 'https://single-ar-router.example.workers.dev',
          referer:
            'https://single-ar-router.example.workers.dev/api/approval-artifacts/apc_1/portal',
        });
        return new Response(
          JSON.stringify({
            artifact_id: 'apc_1',
            request_status: 'approved',
            receipt_path: '/api/approval-receipts/adr_1',
            receipt_portal_path: '/api/approval-receipts/adr_1/portal',
            grant_ids: ['egr_public_1'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/approval-receipts/adr_1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            receipt_id: 'adr_1',
            decision: 'approved',
            receipt_portal_path: '/api/approval-receipts/adr_1/portal',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/approvals/apr_public_1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            public_request_id: 'apr_public_1',
            status: 'approved',
            grants: [{ public_grant_id: 'egr_public_1' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/approvals/apr_public_1/receipts') && method === 'GET') {
        return new Response(
          JSON.stringify({
            items: [{ receipt_id: 'adr_1' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (
        url.endsWith('/api/admin/approvals/apr_public_1/grants/egr_public_1/subject-token') &&
        method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            subject_token: 'subject-token-jwt',
            integration_hint: {
              subject_token_client_id: 'svc-client-1',
              target_audience: 'admin_api',
              product_route: {
                path_template: '/api/protected/customer-profiles/:userId',
                default_audience: 'svc://op-userinfo/customer-profile',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/token') && method === 'POST') {
        expect(String(init?.body)).toContain(
          'subject_token_type=urn%3Aauthrim%3Atoken-type%3Aelevation-grant'
        );
        expect(String(init?.body)).toContain('audience=svc%3A%2F%2Fop-userinfo%2Fcustomer-profile');
        return new Response(
          JSON.stringify({
            access_token: 'access-token-jwt',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/introspect') && method === 'POST') {
        return new Response(
          JSON.stringify({
            active: true,
            authrim_elevation: {
              resource_class: 'customer_profile',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/protected/customer-profiles/user-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            profile: {
              sub: 'user-1',
              email: 'ap***************@example.test',
            },
            redaction_level: 'masked',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/users/user-1') && method === 'DELETE') {
        return new Response(
          JSON.stringify({
            success: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const result = await runGeneratedApprovalsSmoke({
      baseDir,
      env,
      clientId: 'svc-client-1',
      clientSecret: 'svc-client-secret',
    });

    expect(result.ok).toBe(true);
    expect(result.userId).toBe('user-1');
    expect(result.requestId).toBe('apr_public_1');
    expect(result.grantId).toBe('egr_public_1');
    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'approval-smoke-user-create',
        'approval-request-create',
        'approval-artifact-read',
        'approval-artifact-portal-read',
        'approval-complete',
        'approval-receipt-read',
        'approval-request-read',
        'approval-receipts-admin-read',
        'approval-subject-token',
        'approval-downstream-token-exchange',
        'approval-downstream-token-introspection',
        'approval-protected-resource-read',
        'approval-smoke-user-delete',
      ])
    );
  });

  it('retries protected resource read once when a transient grant_missing is returned', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-approvals-smoke-retry-'));
    const env = 'single';
    const envDir = join(baseDir, '.authrim', env);
    const keysDir = join(baseDir, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    await mkdir(keysDir, { recursive: true });

    const config = createDefaultConfig(env);
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.workers.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.workers.dev', sameAsApi: false },
    };

    await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(keysDir, 'admin_api_secret.txt'), 'admin-secret');

    let protectedReadCount = 0;
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/admin/users') && method === 'POST') {
        return new Response(JSON.stringify({ user: { id: 'user-1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/admin/approvals') && method === 'POST') {
        return new Response(
          JSON.stringify({
            public_request_id: 'apr_public_1',
            approvals: [{ id: 'step-1' }],
            notification_results: [
              {
                completion_artifact: {
                  artifact_id: 'apc_1',
                  path: '/api/approval-artifacts/apc_1/portal',
                  expires_at: Date.now() + 300_000,
                },
              },
            ],
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/approval-artifacts/apc_1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            artifact_id: 'apc_1',
            completion_requirements: {
              method: 'portal_confirm',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/approval-artifacts/apc_1/portal') && method === 'GET') {
        return new Response(
          '<html><body><form action="/api/approval-artifacts/apc_1/complete"></form></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }

      if (url.endsWith('/api/approval-artifacts/apc_1/complete') && method === 'POST') {
        return new Response(
          JSON.stringify({
            artifact_id: 'apc_1',
            request_status: 'approved',
            receipt_path: '/api/approval-receipts/adr_1',
            receipt_portal_path: '/api/approval-receipts/adr_1/portal',
            grant_ids: ['egr_public_1'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/approval-receipts/adr_1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            receipt_id: 'adr_1',
            decision: 'approved',
            receipt_portal_path: '/api/approval-receipts/adr_1/portal',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/approvals/apr_public_1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            public_request_id: 'apr_public_1',
            status: 'approved',
            grants: [{ public_grant_id: 'egr_public_1' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/approvals/apr_public_1/receipts') && method === 'GET') {
        return new Response(
          JSON.stringify({
            items: [{ receipt_id: 'adr_1' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (
        url.endsWith('/api/admin/approvals/apr_public_1/grants/egr_public_1/subject-token') &&
        method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            subject_token: 'subject-token-jwt',
            integration_hint: {
              subject_token_client_id: 'svc-client-1',
              target_audience: 'admin_api',
              product_route: {
                path_template: '/api/protected/customer-profiles/:userId',
                default_audience: 'svc://op-userinfo/customer-profile',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/token') && method === 'POST') {
        return new Response(
          JSON.stringify({
            access_token: 'access-token-jwt',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/introspect') && method === 'POST') {
        return new Response(
          JSON.stringify({
            active: true,
            authrim_elevation: {
              resource_class: 'customer_profile',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/protected/customer-profiles/user-1') && method === 'GET') {
        protectedReadCount += 1;
        if (protectedReadCount === 1) {
          return new Response(
            JSON.stringify({
              error: 'access_denied',
              reason_code: 'grant_missing',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            profile: {
              sub: 'user-1',
              email: 'ap***************@example.test',
            },
            redaction_level: 'masked',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/users/user-1') && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const result = await runGeneratedApprovalsSmoke({
      baseDir,
      env,
      clientId: 'svc-client-1',
      clientSecret: 'svc-client-secret',
    });

    expect(result.ok).toBe(true);
    const protectedRead = result.checks.find(
      (check) => check.id === 'approval-protected-resource-read'
    );
    expect(protectedRead?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('grant_missing を受信したため'),
        expect.stringContaining('retry 後に protected resource read が成功しました'),
      ])
    );
    expect(protectedReadCount).toBe(2);
  });
});

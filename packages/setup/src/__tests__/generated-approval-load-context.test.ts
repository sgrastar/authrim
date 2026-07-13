import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  resolveTarget: vi.fn(),
  readAdminSecret: vi.fn(),
  resolveClient: vi.fn(),
  cleanupClient: vi.fn(),
  enableTokenExchange: vi.fn(),
  restoreTokenExchange: vi.fn(),
  adminCleanup: vi.fn(),
}));

vi.mock('../core/generated-smoke-common.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/generated-smoke-common.js')>();
  return {
    ...actual,
    fetchJsonWithTimeout: mocks.fetchJson,
    resolveGeneratedSmokeTarget: mocks.resolveTarget,
    readGeneratedAdminApiSecret: mocks.readAdminSecret,
  };
});

vi.mock('../core/generated-approvals-smoke-client.js', () => ({
  resolveGeneratedApprovalSmokeClient: mocks.resolveClient,
  cleanupGeneratedApprovalSmokeClient: mocks.cleanupClient,
}));

vi.mock('../core/generated-token-exchange-settings.js', () => ({
  ensureGeneratedTokenExchangeEnabled: mocks.enableTokenExchange,
}));

import { createGeneratedApprovalLoadContext } from '../core/generated-approval-load-context.js';

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    contentType: 'application/json',
    payload,
    bodyText: JSON.stringify(payload),
  };
}

describe('createGeneratedApprovalLoadContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockResolvedValue({
      env: 'test',
      baseDir: '/repo',
      configPath: '/repo/.authrim/test/config.json',
      baseUrl: 'https://issuer.example.test',
      tenantId: 'tenant-a',
      config: {},
    });
    mocks.readAdminSecret.mockResolvedValue({
      secret: 'admin-secret',
      path: '(inline)',
      cleanup: mocks.adminCleanup,
    });
    mocks.resolveClient.mockResolvedValue({
      clientId: 'load-client',
      clientSecret: 'load-secret',
      temporaryClientId: 'temporary-client',
      checks: [],
    });
    mocks.cleanupClient.mockImplementation(async ({ checks }) => {
      checks.push({ id: 'client-cleanup', title: 'client cleanup', status: 'pass', details: [] });
    });
    mocks.enableTokenExchange.mockResolvedValue({
      check: { id: 'token-settings', title: 'token settings', status: 'pass', details: [] },
      restore: mocks.restoreTokenExchange,
    });
    mocks.restoreTokenExchange.mockResolvedValue({
      id: 'token-settings-restore',
      title: 'restore token settings',
      status: 'pass',
      details: [],
    });
  });

  it('builds a usable approval grant context and cleans up all temporary state', async () => {
    mocks.fetchJson.mockImplementation(
      async (url: string, _timeout: number, init?: globalThis.RequestInit) => {
        const path = new URL(url).pathname;
        if (path === '/api/admin/users' && init?.method === 'POST') {
          return jsonResponse(201, { user: { id: 'user/123' } });
        }
        if (path === '/api/admin/approvals') {
          return jsonResponse(201, {
            public_request_id: 'request-1',
            approvals: [{ id: 'approval-1' }],
            notification_results: [
              { completion_artifact: { path: '/approval-artifacts/artifact-1/portal/' } },
            ],
          });
        }
        if (path.endsWith('/complete')) {
          return jsonResponse(200, { grant_ids: ['grant-1'] });
        }
        if (path.endsWith('/subject-token')) {
          return jsonResponse(200, {
            subject_token: 'subject-token',
            integration_hint: {
              target_audience: 'admin_api',
              product_route: {
                default_audience: 'svc://userinfo',
                path_template: '/userinfo/:userId/details',
              },
            },
          });
        }
        if (path === '/token') {
          return jsonResponse(200, { access_token: 'downstream-token' });
        }
        if (path === '/userinfo/user%2F123/details') {
          return jsonResponse(200, { sub: 'user/123' });
        }
        if (path === '/api/admin/users/user%2F123' && init?.method === 'DELETE') {
          return jsonResponse(204, undefined);
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
      }
    );

    const context = await createGeneratedApprovalLoadContext({
      baseDir: '/repo',
      env: 'test',
      subjectTokenExpiresIn: 120,
    });

    expect(context).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user/123',
      requestId: 'request-1',
      grantId: 'grant-1',
      clientId: 'load-client',
      subjectToken: 'subject-token',
      downstreamAccessToken: 'downstream-token',
      protectedResourcePath: '/userinfo/user%2F123/details',
    });
    expect(context.checks.every((check) => check.status !== 'fail')).toBe(true);
    expect(mocks.fetchJson).toHaveBeenCalledWith(
      'https://issuer.example.test/token',
      10_000,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: expect.stringMatching(/^Basic /) }),
        body: expect.stringContaining('subject_token=subject-token'),
      })
    );

    const cleanupChecks = await context.cleanup();
    expect(cleanupChecks.map((check) => check.id)).toEqual([
      'client-cleanup',
      'approval-load-user-delete',
      'token-settings-restore',
    ]);
    expect(mocks.adminCleanup).toHaveBeenCalledOnce();
  });

  it('issues a manual completion artifact when notifications do not provide one', async () => {
    mocks.fetchJson.mockImplementation(
      async (url: string, _timeout: number, init?: globalThis.RequestInit) => {
        const path = new URL(url).pathname;
        if (path === '/api/admin/users') return jsonResponse(201, { user: { id: 'user-1' } });
        if (path === '/api/admin/approvals') {
          return jsonResponse(201, {
            public_request_id: 'request-1',
            approvals: [{ id: 'approval-1' }],
            notification_results: [],
          });
        }
        if (path.endsWith('/artifacts')) {
          return jsonResponse(200, { completion_path: '/artifact/manual' });
        }
        if (path.endsWith('/complete')) return jsonResponse(200, { grant_ids: ['grant-1'] });
        if (path.endsWith('/subject-token')) {
          return jsonResponse(200, {
            subject_token: 'subject-token',
            integration_hint: {
              target_audience: 'svc://userinfo',
              product_route: { path_template: '/userinfo/:userId' },
            },
          });
        }
        if (path === '/token') return jsonResponse(200, { access_token: 'access-token' });
        if (path === '/userinfo/user-1') return jsonResponse(200, {});
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
      }
    );

    const context = await createGeneratedApprovalLoadContext({ env: 'test' });

    expect(context.checks.map((check) => check.id)).toContain('approval-load-artifact-issue');
    expect(mocks.fetchJson.mock.calls.some(([url]) => String(url).endsWith('/artifacts'))).toBe(
      true
    );
  });

  it('fails fast when user creation does not return an identifier', async () => {
    mocks.fetchJson.mockResolvedValue(jsonResponse(201, { user: {} }));

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      'approval_load_user_create_failed'
    );
    expect(mocks.resolveClient).not.toHaveBeenCalled();
  });

  it('stops before approval creation when no usable client credentials are available', async () => {
    mocks.fetchJson.mockResolvedValueOnce(jsonResponse(201, { user: { id: 'user-1' } }));
    mocks.resolveClient.mockResolvedValueOnce({
      clientId: null,
      clientSecret: null,
      checks: [],
    });

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      'approval_load_client_unavailable'
    );
    expect(mocks.fetchJson).toHaveBeenCalledOnce();
  });

  it('rejects an approval request that cannot produce a completion artifact', async () => {
    mocks.fetchJson
      .mockResolvedValueOnce(jsonResponse(201, { user: { id: 'user-1' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          public_request_id: 'request-1',
          approvals: [{ id: 'approval-1' }],
          notification_results: [],
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      'approval_load_artifact_unavailable'
    );
    expect(mocks.fetchJson).toHaveBeenCalledTimes(3);
  });

  it('rejects completion responses without a grant identifier', async () => {
    mocks.fetchJson
      .mockResolvedValueOnce(jsonResponse(201, { user: { id: 'user-1' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          public_request_id: 'request-1',
          approvals: [{ id: 'approval-1' }],
          notification_results: [
            { completion_artifact: { path: '/approval-artifacts/artifact-1/portal' } },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { grant_ids: [] }));

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      'approval_load_grant_missing'
    );
  });

  it('requires audience and protected-resource routing in the subject-token hint', async () => {
    mocks.fetchJson
      .mockResolvedValueOnce(jsonResponse(201, { user: { id: 'user-1' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          public_request_id: 'request-1',
          approvals: [{ id: 'approval-1' }],
          notification_results: [
            { completion_artifact: { path: '/approval-artifacts/artifact-1/portal' } },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { grant_ids: ['grant-1'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, { subject_token: 'subject-token', integration_hint: {} })
      );

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      'approval_load_subject_context_incomplete'
    );
  });

  it('rejects a failed downstream token exchange', async () => {
    mocks.fetchJson
      .mockResolvedValueOnce(jsonResponse(201, { user: { id: 'user-1' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          public_request_id: 'request-1',
          approvals: [{ id: 'approval-1' }],
          notification_results: [
            { completion_artifact: { path: '/approval-artifacts/artifact-1/portal' } },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { grant_ids: ['grant-1'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          subject_token: 'subject-token',
          integration_hint: {
            target_audience: 'svc://userinfo',
            product_route: { path_template: '/userinfo/:userId' },
          },
        })
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        contentType: 'application/json',
        payload: { error: 'server_error' },
        bodyText: 'server_error',
      });

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      'approval_load_downstream_access_token_missing'
    );
  });
});

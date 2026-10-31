import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    mocks.fetchJson
      .mockResolvedValueOnce(jsonResponse(201, { user: { id: 'user-1' } }))
      .mockResolvedValueOnce(jsonResponse(204, undefined));
    mocks.resolveClient.mockResolvedValueOnce({
      clientId: null,
      clientSecret: null,
      checks: [],
    });

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      /^approval_load_client_unavailable$/
    );
    // Only the user it created is removed again.
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    expect(mocks.fetchJson.mock.calls[1][2]).toMatchObject({ method: 'DELETE' });
    expect(mocks.adminCleanup).toHaveBeenCalledOnce();
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
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(204, undefined));

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      /^approval_load_artifact_unavailable$/
    );
    expect(mocks.fetchJson).toHaveBeenCalledTimes(4);
    expect(mocks.cleanupClient).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'temporary-client' })
    );
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

  /** Answers every request up to the subject token; `/token` answers come from `exchange`. */
  function bootstrapUntilExchange(exchange: () => unknown) {
    mocks.fetchJson.mockImplementation(
      async (url: string, _timeout: number, init?: globalThis.RequestInit) => {
        const path = new URL(url).pathname;
        if (path === '/api/admin/users') return jsonResponse(201, { user: { id: 'user-1' } });
        if (path === '/api/admin/approvals') {
          return jsonResponse(201, {
            public_request_id: 'request-1',
            approvals: [{ id: 'approval-1' }],
            notification_results: [
              { completion_artifact: { path: '/approval-artifacts/artifact-1/portal' } },
            ],
          });
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
        if (path === '/token') return exchange();
        if (path === '/userinfo/user-1') return jsonResponse(200, {});
        if (path === '/api/admin/users/user-1' && init?.method === 'DELETE') {
          return jsonResponse(204, undefined);
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
      }
    );
  }
  const refused = jsonResponse(400, { error: 'unsupported_grant_type' });
  const exchangeCalls = () =>
    mocks.fetchJson.mock.calls.filter(([url]) => String(url).endsWith('/token')).length;

  it('removes the user, the client and the temporary Token Exchange settings when setup fails', async () => {
    bootstrapUntilExchange(() => jsonResponse(500, { error: 'server_error' }));

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      /^approval_load_downstream_access_token_missing$/
    );
    expect(mocks.cleanupClient).toHaveBeenCalledOnce();
    expect(mocks.restoreTokenExchange).toHaveBeenCalledOnce();
    expect(mocks.adminCleanup).toHaveBeenCalledOnce();
    expect(
      mocks.fetchJson.mock.calls.some(
        ([url, , init]) => String(url).endsWith('/users/user-1') && init?.method === 'DELETE'
      )
    ).toBe(true);
  });

  it('stops before Token Exchange when its settings could not be prepared', async () => {
    bootstrapUntilExchange(() => jsonResponse(200, { access_token: 'access-token' }));
    mocks.enableTokenExchange.mockResolvedValueOnce({
      check: { id: 'token-settings', title: 'token settings', status: 'fail', details: [] },
      restore: mocks.restoreTokenExchange,
      changed: true,
    });

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      /^approval_load_token_exchange_settings_failed$/
    );
    expect(exchangeCalls()).toBe(0);
    expect(mocks.restoreTokenExchange).toHaveBeenCalledOnce();
  });

  it('names what could not be cleaned up after a failed setup', async () => {
    bootstrapUntilExchange(() => jsonResponse(500, { error: 'server_error' }));
    mocks.restoreTokenExchange.mockResolvedValueOnce({
      id: 'token-settings-restore',
      title: 'restore token settings',
      status: 'fail',
      details: ['tokens.exchange_enabled could not be restored'],
    });

    const failure = await createGeneratedApprovalLoadContext({ env: 'test' }).catch((e) => e);
    expect(failure.message).toBe(
      'approval_load_downstream_access_token_missing; cleanup incomplete: ' +
        'token-settings-restore: tokens.exchange_enabled could not be restored'
    );
    expect(failure.cause.message).toBe('approval_load_downstream_access_token_missing');
  });

  describe('when Token Exchange was just enabled', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      mocks.enableTokenExchange.mockResolvedValue({
        check: { id: 'token-settings', title: 'token settings', status: 'warn', details: [] },
        restore: mocks.restoreTokenExchange,
        changed: true,
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for runtime to accept the grant', async () => {
      let attempts = 0;
      bootstrapUntilExchange(() =>
        ++attempts < 3 ? refused : jsonResponse(200, { access_token: 'access-token' })
      );

      const promise = createGeneratedApprovalLoadContext({ env: 'test' });
      await vi.runAllTimersAsync();
      const context = await promise;

      expect(context.downstreamAccessToken).toBe('access-token');
      expect(exchangeCalls()).toBe(3);
      expect(mocks.restoreTokenExchange).not.toHaveBeenCalled();
    });

    it('still waits for the settings when the grant is refused after a rate limit', async () => {
      const answers = [
        jsonResponse(429, { error: 'rate_limited' }),
        refused,
        refused,
        jsonResponse(200, { access_token: 'access-token' }),
      ];
      bootstrapUntilExchange(() => answers.shift());

      const promise = createGeneratedApprovalLoadContext({ env: 'test' });
      await vi.runAllTimersAsync();
      const context = await promise;

      expect(context.downstreamAccessToken).toBe('access-token');
      expect(exchangeCalls()).toBe(4);
    });

    it('gives up after the wait and puts the settings back', async () => {
      bootstrapUntilExchange(() => refused);

      const promise = createGeneratedApprovalLoadContext({ env: 'test' });
      const outcome = expect(promise).rejects.toThrow(
        /^approval_load_downstream_access_token_missing$/
      );
      await vi.runAllTimersAsync();
      await outcome;

      // The attempt, then one every 5 seconds for 2 minutes.
      expect(exchangeCalls()).toBe(25);
      expect(mocks.restoreTokenExchange).toHaveBeenCalledOnce();
    });
  });

  it('does not wait when it did not change the settings', async () => {
    bootstrapUntilExchange(() => refused);

    await expect(createGeneratedApprovalLoadContext({ env: 'test' })).rejects.toThrow(
      'approval_load_downstream_access_token_missing'
    );
    expect(exchangeCalls()).toBe(1);
  });
});

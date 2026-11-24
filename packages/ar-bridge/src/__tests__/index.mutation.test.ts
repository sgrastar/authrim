import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import { RateLimitProfiles, type Env } from '@authrim/ar-lib-core';
import { callArg, rec } from './helpers/mock-args';

const m = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  moduleNames: [] as string[],
  rateLimit: [] as unknown[],
  adminAuth: [] as unknown[],
  health: [] as unknown[],
  diagnostic: [] as unknown[],
  cleanup: vi.fn(),
  refresh: vi.fn(),
  boom: { enabled: false },
  handlerModule: (names: string[]): Record<string, unknown> =>
    Object.fromEntries(
      names.map((name) => [
        name,
        vi.fn(
          async (c: { header: (k: string, v: string) => void; json: (b: unknown) => Response }) => {
            if (m.boom.enabled && name === 'handleListProviders')
              throw new Error('handler exploded');
            if (name === 'handleFrontchannelLogout') {
              c.header('X-Frame-Options', 'SAMEORIGIN');
              c.header('Content-Security-Policy', 'default-src *');
            }
            return c.json({ handler: name });
          }
        ),
      ])
    ),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const pass = async (_c: unknown, next: Next) => {
    await next();
  };
  return {
    ...actual,
    requestContextMiddleware: () => async (c: Context<{ Bindings: Env }>, next: Next) => {
      c.set('tenantId' as never, 'default');
      await next();
    },
    pluginContextMiddleware: () => async (c: Context<{ Bindings: Env }>, next: Next) => {
      c.header('X-Plugin', 'on');
      await next();
    },
    createHealthCheckHandlers: (options: unknown) => {
      m.health.push(options);
      return actual.createHealthCheckHandlers(options as never);
    },
    diagnosticLoggingMiddleware: (options: unknown) => {
      m.diagnostic.push(options);
      return async (c: Context<{ Bindings: Env }>, next: Next) => {
        c.header('X-Diagnostic', 'on');
        await next();
      };
    },
    rateLimitMiddleware: (options: unknown) => {
      m.rateLimit.push(options);
      return pass;
    },
    adminAuthMiddleware: (options: unknown) => {
      m.adminAuth.push(options);
      return pass;
    },
    getLogger: () => ({
      module: (name: string) => {
        m.moduleNames.push(name);
        return m.log;
      },
    }),
    createLogger: () => ({
      module: (name: string) => {
        m.moduleNames.push(name);
        return m.log;
      },
    }),
  };
});

vi.mock('../handlers/list', () => m.handlerModule(['handleListProviders']));
vi.mock('../handlers/start', () => m.handlerModule(['handleExternalStart']));
vi.mock('../handlers/initiate-login', () => m.handlerModule(['handleThirdPartyInitiatedLogin']));
vi.mock('../handlers/request-object', () => m.handlerModule(['handleRequestObject']));
vi.mock('../handlers/callback', () =>
  m.handlerModule([
    'handleExternalCallback',
    'handleExternalProvisioningResume',
    'handleExternalProvisioningStatus',
  ])
);
vi.mock('../handlers/backchannel-logout', () => m.handlerModule(['handleBackchannelLogout']));
vi.mock('../handlers/frontchannel-logout', () => m.handlerModule(['handleFrontchannelLogout']));
vi.mock('../handlers/facebook-data-deletion', () =>
  m.handlerModule([
    'handleFacebookDataDeletion',
    'handleFacebookDataDeletionStatus',
    'handleFacebookDeauthorize',
  ])
);
vi.mock('../handlers/rp-initiated-logout', () =>
  m.handlerModule(['handleRpInitiatedLogout', 'handleRpInitiatedLogoutCallback'])
);
vi.mock('../handlers/link', () =>
  m.handlerModule(['handleLinkIdentity', 'handleUnlinkIdentity', 'handleListLinkedIdentities'])
);
vi.mock('../handlers/handoff', () =>
  m.handlerModule(['handleHandoffFinalize', 'handleHandoffVerify'])
);
vi.mock('../admin/providers', () =>
  m.handlerModule([
    'handleAdminListProviders',
    'handleAdminCreateProvider',
    'handleAdminGetProvider',
    'handleAdminRegisterProvider',
    'handleAdminUpdateProvider',
    'handleAdminDeleteProvider',
  ])
);
vi.mock('../admin/token-refresh', () =>
  m.handlerModule([
    'handleAdminGetTokenRefreshConfig',
    'handleAdminListTokenRefreshRuns',
    'handleAdminRunTokenRefresh',
    'handleAdminUpdateTokenRefreshConfig',
  ])
);
vi.mock('../services/user-token-revocation', () => ({ revokeUserLinkedIdentityTokens: vi.fn() }));
vi.mock('../utils/state', () => ({ cleanupExpiredStates: m.cleanup }));
vi.mock('../services/token-refresh', () => ({
  refreshExpiringTokensForScheduledTenants: m.refresh,
}));

import worker, {
  EXTERNAL_IDP_ADMIN_AUDIENCE,
  ExternalIdpAdminEntrypoint,
  SAML_DR_WRITER_SURFACES,
} from '../index';

const ENV = { ISSUER_URL: 'https://op.example.com', ENABLE_RATE_LIMIT: 'false' } as unknown as Env;
const ctx = (props: unknown = {}) =>
  ({ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props }) as unknown as ExecutionContext;
const call = (path: string, init: RequestInit = {}, env: Env = ENV) =>
  Promise.resolve(worker.fetch(new Request(`https://op.example.com${path}`, init), env, ctx()));

beforeEach(() => {
  vi.clearAllMocks();
  m.boom.enabled = false;
  m.cleanup.mockReset().mockResolvedValue(3);
  m.refresh.mockReset().mockResolvedValue({
    selectedTenants: ['a', 'b'],
    processedTenants: 2,
    failedTenants: 0,
    tokensRefreshed: 5,
    cursor: 'b',
  });
});

const ROUTES: Array<[string, string, string]> = [
  ['GET', '/api/external/providers', 'handleListProviders'],
  ['GET', '/auth/external/providers', 'handleListProviders'],
  ['GET', '/api/external/google/start', 'handleExternalStart'],
  ['GET', '/auth/external/google/start', 'handleExternalStart'],
  ['GET', '/api/external/google/initiate-login', 'handleThirdPartyInitiatedLogin'],
  ['POST', '/api/external/google/initiate-login', 'handleThirdPartyInitiatedLogin'],
  ['GET', '/auth/external/google/initiate-login', 'handleThirdPartyInitiatedLogin'],
  ['POST', '/auth/external/google/initiate-login', 'handleThirdPartyInitiatedLogin'],
  ['GET', '/api/external/google/request-object', 'handleRequestObject'],
  ['GET', '/auth/external/google/request-object', 'handleRequestObject'],
  ['GET', '/api/external/google/callback', 'handleExternalCallback'],
  ['POST', '/api/external/google/callback', 'handleExternalCallback'],
  ['GET', '/auth/external/google/callback', 'handleExternalCallback'],
  ['POST', '/auth/external/google/callback', 'handleExternalCallback'],
  ['POST', '/api/external/provisioning/status', 'handleExternalProvisioningStatus'],
  ['POST', '/auth/external/provisioning/status', 'handleExternalProvisioningStatus'],
  ['GET', '/auth/external/provisioning/resume', 'handleExternalProvisioningResume'],
  ['POST', '/api/external/google/backchannel-logout', 'handleBackchannelLogout'],
  ['POST', '/auth/external/google/backchannel-logout', 'handleBackchannelLogout'],
  ['POST', '/api/external/google/data-deletion', 'handleFacebookDataDeletion'],
  ['POST', '/auth/external/google/data-deletion', 'handleFacebookDataDeletion'],
  ['GET', '/api/external/google/data-deletion/code1', 'handleFacebookDataDeletionStatus'],
  ['GET', '/auth/external/google/data-deletion/code1', 'handleFacebookDataDeletionStatus'],
  ['POST', '/api/external/google/deauthorize', 'handleFacebookDeauthorize'],
  ['POST', '/auth/external/google/deauthorize', 'handleFacebookDeauthorize'],
  ['GET', '/api/external/google/logout', 'handleRpInitiatedLogout'],
  ['GET', '/auth/external/google/logout', 'handleRpInitiatedLogout'],
  ['GET', '/api/external/google/logout/callback', 'handleRpInitiatedLogoutCallback'],
  ['GET', '/auth/external/google/logout/callback', 'handleRpInitiatedLogoutCallback'],
  ['GET', '/api/external/google/frontchannel-logout', 'handleFrontchannelLogout'],
  ['GET', '/auth/external/google/frontchannel-logout', 'handleFrontchannelLogout'],
  ['POST', '/handoff/verify', 'handleHandoffVerify'],
  ['POST', '/handoff/finalize', 'handleHandoffFinalize'],
  ['POST', '/auth/external/handoff/verify', 'handleHandoffVerify'],
  ['POST', '/api/external/handoff/verify', 'handleHandoffVerify'],
  ['POST', '/auth/external/handoff/finalize', 'handleHandoffFinalize'],
  ['POST', '/api/external/handoff/finalize', 'handleHandoffFinalize'],
  ['GET', '/api/external/links', 'handleListLinkedIdentities'],
  ['GET', '/auth/external/links', 'handleListLinkedIdentities'],
  ['POST', '/api/external/links', 'handleLinkIdentity'],
  ['POST', '/auth/external/links', 'handleLinkIdentity'],
  ['DELETE', '/api/external/links/l1', 'handleUnlinkIdentity'],
  ['DELETE', '/auth/external/links/l1', 'handleUnlinkIdentity'],
];

const ADMIN_ROUTES: Array<[string, string, string]> = [
  ['GET', '/api/admin/external-providers', 'handleAdminListProviders'],
  ['POST', '/api/admin/external-providers', 'handleAdminCreateProvider'],
  ['GET', '/api/admin/external-providers/p1', 'handleAdminGetProvider'],
  ['POST', '/api/admin/external-providers/p1/register', 'handleAdminRegisterProvider'],
  ['PUT', '/api/admin/external-providers/p1', 'handleAdminUpdateProvider'],
  ['DELETE', '/api/admin/external-providers/p1', 'handleAdminDeleteProvider'],
  ['GET', '/api/admin/external-token-refresh/config', 'handleAdminGetTokenRefreshConfig'],
  ['PUT', '/api/admin/external-token-refresh/config', 'handleAdminUpdateTokenRefreshConfig'],
  ['GET', '/api/admin/external-token-refresh/runs', 'handleAdminListTokenRefreshRuns'],
  ['POST', '/api/admin/external-token-refresh/run', 'handleAdminRunTokenRefresh'],
];

describe('routing', () => {
  it.each(ROUTES)('%s %s reaches %s', async (method, path, handler) => {
    const res = await call(path, { method });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handler });
  });

  it('does not answer a method a route does not take', async () => {
    for (const [method, path] of [
      ['POST', '/api/external/providers'],
      ['GET', '/api/external/google/backchannel-logout'],
      ['PUT', '/api/external/links'],
      ['GET', '/handoff/verify'],
    ] as const) {
      const res = await call(path, { method });
      expect(res.status).toBe(404);
    }
  });

  it('serves the admin routes only through the admin entrypoint, behind the tenant admin auth', async () => {
    const entry = new ExternalIdpAdminEntrypoint(
      ctx({
        caller: 'ar-management',
        audience: EXTERNAL_IDP_ADMIN_AUDIENCE,
        environmentId: 'env-1',
      }),
      { ...ENV, AUTHRIM_ENVIRONMENT_NAME: 'env-1' }
    );
    for (const [method, path, handler] of ADMIN_ROUTES) {
      const res = await entry.fetch(new Request(`https://external-idp${path}`, { method }));
      expect(await res.json()).toEqual({ handler });
    }
    expect(m.adminAuth).toEqual([{ plane: 'tenant' }]);
  });

  it('registers the middleware with their settings', () => {
    expect(m.rateLimit).toEqual([
      expect.objectContaining({
        endpoints: ['/api/external/*'],
        endpointClass: 'bridge_external',
      }),
    ]);
    expect(m.rateLimit[0]).toMatchObject(RateLimitProfiles.moderate);
    expect(m.diagnostic).toEqual([{}, {}]);
  });
});

describe('middleware scope', () => {
  it('captures diagnostics for the external routes only', async () => {
    for (const path of ['/api/external/providers', '/auth/external/providers']) {
      expect((await call(path)).headers.get('X-Diagnostic')).toBe('on');
    }
    for (const path of ['/api/health', '/health/live', '/handoff/verify']) {
      expect(
        (await call(path, { method: path === '/handoff/verify' ? 'POST' : 'GET' })).headers.get(
          'X-Diagnostic'
        )
      ).toBeNull();
    }
  });

  it('adds the plugin context to every route', async () => {
    for (const path of ['/api/health', '/api/external/providers', '/nothing']) {
      expect((await call(path)).headers.get('X-Plugin')).toBe('on');
    }
  });

  it('names the service and checks the database and KV in its health probes', () => {
    expect(m.health).toEqual([
      { serviceName: 'ar-bridge', version: '0.1.0', checkDatabase: true, checkKV: true },
    ]);
  });
});

describe('health', () => {
  it('reports the service on /api/health with a timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    try {
      const res = await call('/api/health');
      expect(await res.json()).toEqual({
        status: 'ok',
        service: 'ar-bridge',
        timestamp: '2026-01-02T03:04:05.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers the liveness probe', async () => {
    const res = await call('/health/live');
    expect(res.status).toBe(200);
    expect(rec(await res.json()).status).toBe('ok');
  });

  it('answers the readiness probe', async () => {
    const res = await call('/health/ready');
    expect(res.status).toBe(200);
    expect(rec(await res.json()).status).toBe('ready');
  });
});

describe('security headers', () => {
  it('sends the strict defaults', async () => {
    const res = await call('/api/external/providers');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'self'; frame-src 'none'"
    );
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload'
    );
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it.each([
    '/api/external/google/frontchannel-logout',
    '/auth/external/google/frontchannel-logout',
  ])('lets %s be framed by the upstream and nothing else', async (path) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors *"
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('does not loosen a path that merely contains the frontchannel segment', async () => {
    const res = await call('/api/external/google/frontchannel-logout/extra');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('CORS', () => {
  const preflight = (origin: string, env: Env = ENV) =>
    call(
      '/api/external/providers',
      {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      },
      env
    );

  it('echoes an allowed origin and allows credentials', async () => {
    const res = await call('/api/external/providers', {
      headers: { Origin: 'https://op.example.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://op.example.com');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe(
      'X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset'
    );
  });

  it('does not echo an origin that is not allowed', async () => {
    const res = await call('/api/external/providers', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeFalsy();
  });

  it('answers a request without an Origin with the tenant issuer', async () => {
    const res = await call('/api/external/providers');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://op.example.com');
  });

  it('takes the allowed origins from ALLOWED_ORIGINS before the issuer', async () => {
    const env = { ...ENV, ALLOWED_ORIGINS: 'https://app.example.com' } as unknown as Env;
    const res = await call(
      '/api/external/providers',
      { headers: { Origin: 'https://app.example.com' } },
      env
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    const denied = await call(
      '/api/external/providers',
      { headers: { Origin: 'https://op.example.com' } },
      env
    );
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeFalsy();
  });

  it('answers a preflight with the allowed methods, headers and age', async () => {
    const res = await preflight('https://op.example.com');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,DELETE,OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });
});

describe('error handling', () => {
  it('answers an unknown path with the not-found error', async () => {
    const res = await call('/nothing/here');
    expect(res.status).toBe(404);
  });

  it('answers a handler failure with a plain internal error and logs it', async () => {
    m.boom.enabled = true;
    const res = await call('/api/external/providers');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('handler exploded');
    expect(m.moduleNames).toContain('EXTERNAL-IDP');
    expect(m.log.error).toHaveBeenCalledWith(
      'External IdP Worker Error',
      { err: 'handler exploded' },
      expect.any(Error)
    );
  });
});

describe('scheduled maintenance', () => {
  const run = () => worker.scheduled({} as ScheduledController, ENV, ctx());

  it('cleans up the auth states, then refreshes the next tenant batch', async () => {
    await run();
    expect(m.cleanup).toHaveBeenCalledTimes(1);
    expect(callArg(m.cleanup, 0, 0)).toEqual(
      expect.objectContaining({ ISSUER_URL: ENV.ISSUER_URL })
    );
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(m.moduleNames).toContain('EXTERNAL-IDP');
    expect(m.log.info.mock.calls).toEqual([
      ['Running scheduled maintenance tasks...'],
      ['Cleaned up expired/consumed auth states', { statesDeleted: 3 }],
      [
        'Refreshed expiring tokens for scheduled tenant batch',
        {
          selected_tenants: 2,
          processed_tenants: 2,
          failed_tenants: 0,
          tokens_refreshed: 5,
          cursor: 'b',
        },
      ],
    ]);
  });

  it('logs a cleanup failure and still refreshes the tokens', async () => {
    m.cleanup.mockRejectedValue(new Error('cleanup down'));
    await expect(run()).resolves.toBeUndefined();
    expect(m.log.error).toHaveBeenCalledWith(
      'Auth state cleanup failed',
      {},
      expect.objectContaining({ message: 'cleanup down' })
    );
    expect(m.log.error).not.toHaveBeenCalledWith(
      'Scheduled maintenance failed',
      expect.anything(),
      expect.anything()
    );
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(m.log.info).toHaveBeenCalledWith(
      'Refreshed expiring tokens for scheduled tenant batch',
      expect.objectContaining({ tokens_refreshed: 5 })
    );
  });

  it('logs a refresh failure the same way', async () => {
    m.refresh.mockRejectedValue(new Error('refresh down'));
    await expect(run()).resolves.toBeUndefined();
    expect(m.log.error).toHaveBeenCalledWith('Scheduled maintenance failed', {}, expect.any(Error));
  });
});

describe('the admin entrypoint', () => {
  it('answers a caller that is not ar-management with a plain 403', async () => {
    const entry = new ExternalIdpAdminEntrypoint(
      ctx({ caller: 'ar-auth', audience: EXTERNAL_IDP_ADMIN_AUDIENCE, environmentId: 'env-1' }),
      { ...ENV, AUTHRIM_ENVIRONMENT_NAME: 'env-1' }
    );
    const res = await entry.fetch(new Request('https://external-idp/api/admin/external-providers'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'access_denied' });
  });
});

describe('exports', () => {
  it('names the surfaces the DR guard covers and the admin audience', () => {
    expect(SAML_DR_WRITER_SURFACES).toEqual([
      'fetch',
      'scheduled',
      'rpc:ExternalIdpAdminEntrypoint.fetch',
    ]);
    expect(EXTERNAL_IDP_ADMIN_AUDIENCE).toBe('authrim-external-idp-admin-v1');
  });

  it('refuses the admin prefix on the public fetch, before any routing', async () => {
    for (const path of [
      '/api/admin',
      '/api/admin/',
      '/API/ADMIN/x',
      '/api//admin/x',
      '/api/%41dmin/x',
    ]) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect(m.adminAuth).toEqual([{ plane: 'tenant' }]);
    const res = await call('/api/administrator');
    expect(await res.text()).not.toBe(JSON.stringify({ error: 'not_found' }));
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  DEFAULT_CLIENT,
  authorizeQuery,
  createAuthorizeApp,
  createMockEnv,
  redirectedError,
} from './helpers/mut-authorize-env';

const mockGetClient = vi.hoisted(() =>
  vi.fn<(env: unknown, clientId: string) => Promise<Record<string, unknown> | null>>()
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClient: mockGetClient,
    getClientCached: vi.fn((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    ),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { DB: unknown }, partition?: string) =>
        (
          actual as unknown as {
            ensureDatabaseAdapter: (db: unknown, partition?: string) => unknown;
          }
        ).ensureDatabaseAdapter(env.DB, partition)
    ),
  };
});

let app: Hono<{ Bindings: Env }>;
let env: Env;

function useClient(overrides: Record<string, unknown> = {}) {
  mockGetClient.mockResolvedValue({ ...DEFAULT_CLIENT, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  useClient();
  app = createAuthorizeApp();
  env = createMockEnv();
});

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  env.ENABLE_HTTPS_REQUEST_URI = 'true';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const REQUEST_URI = 'https://ro.example.net/request.jwt';

function streamed(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

async function byReference(requestUri = REQUEST_URI, overrides: Record<string, string> = {}) {
  return app.request(
    authorizeQuery({ request_uri: requestUri, ...overrides }),
    { method: 'GET' },
    env
  );
}

async function refused(response: Response, error: string, description: string) {
  expect(response.status).toBe(302);
  const { target, params } = redirectedError(response);
  expect(target).toBe('https://example.com/callback');
  expect(params.get('error')).toBe(error);
  expect(params.get('error_description')).toBe(description);
  expect(params.get('state')).toBe('test-state');
}

describe('authorize: request_uri scheme and availability', () => {
  it('refuses a request_uri that is neither a PAR URN nor https', async () => {
    env.ENABLE_HTTPS_REQUEST_URI = undefined;
    await refused(
      await byReference('http://ro.example.net/r'),
      'invalid_request',
      'request_uri must be either urn:ietf:params:oauth:request_uri: or https://'
    );
  });

  it('answers the request_uri error as JSON when the redirect cannot be trusted', async () => {
    const response = await app.request(
      `/authorize?request_uri=${encodeURIComponent('ftp://x')}&client_id=test-client`,
      { method: 'GET' },
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description:
        'request_uri must be either urn:ietf:params:oauth:request_uri: or https://',
    });
  });

  it('does not redirect the error to an http redirect_uri the tenant does not allow', async () => {
    delete (env as { HTTPS_REDIRECT_ONLY?: string }).HTTPS_REDIRECT_ONLY;
    const response = await byReference('ftp://x', {
      redirect_uri: 'http://localhost:3000/callback',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('redirects the error to a native app http loopback even when HTTPS only is on', async () => {
    delete (env as { HTTPS_REDIRECT_ONLY?: string }).HTTPS_REDIRECT_ONLY;
    useClient({ application_type: 'native' });
    const response = await byReference('ftp://x', {
      redirect_uri: 'http://localhost:3000/callback',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(/^http:\/\/localhost:3000\/callback\?error=/);
  });

  it('does not redirect the error for a client of another tenant', async () => {
    useClient({ tenant_id: 'other-tenant' });
    const response = await byReference('ftp://x');
    expect(response.status).toBe(400);
  });

  it.each([
    ['an unknown client', null],
    ['a client of another tenant', { ...DEFAULT_CLIENT, tenant_id: 'other' }],
  ])('refuses HTTPS request_uri for %s without fetching', async (_label, client) => {
    mockGetClient.mockResolvedValue(client);
    const response = await byReference();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'request_uri_not_supported',
      error_description: 'HTTPS request_uri is not available for this client',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a client whose tenant_id is empty or the request tenant', async () => {
    for (const tenant_id of ['', 'default']) {
      useClient({ tenant_id });
      fetchMock.mockResolvedValueOnce(streamed(['not-a-jwt']));
      const response = await byReference();
      expect(await response.json()).toEqual({
        error: 'invalid_request_object',
        error_description: 'Request object must be a valid JWT or JWE',
      });
    }
  });

  it('is refused when ENABLE_HTTPS_REQUEST_URI is anything but true', async () => {
    env.ENABLE_HTTPS_REQUEST_URI = 'yes';
    await refused(
      await byReference(),
      'request_uri_not_supported',
      'HTTPS request_uri is disabled. Use PAR (RFC 9126) with urn:ietf:params:oauth:request_uri: format instead.'
    );
  });

  it('fails closed when the request_uri settings cannot be read', async () => {
    await env.SETTINGS!.put('settings:tenant:default:oauth', '{');
    await refused(
      await byReference(),
      'temporarily_unavailable',
      'HTTPS request_uri settings are unavailable; use PAR or try again later'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('authorize: fetching an HTTPS request_uri', () => {
  it('matches the env allowlist case- and space-insensitively', async () => {
    env.HTTPS_REQUEST_URI_ALLOWED_DOMAINS = 'other.example, EXAMPLE.NET ';
    fetchMock.mockResolvedValueOnce(streamed(['x']));
    const response = await byReference();
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a host outside the env allowlist', async () => {
    env.HTTPS_REQUEST_URI_ALLOWED_DOMAINS = 'other.example';
    await refused(
      await byReference(),
      'invalid_request_uri',
      'request_uri domain is not in the allowed list'
    );
  });

  it('refuses an internal address', async () => {
    await refused(
      await byReference('https://127.0.0.1/r'),
      'invalid_request_uri',
      'request_uri cannot point to internal addresses'
    );
  });

  it('decodes a body read in several chunks', async () => {
    fetchMock.mockResolvedValueOnce(streamed(['not-', 'a-', 'jwt']));
    const response = await byReference();
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe('invalid_request_object');
  });

  it('accepts a body of exactly the size limit and refuses one byte more', async () => {
    env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES = '10';
    fetchMock.mockResolvedValueOnce(streamed(['0123456789']));
    const atLimit = await byReference();
    expect((await atLimit.json<{ error: string }>()).error).toBe('invalid_request_object');

    fetchMock.mockResolvedValueOnce(streamed(['01234', '567890']));
    await refused(
      await byReference(),
      'invalid_request_uri',
      'Response too large: exceeds limit of 10 bytes'
    );
  });

  it('refuses a Content-Length over the limit', async () => {
    env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES = '10';
    fetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200, headers: { 'Content-Length': '11' } })
    );
    await refused(
      await byReference(),
      'invalid_request_uri',
      'Response too large: exceeds limit of 10 bytes'
    );
  });

  it('refuses a response that is not ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await refused(
      await byReference(),
      'invalid_request_uri',
      'Failed to fetch request object from request_uri'
    );
  });

  it('refuses a response without a body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await refused(await byReference(), 'invalid_request_uri', 'Failed to read response body');
  });

  it('reports a timeout with the configured timeout', async () => {
    env.HTTPS_REQUEST_URI_TIMEOUT_MS = '1234';
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await refused(await byReference(), 'invalid_request_uri', 'Request timed out after 1234ms');
  });

  it('reports any other fetch failure generically', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    await refused(
      await byReference(),
      'invalid_request_uri',
      'Failed to fetch request object from request_uri'
    );
  });

  describe('redirects', () => {
    const redirect = (location?: string, status = 302) =>
      new Response(null, { status, headers: location ? { Location: location } : {} });

    it.each([301, 303, 307, 308])('follows a %s redirect', async (status) => {
      fetchMock
        .mockResolvedValueOnce(redirect('/moved.jwt', status))
        .mockResolvedValueOnce(streamed(['x']));
      await byReference();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('https://ro.example.net/moved.jwt');
    });

    it('follows up to five redirects and refuses the sixth', async () => {
      for (let i = 0; i < 5; i++) fetchMock.mockResolvedValueOnce(redirect(`/hop${i}`));
      fetchMock.mockResolvedValueOnce(streamed(['x']));
      const followed = await byReference();
      expect(followed.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(6);

      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => redirect('/again'));
      await refused(
        await byReference(),
        'invalid_request_uri',
        'request_uri exceeded maximum redirect depth'
      );
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('refuses a redirect without Location', async () => {
      fetchMock.mockResolvedValueOnce(redirect());
      await refused(
        await byReference(),
        'invalid_request_uri',
        'request_uri redirect response is missing Location header'
      );
    });

    it('refuses a redirect to http', async () => {
      fetchMock.mockResolvedValueOnce(redirect('http://ro.example.net/r'));
      await refused(
        await byReference(),
        'invalid_request_uri',
        'request_uri redirect target must use HTTPS'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses an unparseable redirect target', async () => {
      fetchMock.mockResolvedValueOnce(redirect('https://[broken'));
      await refused(
        await byReference(),
        'invalid_request_uri',
        'request_uri redirect target is invalid'
      );
    });

    it('requires a redirect target to match one allowed domain, not all', async () => {
      env.HTTPS_REQUEST_URI_ALLOWED_DOMAINS = 'example.net,cdn.example.org';
      fetchMock
        .mockResolvedValueOnce(redirect('https://cdn.example.org/r'))
        .mockResolvedValueOnce(streamed(['x']));
      const response = await byReference();
      expect(response.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

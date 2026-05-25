import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureLoginUiClient } from '../core/login-ui-client.js';
import { buildBrowserClientMetadata } from '../core/browser-client-metadata.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ensureLoginUiClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let tempDir = '';
  let adminApiSecretPath = '';

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();

    const testTempRoot = join(process.cwd(), '.tmp-tests');
    await mkdir(testTempRoot, { recursive: true });
    tempDir = await mkdtemp(join(testTempRoot, 'authrim-login-ui-client-'));
    adminApiSecretPath = join(tempDir, 'admin_api_secret.txt');
    await writeFile(adminApiSecretPath, 'secret-token');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('retries when the router is not yet reachable on workers.dev', async () => {
    const progress: string[] = [];

    fetchMock
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            error_code: 1042,
            error_name: 'workers_dev_script_not_found',
            detail: 'No Workers script was found for this host on workers.dev.',
          }),
          404
        )
      )
      .mockResolvedValueOnce(jsonResponse({ clients: [], pagination: { total: 0 } }))
      .mockResolvedValueOnce(
        jsonResponse({
          client: {
            client_id: 'client-123',
            client_name: 'Login UI',
          },
        })
      );

    const resultPromise = ensureLoginUiClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      loginUiUrl: 'https://single-ar-login-ui.workers.dev',
      adminApiSecretPath,
      onProgress: (message) => progress.push(message),
      retryDelayMs: 1,
      maxRetries: 2,
    });

    const result = await resultPromise;

    expect(result).toEqual({
      success: true,
      clientId: 'client-123',
      alreadyExists: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(progress.some((message) => message.includes('Retrying in'))).toBe(true);
  });

  it('sends X-Tenant-Id for tenant-scoped admin APIs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ clients: [], pagination: { total: 0 } }))
      .mockResolvedValueOnce(
        jsonResponse({
          client: {
            client_id: 'client-tenant',
            client_name: 'Login UI',
          },
        })
      );

    const result = await ensureLoginUiClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      loginUiUrl: 'https://single-ar-login-ui.workers.dev',
      adminApiSecretPath,
      tenantId: 'default',
      maxRetries: 1,
    });

    expect(result.success).toBe(true);
    const firstCallHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondCallHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstCallHeaders['X-Tenant-Id']).toBe('default');
    expect(secondCallHeaders['X-Tenant-Id']).toBe('default');
  });

  it('prefers setup machine private_key_jwt over legacy admin API secret', async () => {
    const secrets = generateAllSecrets('login-ui-test-key');
    await saveKeysToDirectory(secrets, { targetDir: tempDir });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'machine-admin-token',
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'admin:clients:*',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ clients: [], pagination: { total: 0 } }))
      .mockResolvedValueOnce(
        jsonResponse({
          client: {
            client_id: 'client-machine',
            client_name: 'Login UI',
          },
        })
      );

    const result = await ensureLoginUiClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      loginUiUrl: 'https://single-ar-login-ui.workers.dev',
      adminApiSecretPath,
      tenantId: 'default',
      maxRetries: 1,
    });

    expect(result).toEqual({
      success: true,
      clientId: 'client-machine',
      alreadyExists: false,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://single-ar-router.example.workers.dev/token'
    );

    const tokenBody = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    );

    const listHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    const createHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(listHeaders.Authorization).toBe('Bearer machine-admin-token');
    expect(createHeaders.Authorization).toBe('Bearer machine-admin-token');
  });

  it('retries setup machine token acquisition while workers.dev router is propagating', async () => {
    const secrets = generateAllSecrets('login-ui-test-key');
    await saveKeysToDirectory(secrets, { targetDir: tempDir });
    const progress: string[] = [];

    fetchMock
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            error_code: 1042,
            error_name: 'workers_dev_script_not_found',
            detail: 'No Workers script was found for this host on workers.dev.',
          }),
          404
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'machine-admin-token',
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'admin:clients:*',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ clients: [], pagination: { total: 0 } }))
      .mockResolvedValueOnce(
        jsonResponse({
          client: {
            client_id: 'client-machine-after-retry',
            client_name: 'Login UI',
          },
        })
      );

    const result = await ensureLoginUiClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      loginUiUrl: 'https://single-ar-login-ui.workers.dev',
      adminApiSecretPath,
      tenantId: 'default',
      onProgress: (message) => progress.push(message),
      retryDelayMs: 1,
      maxRetries: 2,
    });

    expect(result).toEqual({
      success: true,
      clientId: 'client-machine-after-retry',
      alreadyExists: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(progress.some((message) => message.includes('Retrying in'))).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://single-ar-router.example.workers.dev/token'
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://single-ar-router.example.workers.dev/token'
    );
  });

  it('creates the built-in Login UI client with browser refresh tokens disabled', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ clients: [], pagination: { total: 0 } }))
      .mockResolvedValueOnce(
        jsonResponse({
          client: {
            client_id: 'client-login-ui',
            client_name: 'Login UI',
          },
        })
      );

    await ensureLoginUiClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      loginUiUrl: 'https://login.example.test',
      adminApiSecretPath,
      maxRetries: 1,
    });

    const createBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(createBody).toMatchObject({
      description: 'System-managed public OAuth client used by the built-in Authrim Login UI.',
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      browser_public_client_mode: 'cookie_fallback',
      browser_refresh_token_policy: 'disabled',
      web_origin_registry: {
        origins: [
          {
            origin: 'https://login.example.test',
            cors: { allowed: true },
            handoff_allowed: true,
            iframe_allowed: false,
          },
        ],
      },
    });
    expect(createBody).not.toHaveProperty('dpop_bound_access_tokens');
  });

  it('builds token_session browser client metadata with DPoP-bound refresh token opt-in', () => {
    expect(
      buildBrowserClientMetadata({
        clientName: 'Browser Token App',
        redirectUris: ['https://app.example.test/callback'],
        allowedRedirectOrigins: ['https://app.example.test'],
        sessionProfile: 'token_session',
      })
    ).toMatchObject({
      client_name: 'Browser Token App',
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      browser_public_client_mode: 'strict',
      browser_refresh_token_policy: 'dpop_bound',
      dpop_bound_access_tokens: true,
      allowed_redirect_origins: ['https://app.example.test'],
      web_origin_registry: {
        origins: [
          {
            origin: 'https://app.example.test',
            cors: { allowed: true },
            handoff_allowed: true,
            iframe_allowed: false,
          },
        ],
      },
    });
  });
});

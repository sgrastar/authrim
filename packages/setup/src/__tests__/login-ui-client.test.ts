import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureLoginUiClient } from '../core/login-ui-client.js';

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

    tempDir = await mkdtemp(join(tmpdir(), 'authrim-login-ui-client-'));
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
      loginUiUrl: 'https://single-ar-login-ui.pages.dev',
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
});

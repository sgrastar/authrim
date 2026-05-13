import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDownstreamIntrospectionClient } from '../core/downstream-introspection-client.js';

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

describe('ensureDownstreamIntrospectionClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let tempDir = '';
  let adminApiSecretPath = '';

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();

    tempDir = await mkdtemp(join(tmpdir(), 'authrim-downstream-introspection-client-'));
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
        jsonResponse(
          {
            client: {
              client_id: 'downstream-client-1',
              client_name: 'Downstream Grant Introspection',
              client_secret: 'downstream-secret-1',
            },
          },
          201
        )
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      adminApiSecretPath,
      keysDir: tempDir,
      tenantId: 'default',
      onProgress: (message) => progress.push(message),
      retryDelayMs: 1,
      maxRetries: 2,
    });

    expect(result.success).toBe(true);
    expect(progress.some((message) => message.includes('Retrying in'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(readFile(join(tempDir, 'downstream_grant_introspection_client_id.txt'), 'utf-8')).resolves.toContain('downstream-client-1');
    await expect(readFile(join(tempDir, 'downstream_grant_introspection_client_secret.txt'), 'utf-8')).resolves.toContain('downstream-secret-1');
  });

  it('sends X-Tenant-Id for tenant-scoped admin APIs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ clients: [], pagination: { total: 0 } }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            client: {
              client_id: 'downstream-client-tenant',
              client_name: 'Downstream Grant Introspection',
              client_secret: 'downstream-secret-tenant',
            },
          },
          201
        )
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      adminApiSecretPath,
      keysDir: tempDir,
      tenantId: 'default',
      maxRetries: 1,
    });

    expect(result.success).toBe(true);
    const firstCallHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondCallHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    const createBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(firstCallHeaders['X-Tenant-Id']).toBe('default');
    expect(secondCallHeaders['X-Tenant-Id']).toBe('default');
    expect(createBody.description).toBe(
      'System-managed confidential client used by Authrim for downstream grant introspection.'
    );
  });
});

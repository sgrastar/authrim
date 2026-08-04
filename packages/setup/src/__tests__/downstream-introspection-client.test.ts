import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureDownstreamIntrospectionClient,
  loadDownstreamIntrospectionClientSecrets,
} from '../core/downstream-introspection-client.js';
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

describe('ensureDownstreamIntrospectionClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let tempDir = '';
  let adminBearerToken = '';

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();

    const testTempRoot = join(process.cwd(), '.tmp-tests');
    await mkdir(testTempRoot, { recursive: true });
    tempDir = await mkdtemp(join(testTempRoot, 'authrim-downstream-introspection-client-'));
    adminBearerToken = 'secret-token';
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
      adminBearerToken,
      keysDir: tempDir,
      tenantId: 'default',
      onProgress: (message) => progress.push(message),
      retryDelayMs: 1,
      maxRetries: 2,
    });

    expect(result.success).toBe(true);
    expect(progress.some((message) => message.includes('Retrying in'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(
      readFile(join(tempDir, 'downstream_grant_introspection_client_id.txt'), 'utf-8')
    ).resolves.toContain('downstream-client-1');
    await expect(
      readFile(join(tempDir, 'downstream_grant_introspection_client_secret.txt'), 'utf-8')
    ).resolves.toContain('downstream-secret-1');
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
      adminBearerToken,
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
    expect(secondCallHeaders['Idempotency-Key']).toMatch(
      /^setup-downstream-client-[A-Za-z0-9_-]+$/u
    );
    expect(createBody.description).toBe(
      'System-managed confidential client used by Authrim for downstream grant introspection.'
    );
  });

  it('retries setup machine token acquisition while workers.dev router is propagating', async () => {
    const secrets = generateAllSecrets('downstream-introspection-test-key');
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
        jsonResponse(
          {
            client: {
              client_id: 'downstream-client-after-retry',
              client_name: 'Downstream Grant Introspection',
              client_secret: 'downstream-secret-after-retry',
            },
          },
          201
        )
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      keysDir: tempDir,
      tenantId: 'default',
      onProgress: (message) => progress.push(message),
      retryDelayMs: 1,
      maxRetries: 2,
    });

    expect(result.success).toBe(true);
    expect(result.clientId).toBe('downstream-client-after-retry');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(progress.some((message) => message.includes('Retrying in'))).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://single-ar-router.example.workers.dev/token'
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://single-ar-router.example.workers.dev/token'
    );
  });

  it('retries setup machine token acquisition while tenant routes are propagating', async () => {
    const secrets = generateAllSecrets('downstream-introspection-test-key');
    await saveKeysToDirectory(secrets, { targetDir: tempDir });
    const progress: string[] = [];

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: 'not_found', error_description: 'Tenant not found' }, 404)
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
        jsonResponse(
          {
            client: {
              client_id: 'downstream-client-after-tenant-retry',
              client_name: 'Downstream Grant Introspection',
              client_secret: 'downstream-secret-after-tenant-retry',
            },
          },
          201
        )
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://first.multi-tenant.authrim.com',
      keysDir: tempDir,
      tenantId: 'first',
      onProgress: (message) => progress.push(message),
      retryDelayMs: 1,
      maxRetries: 2,
    });

    expect(result.success).toBe(true);
    expect(result.clientId).toBe('downstream-client-after-tenant-retry');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(progress.some((message) => message.includes('Retrying in'))).toBe(true);
  });

  it('reuses stored credentials when the corresponding client still exists', async () => {
    await writeFile(join(tempDir, 'downstream_grant_introspection_client_id.txt'), 'client-1\n');
    await writeFile(
      join(tempDir, 'downstream_grant_introspection_client_secret.txt'),
      'secret-1\n'
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ client_id: 'client-1' }));

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://issuer.test',
      adminBearerToken,
      keysDir: tempDir,
      maxRetries: 1,
    });

    expect(result).toEqual({
      success: true,
      clientId: 'client-1',
      clientSecret: 'secret-1',
      alreadyExists: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('updates metadata and rotates the secret for a discovered system client', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          clients: [
            {
              client_id: 'existing-client',
              client_name: 'Downstream Grant Introspection',
              description: 'old description',
            },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ client_id: 'existing-client', client_secret: 'rotated-secret' })
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://issuer.test',
      adminBearerToken,
      keysDir: tempDir,
      maxRetries: 1,
    });

    expect(result).toMatchObject({
      success: true,
      clientId: 'existing-client',
      clientSecret: 'rotated-secret',
      alreadyExists: true,
      rotatedSecret: true,
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PUT', 'POST']);
  });

  it('restricts generated credentials even when replacing permissive files', async () => {
    const clientIdPath = join(tempDir, 'downstream_grant_introspection_client_id.txt');
    const clientSecretPath = join(tempDir, 'downstream_grant_introspection_client_secret.txt');
    await chmod(tempDir, 0o755);
    await writeFile(clientIdPath, 'old-client\n', { mode: 0o644 });
    await writeFile(clientSecretPath, 'old-secret\n', { mode: 0o644 });

    fetchMock
      .mockResolvedValueOnce(textResponse('not found', 404))
      .mockResolvedValueOnce(jsonResponse({ clients: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            client: {
              client_id: 'replacement-client',
              client_name: 'Downstream Grant Introspection',
              client_secret: 'replacement-secret',
            },
          },
          201
        )
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://issuer.test',
      adminBearerToken,
      keysDir: tempDir,
      maxRetries: 1,
    });

    expect(result.success).toBe(true);
    expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
    expect((await stat(clientIdPath)).mode & 0o777).toBe(0o600);
    expect((await stat(clientSecretPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(clientSecretPath, 'utf-8')).toBe('replacement-secret\n');
  });

  it('returns explicit failures for missing machine keys and non-retryable API errors', async () => {
    await expect(
      ensureDownstreamIntrospectionClient({
        apiBaseUrl: 'https://issuer.test',
        keysDir: tempDir,
        maxRetries: 1,
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('keys not found') });

    fetchMock.mockResolvedValueOnce(textResponse('forbidden', 403));
    await expect(
      ensureDownstreamIntrospectionClient({
        apiBaseUrl: 'https://issuer.test',
        adminBearerToken,
        keysDir: tempDir,
        maxRetries: 1,
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Failed to check downstream introspection client (403)'),
    });
  });

  it('loads deployable secrets only when both files contain values', async () => {
    await expect(loadDownstreamIntrospectionClientSecrets(tempDir)).resolves.toBeNull();
    await writeFile(join(tempDir, 'downstream_grant_introspection_client_id.txt'), 'client-1\n');
    await expect(loadDownstreamIntrospectionClientSecrets(tempDir)).resolves.toBeNull();
    await writeFile(join(tempDir, 'downstream_grant_introspection_client_secret.txt'), '  ');
    await expect(loadDownstreamIntrospectionClientSecrets(tempDir)).resolves.toBeNull();
    await writeFile(
      join(tempDir, 'downstream_grant_introspection_client_secret.txt'),
      'secret-1\n'
    );
    await expect(loadDownstreamIntrospectionClientSecrets(tempDir)).resolves.toEqual({
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-1',
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-1',
    });
  });

  it('rotates an existing correctly-described client without an unnecessary update', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          clients: [
            {
              client_id: 'existing-client',
              client_name: 'Downstream Grant Introspection',
              description:
                'System-managed confidential client used by Authrim for downstream grant introspection.',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ client_id: 'existing-client', client_secret: 'rotated-secret' })
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://issuer.test',
      adminBearerToken,
      keysDir: tempDir,
      maxRetries: 1,
    });

    expect(result).toMatchObject({ success: true, rotatedSecret: true });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST']);
  });

  it('replaces stale stored credentials when the referenced client was deleted', async () => {
    await writeFile(join(tempDir, 'downstream_grant_introspection_client_id.txt'), 'stale-client');
    await writeFile(
      join(tempDir, 'downstream_grant_introspection_client_secret.txt'),
      'stale-secret'
    );
    fetchMock
      .mockResolvedValueOnce(textResponse('not found', 404))
      .mockResolvedValueOnce(jsonResponse({ clients: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            client: {
              client_id: 'replacement-client',
              client_name: 'Downstream Grant Introspection',
              client_secret: 'replacement-secret',
            },
          },
          201
        )
      );

    const result = await ensureDownstreamIntrospectionClient({
      apiBaseUrl: 'https://issuer.test',
      adminBearerToken,
      keysDir: tempDir,
      maxRetries: 1,
    });

    expect(result).toMatchObject({
      success: true,
      clientId: 'replacement-client',
      alreadyExists: false,
      rotatedSecret: false,
    });
  });

  it('rejects successful API responses that omit generated credentials', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ clients: [] }))
      .mockResolvedValueOnce(jsonResponse({ client: { client_id: 'missing-secret' } }, 201));

    await expect(
      ensureDownstreamIntrospectionClient({
        apiBaseUrl: 'https://issuer.test',
        adminBearerToken,
        keysDir: tempDir,
        maxRetries: 1,
      })
    ).resolves.toMatchObject({
      success: false,
      error: 'Downstream introspection client create response missing credentials',
    });
  });
});

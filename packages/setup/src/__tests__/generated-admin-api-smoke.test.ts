import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDefaultConfig } from '../core/config.js';
import { runGeneratedAdminApiSmoke } from '../core/generated-admin-api-smoke.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';

vi.mock('execa', () => ({
  execa: vi.fn(async () => ({ stdout: '', stderr: '', all: '', exitCode: 0 })),
}));

describe('generated admin api smoke', () => {
  let baseDir = '';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (baseDir) {
      await rm(baseDir, { recursive: true, force: true });
      baseDir = '';
    }
  });

  it('runs admin smoke against a generated environment with setup machine access', async () => {
    const testTempRoot = join(process.cwd(), '.tmp-tests');
    await mkdir(testTempRoot, { recursive: true });
    baseDir = await mkdtemp(join(testTempRoot, 'authrim-admin-smoke-'));
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
    await saveKeysToDirectory(generateAllSecrets('admin-smoke-setup-key'), { targetDir: keysDir });

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'machine-admin-token',
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'admin:clients:*',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ stats: { users: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ clients: [], pagination: { total: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          client: {
            client_id: 'client-1',
            client_secret: 'secret-1',
            client_name: 'Generated Admin Smoke Client',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ client: { client_id: 'client-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          client: {
            client_id: 'client-1',
            description: 'Generated environment validation smoke 123',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    vi.spyOn(Date, 'now').mockReturnValue(123);

    const result = await runGeneratedAdminApiSmoke({ baseDir, env });

    expect(result.ok).toBe(true);
    expect(result.adminSecretPath).toContain('temporary validation machine access');
    expect(result.checks.map((check) => check.id)).toEqual([
      'admin-stats',
      'admin-clients-list',
      'admin-client-create',
      'admin-client-get',
      'admin-client-update',
      'admin-client-delete',
    ]);

    const tokenCall = fetchMock.mock.calls[0];
    expect(String(tokenCall?.[0])).toBe('https://single-ar-router.example.workers.dev/token');
    const tokenForm = new URLSearchParams(String(tokenCall?.[1]?.body ?? ''));
    expect(tokenForm.get('grant_type')).toBe('client_credentials');
    expect(tokenForm.get('client_id')).toMatch(/^authrim-validation-/);
    expect(tokenForm.get('audience')).toBe('authrim:admin-api');
    expect(tokenForm.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    );

    const firstAdminHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstAdminHeaders.authorization).toBe('Bearer machine-admin-token');
    const createHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>;
    expect(createHeaders['Idempotency-Key']).toBe('setup-admin-smoke-client-123');
  });
});

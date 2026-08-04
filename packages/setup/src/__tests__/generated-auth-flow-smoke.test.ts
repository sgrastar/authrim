import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDefaultConfig } from '../core/config.js';
import { runGeneratedAuthFlowSmoke } from '../core/generated-auth-flow-smoke.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';

vi.mock('execa', () => ({
  execa: vi.fn(async () => ({ stdout: '', stderr: '', all: '', exitCode: 0 })),
}));

async function createGeneratedEnv(grantTypes: string[]) {
  const testTempRoot = join(process.cwd(), '.tmp-tests');
  await mkdir(testTempRoot, { recursive: true });
  const baseDir = await mkdtemp(join(testTempRoot, 'authrim-auth-smoke-'));
  const env = 'single';
  const envDir = join(baseDir, '.authrim', env);
  const keysDir = join(baseDir, '.authrim-keys', env);
  await mkdir(envDir, { recursive: true });
  await mkdir(keysDir, { recursive: true });

  const config = createDefaultConfig(env);
  config.oidc.grantTypes = grantTypes;
  config.urls = {
    api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
    loginUi: { custom: null, auto: 'https://single-login.workers.dev', sameAsApi: false },
    adminUi: { custom: null, auto: 'https://single-admin.workers.dev', sameAsApi: false },
  };

  await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
  await saveKeysToDirectory(generateAllSecrets('auth-flow-setup-key'), { targetDir: keysDir });

  return { baseDir, env };
}

function mockSetupMachineToken(fetchMock: ReturnType<typeof vi.fn>) {
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
}

function mockAdminClientLifecycle(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        client: {
          client_id: 'client-1',
          client_secret: 'secret-1',
          client_name: 'Generated Auth Flow Smoke Client',
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
  fetchMock.mockImplementationOnce(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { client_name?: string };
    return new Response(
      JSON.stringify({ client: { client_id: 'client-1', client_name: body.client_name } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  });
}

describe('generated auth flow smoke', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs admin-client + client_credentials smoke against a generated environment', async () => {
    const { baseDir, env } = await createGeneratedEnv([
      'authorization_code',
      'refresh_token',
      'client_credentials',
    ]);

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    mockSetupMachineToken(fetchMock);
    mockAdminClientLifecycle(fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-1', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ revoked: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await runGeneratedAuthFlowSmoke({ baseDir, env });

    expect(result.ok).toBe(true);
    expect(result.clientId).toBe('client-1');
    expect(result.checks.map((check) => check.id)).toContain('token-introspect-after-revoke');
    const createHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(createHeaders['Idempotency-Key']).toMatch(/^setup-auth-flow-smoke-client-\d+$/u);
  });

  it('downgrades client_credentials unsupported response to warning in auto mode', async () => {
    const { baseDir, env } = await createGeneratedEnv([
      'authorization_code',
      'refresh_token',
      'client_credentials',
    ]);

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    mockSetupMachineToken(fetchMock);
    mockAdminClientLifecycle(fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'unsupported_grant_type',
          error_description: 'disabled',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await runGeneratedAuthFlowSmoke({ baseDir, env, clientCredentialsMode: 'auto' });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === 'client-credentials-token')?.status).toBe(
      'warn'
    );
  });
});

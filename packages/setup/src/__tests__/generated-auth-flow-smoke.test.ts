import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultConfig } from '../core/config.js';
import { runGeneratedAuthFlowSmoke } from '../core/generated-auth-flow-smoke.js';

describe('generated auth flow smoke', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs dcr + client_credentials smoke against a generated environment', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-auth-smoke-'));
    const env = 'single';
    const envDir = join(baseDir, '.authrim', env);
    const keysDir = join(baseDir, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    await mkdir(keysDir, { recursive: true });

    const config = createDefaultConfig(env);
    config.oidc.grantTypes = ['authorization_code', 'refresh_token', 'client_credentials'];
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.pages.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.pages.dev', sameAsApi: false },
    };

    await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(keysDir, 'admin_api_secret.txt'), 'admin-secret');

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    let updatedClientName = '';

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v1',
          values: { 'dcr.enabled': false },
          sources: { 'dcr.enabled': 'default' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v2',
          applied: ['dcr.enabled'],
          rejected: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'iat-1', tokenHash: 'iat-hash-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          client_id: 'client-1',
          client_secret: 'secret-1',
          registration_access_token: 'rat-1',
          registration_client_uri: 'https://single-ar-router.example.workers.dev/clients/client-1',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ client_id: 'client-1', client_name: 'Portability Smoke' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { client_name?: string };
      updatedClientName = body.client_name ?? '';
      return new Response(JSON.stringify({ client_id: 'client-1', client_name: updatedClientName }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
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
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v2',
          values: { 'dcr.enabled': true },
          sources: { 'dcr.enabled': 'kv' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v3',
          applied: [],
          rejected: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    const result = await runGeneratedAuthFlowSmoke({ baseDir, env });

    expect(result.ok).toBe(true);
    expect(result.clientId).toBe('client-1');
    expect(result.checks.map((check) => check.id)).toContain('token-introspect-after-revoke');
  });

  it('downgrades client_credentials unsupported response to warning in auto mode', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-auth-smoke-'));
    const env = 'single';
    const envDir = join(baseDir, '.authrim', env);
    const keysDir = join(baseDir, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    await mkdir(keysDir, { recursive: true });

    const config = createDefaultConfig(env);
    config.oidc.grantTypes = ['authorization_code', 'refresh_token', 'client_credentials'];
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.pages.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.pages.dev', sameAsApi: false },
    };

    await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(keysDir, 'admin_api_secret.txt'), 'admin-secret');

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    let updatedClientName = '';

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v1',
          values: { 'dcr.enabled': false },
          sources: { 'dcr.enabled': 'default' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v2',
          applied: ['dcr.enabled'],
          rejected: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'iat-1', tokenHash: 'iat-hash-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          client_id: 'client-1',
          client_secret: 'secret-1',
          registration_access_token: 'rat-1',
          registration_client_uri: 'https://single-ar-router.example.workers.dev/clients/client-1',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ client_id: 'client-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { client_name?: string };
      updatedClientName = body.client_name ?? '';
      return new Response(JSON.stringify({ client_id: 'client-1', client_name: updatedClientName }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'unsupported_grant_type',
          error_description: 'disabled',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v2',
          values: { 'dcr.enabled': true },
          sources: { 'dcr.enabled': 'kv' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'sha256:dcr-v3',
          applied: [],
          rejected: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    const result = await runGeneratedAuthFlowSmoke({ baseDir, env, clientCredentialsMode: 'auto' });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === 'client-credentials-token')?.status).toBe(
      'warn'
    );
  });
});

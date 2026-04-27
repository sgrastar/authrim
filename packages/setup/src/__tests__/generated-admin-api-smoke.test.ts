import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultConfig } from '../core/config.js';
import { runGeneratedAdminApiSmoke } from '../core/generated-admin-api-smoke.js';

describe('generated admin api smoke', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs admin smoke against a generated environment', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-admin-smoke-'));
    const env = 'single';
    const envDir = join(baseDir, '.authrim', env);
    const keysDir = join(baseDir, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    await mkdir(keysDir, { recursive: true });

    const config = createDefaultConfig(env);
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.pages.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.pages.dev', sameAsApi: false },
    };

    await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(keysDir, 'admin_api_secret.txt'), 'admin-secret');

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    let createdRuleName = '';
    let createdWebhookName = '';

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ stats: { users: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ defaults: { storage: 'builtin:storage:single-d1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
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
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
      createdRuleName = body.name ?? '';
      return new Response(JSON.stringify({ id: 'tcr-1', name: createdRuleName }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    fetchMock.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({ id: 'tcr-1', name: createdRuleName }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'rp-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ allowed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
      createdWebhookName = body.name ?? '';
      return new Response(
        JSON.stringify({ success: true, webhook: { id: 'wh-1', name: createdWebhookName } }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }
      );
    });
    fetchMock.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({ webhook: { id: 'wh-1', name: createdWebhookName } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'cak-1', api_key: 'key-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'cak-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'cak-2', api_key: 'key-2' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: 'wh-1' }), {
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
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
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

    const result = await runGeneratedAdminApiSmoke({ baseDir, env });

    expect(result.ok).toBe(true);
    expect(result.adminSecretPath).toContain('admin_api_secret.txt');
    expect(result.checks.map((check) => check.id)).toContain('check-api-keys-rotate');
  });
});

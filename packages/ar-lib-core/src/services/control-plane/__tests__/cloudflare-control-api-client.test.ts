import { describe, expect, it, vi } from 'vitest';
import { CloudflareControlApiClient } from '../cloudflare-control-api-client.js';

const accountId = '0123456789abcdef0123456789abcdef';
const tokens = {
  d1: 'd1-token',
  workers: 'workers-token',
  kv: 'kv-token',
  r2: 'r2-token',
};

function success(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

describe('CloudflareControlApiClient', () => {
  it('uses only the D1 token for query, raw, and import endpoints', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(success([{ success: true, results: [{ id: 'account-1' }] }]))
      .mockResolvedValueOnce(
        success([{ success: true, results: { columns: ['id'], rows: [[1]] } }])
      )
      .mockResolvedValueOnce(
        success({
          type: 'import',
          success: true,
          filename: 'import.sql',
          upload_url: 'https://upload.test',
        })
      );
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await client.queryD1('db/id', 'SELECT ?', ['account-1']);
    await client.rawD1('db/id', 'SELECT 1');
    await client.importD1('db/id', { action: 'init', etag: 'md5' });

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/db%2Fid/query`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/db%2Fid/raw`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/db%2Fid/import`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer d1-token');
      expect(init.redirect).toBe('error');
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      sql: 'SELECT ?',
      params: ['account-1'],
    });
  });

  it('updates D1 read replication with the D1 token', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      success({
        uuid: 'db-id',
        name: 'db',
        read_replication: { mode: 'auto' },
      })
    );
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await client.updateD1Database('db/id', { read_replication: { mode: 'auto' } });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/db%2Fid`
    );
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer d1-token');
    expect(JSON.parse(String(init.body))).toEqual({ read_replication: { mode: 'auto' } });
  });

  it('sends Worker settings as multipart and uses the Workers token', async () => {
    const fetcher = vi.fn().mockResolvedValue(success({ bindings: [] }));
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });
    await client.patchWorkerSettings('worker/name', {
      bindings: [{ name: 'DB', type: 'd1', database_id: 'db-id' }],
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/worker%2Fname/settings`
    );
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer workers-token');
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String((init.body as FormData).get('settings')))).toEqual({
      bindings: [{ name: 'DB', type: 'd1', database_id: 'db-id' }],
    });
  });

  it('uses the modern storage KV path and a separate KV token', async () => {
    const fetcher = vi.fn().mockResolvedValue(success([]));
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });
    await client.listKvNamespaces();

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain('/storage/kv/namespaces');
    expect(url).not.toContain('/workers/namespaces');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer kv-token');
  });

  it('fails closed before fetch when the operation-specific optional token is absent', async () => {
    const fetcher = vi.fn();
    const client = new CloudflareControlApiClient({
      accountId,
      tokens: { d1: 'd1-token', workers: 'workers-token' },
      fetcher,
    });

    await expect(client.createKvNamespace('test')).rejects.toThrow(
      'cloudflare_kv_token_required_for:kv.namespace.create'
    );
    await expect(client.createR2Bucket('test')).rejects.toThrow(
      'cloudflare_r2_token_required_for:r2.bucket.create'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects conflicting or unsupported D1 placement before fetch', async () => {
    const fetcher = vi.fn();
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    expect(() => client.createD1Database({ name: 'db', primary_location_hint: 'invalid' })).toThrow(
      'invalid_d1_primary_location_hint:invalid'
    );
    expect(() => client.createD1Database({ name: 'db', jurisdiction: 'unknown' })).toThrow(
      'invalid_d1_jurisdiction:unknown'
    );
    expect(() =>
      client.createD1Database({ name: 'db', primary_location_hint: 'weur', jurisdiction: 'eu' })
    ).toThrow('d1_jurisdiction_and_location_hint_are_mutually_exclusive');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caps JSON request bodies before issuing provider calls', async () => {
    const fetcher = vi.fn();
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });
    expect(() => client.queryD1('db', 'x'.repeat(4 * 1024 * 1024 + 1))).toThrow(
      'cloudflare_api_request_too_large'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('creates explicit 100 percent deployments and never enables force rollback', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      success({
        id: 'deployment-id',
        created_on: '2026-07-29T00:00:00Z',
        source: 'api',
        strategy: 'percentage',
        versions: [{ percentage: 100, version_id: 'version-id' }],
      })
    );
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });
    await client.createWorkerDeployment('worker', 'version-id', 'rollback');

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).not.toContain('force=');
    expect(JSON.parse(String(init.body))).toEqual({
      strategy: 'percentage',
      versions: [{ version_id: 'version-id', percentage: 100 }],
      annotations: { 'workers/message': 'rollback' },
    });
  });

  it('rejects unsuccessful and invalid API envelopes without exposing credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { success: false, errors: [{ code: 10000, message: 'permission denied' }] },
          { status: 403 }
        )
      )
      .mockResolvedValueOnce(new Response('not-json', { status: 502 }));
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await expect(client.listD1Databases()).rejects.toThrow(
      'cloudflare_api_error:d1.list:403:10000'
    );
    await expect(client.listD1Databases()).rejects.toThrow(
      'cloudflare_api_invalid_json:d1.list:502'
    );
    for (const call of fetcher.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('d1-token');
    }
  });
});

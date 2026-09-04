import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareControlApiClient,
  CloudflareControlApiError,
  parseCloudflareControlRetryAfterSeconds,
} from '../cloudflare-control-api-client.js';

const accountId = '0123456789abcdef0123456789abcdef';
const tokens = {
  d1: 'd1-token',
  workers: 'workers-token',
  kv: 'kv-token',
  r2: 'r2-token',
};

function success(result: unknown, resultInfo?: Record<string, unknown>): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  });
}

describe('CloudflareControlApiClient', () => {
  it('preserves bounded Retry-After guidance on provider errors', async () => {
    expect(parseCloudflareControlRetryAfterSeconds('45', 0)).toBe(45);
    expect(parseCloudflareControlRetryAfterSeconds('9999', 0)).toBe(300);
    expect(parseCloudflareControlRetryAfterSeconds('-1', 0)).toBeNull();
    expect(parseCloudflareControlRetryAfterSeconds('Thu, 01 Jan 1970 00:01:30 GMT', 30_000)).toBe(
      60
    );

    const client = new CloudflareControlApiClient({
      accountId,
      tokens,
      fetcher: vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { success: false, errors: [{ code: 1015, message: 'rate limited' }] },
            { status: 429, headers: { 'Retry-After': '75' } }
          )
        ),
    });
    const error = await client.listWorkerDeployments('worker').catch((caught) => caught);
    expect(error).toBeInstanceOf(CloudflareControlApiError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 75 });

    const nonJsonClient = new CloudflareControlApiClient({
      accountId,
      tokens,
      fetcher: vi.fn().mockResolvedValue(
        new Response('temporarily unavailable', {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      ),
    });
    const nonJsonError = await nonJsonClient
      .listWorkerDeployments('worker')
      .catch((caught) => caught);
    expect(nonJsonError).toMatchObject({ status: 429, retryAfterSeconds: 30 });
  });

  it('uses only the D1 token for query, batch, raw, and import endpoints', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(success([{ success: true, results: [{ id: 'account-1' }] }]))
      .mockResolvedValueOnce(success([{ success: true, results: [] }]))
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
    await client.queryD1Batch('db/id', [
      { sql: 'CREATE TABLE example (id TEXT)' },
      { sql: 'INSERT INTO example (id) VALUES (?)', params: ['account-1'] },
    ]);
    await client.rawD1('db/id', 'SELECT 1');
    await client.importD1('db/id', { action: 'init', etag: 'md5' });

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/db%2Fid/query`,
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
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toEqual({
      batch: [
        { sql: 'CREATE TABLE example (id TEXT)' },
        { sql: 'INSERT INTO example (id) VALUES (?)', params: ['account-1'] },
      ],
    });
  });

  it('rejects empty or blank D1 query batches before fetch', () => {
    const fetcher = vi.fn();
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    expect(() => client.queryD1Batch('db', [])).toThrow('cloudflare_d1_query_batch_empty');
    expect(() => client.queryD1Batch('db', [{ sql: '   ' }])).toThrow('d1_query_sql_required');
    expect(fetcher).not.toHaveBeenCalled();
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
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer d1-token');
    expect(JSON.parse(String(init.body))).toEqual({ read_replication: { mode: 'auto' } });
  });

  it('loads every D1 inventory page so idempotent provisioning can adopt existing databases', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        success(
          [
            {
              uuid: 'db-1',
              name: 'test-authrim-db-1',
              created_at: '2026-08-29T14:30:59.873Z',
              file_size: 360448,
              num_tables: 0,
              jurisdiction: null,
              version: 'production',
              read_replication: null,
            },
            { uuid: 'db-2', name: 'test-authrim-db-2' },
          ],
          { page: 1, per_page: 2, total_count: 3, total_pages: 2 }
        )
      )
      .mockResolvedValueOnce(
        success([{ uuid: 'db-3', name: 'test-authrim-db-3' }], {
          page: 2,
          per_page: 2,
          total_count: 3,
          total_pages: 2,
        })
      );
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await expect(client.listD1Databases()).resolves.toEqual([
      {
        uuid: 'db-1',
        name: 'test-authrim-db-1',
        created_at: '2026-08-29T14:30:59.873Z',
        file_size: 360448,
        num_tables: 0,
        version: 'production',
      },
      { uuid: 'db-2', name: 'test-authrim-db-2' },
      { uuid: 'db-3', name: 'test-authrim-db-3' },
    ]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?page=1&per_page=1000`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?page=2&per_page=1000`,
    ]);
  });

  it('fails closed on malformed or conflicting paginated D1 inventory', async () => {
    const malformed = new CloudflareControlApiClient({
      accountId,
      tokens,
      fetcher: vi.fn().mockResolvedValue(success([{ uuid: 'db-1' }])),
    });
    await expect(malformed.listD1Databases()).rejects.toThrow('cloudflare_d1_list_invalid_result');

    const conflicting = new CloudflareControlApiClient({
      accountId,
      tokens,
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(
          success([{ uuid: 'db-1', name: 'first' }], {
            page: 1,
            per_page: 1,
            total_count: 2,
            total_pages: 2,
          })
        )
        .mockResolvedValueOnce(
          success([{ uuid: 'db-1', name: 'second' }], {
            page: 2,
            per_page: 1,
            total_count: 2,
            total_pages: 2,
          })
        ),
    });
    await expect(conflicting.listD1Databases()).rejects.toThrow(
      'cloudflare_d1_list_duplicate_conflict'
    );
  });

  it('retries a transiently inconsistent D1 pagination snapshot from the first page', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        success(
          [
            { uuid: 'db-1', name: 'test-authrim-db-1' },
            { uuid: 'db-2', name: 'test-authrim-db-2' },
          ],
          { page: 1, per_page: 1000, count: 2, total_count: 1 }
        )
      )
      .mockResolvedValueOnce(
        success(
          [
            { uuid: 'db-1', name: 'test-authrim-db-1' },
            { uuid: 'db-2', name: 'test-authrim-db-2' },
          ],
          { page: 1, per_page: 1000, count: 2, total_count: 2 }
        )
      );
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await expect(client.listD1Databases()).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed after bounded retries when D1 pagination remains inconsistent', async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        success(
          [
            { uuid: 'db-1', name: 'test-authrim-db-1' },
            { uuid: 'db-2', name: 'test-authrim-db-2' },
          ],
          { page: 1, per_page: 1000, count: 2, total_count: 1 }
        )
      )
    );
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await expect(client.listD1Databases()).rejects.toThrow('cloudflare_d1_list_pagination_invalid');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('sends Worker settings as multipart and uses the Workers token', async () => {
    const fetcher = vi.fn().mockResolvedValue(success({ bindings: [] }));
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });
    await client.patchWorkerSettings('worker/name', {
      bindings: [{ name: 'DB', type: 'd1', id: 'db-id' }],
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/worker%2Fname/settings`
    );
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer workers-token');
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String((init.body as FormData).get('settings')))).toEqual({
      bindings: [{ name: 'DB', type: 'd1', id: 'db-id' }],
    });
  });

  it('lists Worker scripts with the Workers token and drops malformed rows', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        success([
          { id: 'test-ar-auth', etag: 'etag-auth' },
          { id: '' },
          { modified_on: '2026-07-29T00:00:00Z' },
        ])
      );
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await expect(client.listWorkerScripts()).resolves.toEqual([
      { id: 'test-ar-auth', etag: 'etag-auth' },
    ]);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer workers-token');
  });

  it('reads account and script workers.dev subdomain state with the Workers token', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(success({ subdomain: 'example' }))
      .mockResolvedValueOnce(success({ enabled: true, previews_enabled: false }));
    const client = new CloudflareControlApiClient({ accountId, tokens, fetcher });

    await expect(client.getWorkersSubdomain()).resolves.toEqual({ subdomain: 'example' });
    await expect(client.getWorkerSubdomain('worker/name')).resolves.toEqual({
      enabled: true,
      previews_enabled: false,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/worker%2Fname/subdomain`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer workers-token');
    }
  });

  it('rejects a malformed Worker list envelope result', async () => {
    const client = new CloudflareControlApiClient({
      accountId,
      tokens,
      fetcher: vi.fn().mockResolvedValue(success({ id: 'not-an-array' })),
    });
    await expect(client.listWorkerScripts()).rejects.toThrow(
      'cloudflare_workers_script_list_invalid_result'
    );
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
    await expect(client.listD1Databases()).rejects.toThrow('cloudflare_api_error:d1.list:502');
    for (const call of fetcher.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('d1-token');
    }
  });
});

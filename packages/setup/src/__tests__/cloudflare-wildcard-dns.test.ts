import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cloudflare from '../core/cloudflare.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ensureWildcardDnsRecord', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
  });

  it('creates a wildcard CNAME when no record exists', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ result: { id: 'record-1' } }));

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?name=*.test.example.com'
    );

    const createRequest = fetchMock.mock.calls[1];
    expect(createRequest?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records'
    );
    expect(createRequest?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(createRequest?.[1]?.body))).toEqual({
      type: 'CNAME',
      name: '*.test.example.com',
      content: 'test.example.com',
      proxied: true,
      ttl: 1,
    });

    expect(result).toEqual({
      created: true,
      updated: false,
      recordId: 'record-1',
      name: '*.test.example.com',
      target: 'test.example.com',
    });
  });

  it('returns without changes when an equivalent proxied wildcard record already exists', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'record-1',
            type: 'CNAME',
            name: '*.test.example.com',
            content: 'test.example.com',
            proxied: true,
          },
        ],
      })
    );

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      created: false,
      updated: false,
      recordId: 'record-1',
      name: '*.test.example.com',
      target: 'test.example.com',
    });
  });

  it('updates an existing same-name wildcard record even when its type differs', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [
            {
              id: 'record-1',
              type: 'A',
              name: '*.test.example.com',
              content: '192.0.2.10',
              proxied: false,
            },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: 'record-1' } }));

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const updateRequest = fetchMock.mock.calls[1];
    expect(updateRequest?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records/record-1'
    );
    expect(updateRequest?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String(updateRequest?.[1]?.body))).toEqual({
      type: 'CNAME',
      name: '*.test.example.com',
      content: 'test.example.com',
      proxied: true,
      ttl: 1,
    });

    expect(result).toEqual({
      created: false,
      updated: true,
      recordId: 'record-1',
      name: '*.test.example.com',
      target: 'test.example.com',
    });
  });

  it('falls back to direct creation when DNS read is forbidden', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: 'record-2' } }, 200));

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?name=*.test.example.com'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records'
    );
    expect(result).toEqual({
      created: true,
      updated: false,
      recordId: 'record-2',
      name: '*.test.example.com',
      target: 'test.example.com',
    });
  });

  it('treats duplicate creation as already satisfied when DNS read is forbidden', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 81057, message: 'A record with that name already exists.' }],
          },
          409
        )
      );

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      created: false,
      updated: false,
      name: '*.test.example.com',
      target: 'test.example.com',
    });
  });

  it('continues with limited verification when DNS read and edit are both forbidden', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403));

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      created: false,
      updated: false,
      name: '*.test.example.com',
      target: 'test.example.com',
      verificationLimited: true,
    });
  });
});

describe('ensureWildcardDnsForMultiTenant', () => {
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
  });

  it('skips DNS work when multi-tenant custom domain is not enabled', async () => {
    const ensureSpy = vi.spyOn(cloudflare, 'ensureWildcardDnsRecord');
    const onProgress = vi.fn();

    await cloudflare.ensureWildcardDnsForMultiTenant(
      {
        tenant: {
          multiTenant: false,
          baseDomain: 'test.example.com',
        },
      },
      onProgress
    );

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('delegates wildcard DNS creation for multi-tenant custom domains', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ result: { id: 'record-3' } }));
    const onProgress = vi.fn();

    await cloudflare.ensureWildcardDnsForMultiTenant(
      {
        tenant: {
          multiTenant: true,
          baseDomain: 'test.example.com',
        },
        urls: {
          api: {
            zoneId: 'zone-123',
          },
        },
      },
      onProgress
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?name=*.test.example.com'
    );
    expect(onProgress).toHaveBeenNthCalledWith(1, 'Ensuring wildcard DNS for *.test.example.com...');
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      '✓ Wildcard DNS created: *.test.example.com -> test.example.com'
    );
  });

  it('warns and continues when wildcard DNS cannot be verified through the API', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403));
    const onProgress = vi.fn();

    await cloudflare.ensureWildcardDnsForMultiTenant(
      {
        tenant: {
          multiTenant: true,
          baseDomain: 'test.example.com',
        },
        urls: {
          api: {
            zoneId: 'zone-123',
          },
        },
      },
      onProgress
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 'Ensuring wildcard DNS for *.test.example.com...');
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      '⚠ Wildcard DNS could not be verified via API permissions. Continuing under the assumption that *.test.example.com -> test.example.com was created manually.'
    );
  });
});

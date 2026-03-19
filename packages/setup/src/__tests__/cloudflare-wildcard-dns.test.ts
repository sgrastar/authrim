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

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(cloudflare, 'getCloudflareApiToken').mockResolvedValue({
      token: 'test-token',
      source: 'oauth',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
});

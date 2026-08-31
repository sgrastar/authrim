import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cloudflare from '../core/cloudflare.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function desiredDnsRead(name: string, target: string, id = 'record-1'): Response {
  return jsonResponse({
    success: true,
    result: [{ id, type: 'CNAME', name, content: target, proxied: true }],
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
      .mockResolvedValueOnce(jsonResponse({ result: { id: 'record-1' } }))
      .mockResolvedValueOnce(desiredDnsRead('*.test.example.com', 'test.example.com', 'record-1'));

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(3);
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
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: 'record-1' } }))
      .mockResolvedValueOnce(desiredDnsRead('*.test.example.com', 'test.example.com', 'record-1'));

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123');

    expect(fetchMock).toHaveBeenCalledTimes(3);

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
      verificationLimited: true,
    });
  });

  it('treats duplicate creation as already satisfied when DNS read is forbidden', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 403)).mockResolvedValueOnce(
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
      verificationLimited: true,
    });
  });

  it('verifies an exact target after a create conflict instead of adopting by name', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 81057, message: 'A record with that name already exists.' }],
          },
          409
        )
      )
      .mockResolvedValueOnce(
        desiredDnsRead('*.test.example.com', 'test.example.com', 'record-conflict')
      );

    await expect(
      cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123')
    ).resolves.toEqual({
      created: false,
      updated: false,
      recordId: 'record-conflict',
      name: '*.test.example.com',
      target: 'test.example.com',
    });
  });

  it('rejects a create conflict whose same-name record has the wrong target', async () => {
    const wrongRecord = () =>
      jsonResponse({
        success: true,
        result: [
          {
            id: 'record-wrong',
            type: 'A',
            name: '*.test.example.com',
            content: '192.0.2.10',
            proxied: false,
          },
        ],
      });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 409))
      .mockResolvedValueOnce(wrongRecord())
      .mockResolvedValueOnce(wrongRecord())
      .mockResolvedValueOnce(wrongRecord());

    await expect(
      cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123')
    ).rejects.toThrow('does not match the required proxied CNAME target');
  });

  it('waits for DNS propagation after a successful create', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: 'record-late' } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(
        desiredDnsRead('*.test.example.com', 'test.example.com', 'record-late')
      );

    await expect(
      cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123')
    ).resolves.toMatchObject({ created: true, recordId: 'record-late' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('recovers an update whose response is lost after commit by exact readback', async () => {
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
      .mockRejectedValueOnce(new Error('network response lost'))
      .mockResolvedValueOnce(desiredDnsRead('*.test.example.com', 'test.example.com', 'record-1'));

    await expect(
      cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123')
    ).resolves.toEqual({
      created: false,
      updated: true,
      recordId: 'record-1',
      name: '*.test.example.com',
      target: 'test.example.com',
    });
  });

  it('does not accept HTTP 200 success:false without an exact update readback', async () => {
    const staleRecord = () =>
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
      });
    fetchMock
      .mockResolvedValueOnce(staleRecord())
      .mockResolvedValueOnce(
        jsonResponse({ success: false, errors: [{ message: 'update rejected' }] })
      )
      .mockResolvedValueOnce(staleRecord())
      .mockResolvedValueOnce(staleRecord())
      .mockResolvedValueOnce(staleRecord());

    await expect(
      cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123')
    ).rejects.toThrow('Failed to update and verify wildcard DNS record');
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

  it('continues with limited verification when zone lookup is blocked by missing zone:read', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 403));

    const result = await cloudflare.ensureWildcardDnsRecord('test.example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones?name=example.com'
    );
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
      .mockResolvedValueOnce(jsonResponse({ result: { id: 'record-3' } }))
      .mockResolvedValueOnce(desiredDnsRead('*.test.example.com', 'test.example.com', 'record-3'));
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?name=*.test.example.com'
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      'Ensuring wildcard DNS for *.test.example.com...'
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      '✓ Wildcard DNS created: *.test.example.com -> test.example.com'
    );
  });

  it('creates API base DNS before wildcard DNS when api.auto is available', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ result: { id: 'record-base' } }))
      .mockResolvedValueOnce(
        desiredDnsRead('test.example.com', 'test-ar-router.account.workers.dev', 'record-base')
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ result: { id: 'record-wildcard' } }))
      .mockResolvedValueOnce(
        desiredDnsRead('*.test.example.com', 'test.example.com', 'record-wildcard')
      );
    const onProgress = vi.fn();

    await cloudflare.ensureWildcardDnsForMultiTenant(
      {
        tenant: {
          multiTenant: true,
          baseDomain: 'test.example.com',
        },
        urls: {
          api: {
            auto: 'https://test-ar-router.account.workers.dev',
            zoneId: 'zone-123',
          },
        },
      },
      onProgress
    );

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?name=test.example.com'
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      type: 'CNAME',
      name: 'test.example.com',
      content: 'test-ar-router.account.workers.dev',
      proxied: true,
      ttl: 1,
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?name=*.test.example.com'
    );
    expect(onProgress).toHaveBeenNthCalledWith(1, 'Ensuring API DNS for test.example.com...');
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      '✓ API DNS created: test.example.com -> test-ar-router.account.workers.dev'
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      3,
      'Ensuring wildcard DNS for *.test.example.com...'
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      4,
      '✓ Wildcard DNS created: *.test.example.com -> test.example.com'
    );
  });

  it('does not create API base DNS when Worker custom domain binding is enabled', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ result: { id: 'record-wildcard' } }))
      .mockResolvedValueOnce(
        desiredDnsRead('*.test.example.com', 'test.example.com', 'record-wildcard')
      );
    const onProgress = vi.fn();

    await cloudflare.ensureWildcardDnsForMultiTenant(
      {
        tenant: {
          multiTenant: true,
          baseDomain: 'test.example.com',
        },
        urls: {
          api: {
            auto: 'https://test-ar-router.account.workers.dev',
            zoneId: 'zone-123',
            customDomainBinding: true,
          },
        },
      },
      onProgress
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?name=*.test.example.com'
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      '✓ API DNS will be managed by Worker custom domain binding: test.example.com'
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      'Ensuring wildcard DNS for *.test.example.com...'
    );
  });

  it('fails when wildcard DNS cannot be verified through the API', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403));
    const verifyPublicDns = vi.fn().mockResolvedValue(false);
    const onProgress = vi.fn();

    await expect(
      cloudflare.ensureWildcardDnsForMultiTenant(
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
        onProgress,
        verifyPublicDns
      )
    ).rejects.toThrow(
      'Token lacks zone:read or dns:edit permission to verify the exact proxied CNAME target for *.test.example.com'
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      'Ensuring wildcard DNS for *.test.example.com...'
    );
  });

  it('does not accept public resolution as proof of the exact proxied CNAME target', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403));
    const verifyPublicDns = vi.fn().mockResolvedValue(true);
    const onProgress = vi.fn();

    await expect(
      cloudflare.ensureWildcardDnsForMultiTenant(
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
        onProgress,
        verifyPublicDns
      )
    ).rejects.toThrow('verify the exact proxied CNAME target');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(verifyPublicDns).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      'Ensuring wildcard DNS for *.test.example.com...'
    );
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('does not report an unverified wildcard create as successful', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: { id: 'record-wildcard' } }, 200)
      );
    const onProgress = vi.fn();

    await expect(
      cloudflare.ensureWildcardDnsForMultiTenant(
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
      )
    ).rejects.toThrow('verify the exact proxied CNAME target');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      'Ensuring wildcard DNS for *.test.example.com...'
    );
  });

  it('does not report an unverified API base record create as successful', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: 'record-api' } }, 200));
    const onProgress = vi.fn();

    await expect(
      cloudflare.ensureWildcardDnsForMultiTenant(
        {
          tenant: {
            multiTenant: true,
            baseDomain: 'test.example.com',
          },
          urls: {
            api: {
              auto: 'https://test-ar-router.account.workers.dev',
              zoneId: 'zone-123',
              customDomainBinding: false,
            },
          },
        },
        onProgress
      )
    ).rejects.toThrow('verify the exact proxied CNAME target for test.example.com');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, 'Ensuring API DNS for test.example.com...');
  });
});

describe('Setup-managed DNS ownership and deletion recovery', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
  });

  it('journals both multi-tenant DNS mutations before issuing them', async () => {
    const entries: Partial<
      Record<
        'api_base' | 'tenant_wildcard',
        Parameters<cloudflare.DnsOwnershipPersistence['persist']>[0]
      >
    > = {};
    const persistence: cloudflare.DnsOwnershipPersistence = {
      get: (role) => entries[role],
      persist: vi.fn(async (entry) => {
        entries[entry.role] = entry;
      }),
    };
    const remote = new Map<string, Record<string, unknown>>();
    let nextId = 1;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const queriedName = new URL(url).searchParams.get('name');
      if (method === 'GET' && queriedName) {
        const record = remote.get(queriedName);
        return jsonResponse({ success: true, result: record ? [record] : [] });
      }
      if (method === 'POST') {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const role = String(payload.name).startsWith('*') ? 'tenant_wildcard' : 'api_base';
        expect(entries[role]?.state).toBe('mutation_pending');
        expect(payload.comment).toBe(entries[role]?.marker);
        const id = `record-${nextId++}`;
        remote.set(String(payload.name), { id, ...payload });
        return jsonResponse({ success: true, result: { id } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await cloudflare.ensureWildcardDnsForMultiTenant(
      {
        tenant: { multiTenant: true, baseDomain: 'test.example.com' },
        urls: {
          api: {
            auto: 'https://test-router.account.workers.dev',
            zoneId: 'zone-123',
          },
        },
      },
      undefined,
      undefined,
      persistence
    );

    expect(entries.api_base).toMatchObject({
      state: 'managed',
      action: 'created',
      recordId: 'record-1',
    });
    expect(entries.tenant_wildcard).toMatchObject({
      state: 'managed',
      action: 'created',
      recordId: 'record-2',
    });
  });

  it('resumes a crash after create without issuing a duplicate DNS mutation', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const marker = `Authrim Setup managed DNS ownership ${operationId}`;
    let entry: Parameters<cloudflare.DnsOwnershipPersistence['persist']>[0] = {
      role: 'tenant_wildcard',
      state: 'mutation_pending',
      action: 'created',
      operationId,
      zoneId: 'zone-123',
      name: '*.test.example.com',
      target: 'test.example.com',
      marker,
      previous: null,
      updatedAt: new Date().toISOString(),
    };
    const persistence: cloudflare.DnsOwnershipPersistence = {
      get: () => entry,
      persist: vi.fn(async (next) => {
        entry = next;
      }),
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'record-created-before-crash',
            type: 'CNAME',
            name: '*.test.example.com',
            content: 'test.example.com',
            proxied: true,
            ttl: 1,
            comment: marker,
          },
        ],
      })
    );

    await cloudflare.ensureWildcardDnsRecord('test.example.com', 'zone-123', persistence);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entry).toMatchObject({
      state: 'managed',
      recordId: 'record-created-before-crash',
    });
  });

  it('fails closed when a managed DNS record was replaced under the same name', async () => {
    const operationId = '22222222-2222-4222-8222-222222222222';
    const marker = `Authrim Setup managed DNS ownership ${operationId}`;
    const entry: Parameters<cloudflare.DnsOwnershipPersistence['persist']>[0] = {
      role: 'tenant_wildcard',
      state: 'managed',
      action: 'created',
      operationId,
      zoneId: 'zone-123',
      recordId: 'record-original',
      name: '*.test.example.com',
      target: 'test.example.com',
      marker,
      previous: null,
      updatedAt: new Date().toISOString(),
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'record-replacement',
            type: 'CNAME',
            name: entry.name,
            content: entry.target,
            proxied: true,
            ttl: 1,
            comment: marker,
          },
        ],
      })
    );

    const result = await cloudflare.cleanupManagedDnsRecords({
      entries: { tenant_wildcard: entry },
      required: true,
    });

    expect(result.completedNames).toEqual([]);
    expect(result.issues[0]?.reason).toContain('dns_managed_record_identity_mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('restores an updated pre-existing CNAME and accepts the restored state on retry', async () => {
    const operationId = '33333333-3333-4333-8333-333333333333';
    const marker = `Authrim Setup managed DNS ownership ${operationId}`;
    const previous = {
      id: 'record-existing',
      type: 'CNAME' as const,
      name: '*.test.example.com',
      content: 'previous.example.net',
      proxied: false,
      ttl: 300,
      comment: 'operator-owned',
      tags: ['owner:operator'],
    };
    const entry: Parameters<cloudflare.DnsOwnershipPersistence['persist']>[0] = {
      role: 'tenant_wildcard',
      state: 'managed',
      action: 'updated',
      operationId,
      zoneId: 'zone-123',
      recordId: previous.id,
      name: previous.name,
      target: 'test.example.com',
      marker,
      previous,
      updatedAt: new Date().toISOString(),
    };
    const managedRecord = {
      id: previous.id,
      type: 'CNAME',
      name: previous.name,
      content: entry.target,
      proxied: true,
      ttl: 1,
      comment: marker,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [managedRecord] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: previous.id } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [previous] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [previous] }));

    await expect(
      cloudflare.cleanupManagedDnsRecords({
        entries: { tenant_wildcard: entry },
        required: true,
      })
    ).resolves.toEqual({ completedNames: [entry.name], issues: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      type: 'CNAME',
      name: previous.name,
      content: previous.content,
      proxied: false,
      ttl: 300,
      comment: 'operator-owned',
      tags: ['owner:operator'],
    });

    await expect(
      cloudflare.cleanupManagedDnsRecords({
        entries: { tenant_wildcard: entry },
        required: true,
      })
    ).resolves.toEqual({ completedNames: [entry.name], issues: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('requires manual action when multi-tenant DNS ownership evidence is absent', async () => {
    await expect(
      cloudflare.cleanupManagedDnsRecords({ entries: undefined, required: true })
    ).resolves.toEqual({
      completedNames: [],
      issues: [
        {
          role: 'unknown',
          name: '(multi-tenant DNS)',
          reason: 'dns_ownership_evidence_missing',
        },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

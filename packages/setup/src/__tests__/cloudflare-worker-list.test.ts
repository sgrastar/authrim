import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({ execa: execaMock }));

import { listWorkerCronTriggers, listWorkers } from '../core/cloudflare.js';

describe('Cloudflare Worker script inventory', () => {
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    vi.unstubAllGlobals();
  });

  it('returns the exact script name and immutable tag', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          { id: 'test-ar-auth', tag: 'immutable-tag-a' },
          { id: 'test-ar-token', tag: 'immutable-tag-b' },
        ],
        result_info: { page: 1, total_pages: 1 },
      }),
    });

    await expect(listWorkers()).resolves.toEqual([
      { id: 'test-ar-auth', name: 'test-ar-auth', tag: 'immutable-tag-a' },
      { id: 'test-ar-token', name: 'test-ar-token', tag: 'immutable-tag-b' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('fails closed if the SinglePage endpoint reports pagination', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ id: 'test-ar-auth', tag: 'immutable-tag-a' }],
        result_info: { page: 1, total_pages: 2 },
      }),
    });

    await expect(listWorkers()).rejects.toThrow(
      'Cloudflare Worker inventory unexpectedly requires pagination'
    );
  });

  it('reads the exact Cron Trigger set for a Worker from the pinned account', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { schedules: [{ cron: '*/5 * * * *' }, { cron: '* * * * *' }] },
      }),
    });

    await expect(
      listWorkerCronTriggers({
        workerName: 'test-ar-management',
        accountId: '0123456789abcdef0123456789abcdef',
      })
    ).resolves.toEqual(['* * * * *', '*/5 * * * *']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/test-ar-management/schedules',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('rejects an invalid Cron Trigger provider response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { schedules: [{ created_on: 'now' }] } }),
    });

    await expect(listWorkerCronTriggers({ workerName: 'test-ar-management' })).rejects.toThrow(
      'cloudflare_worker_cron_response_invalid'
    );
  });

  it('rejects duplicate names or immutable tags', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          { id: 'test-ar-auth', tag: 'same-tag' },
          { id: 'test-ar-token', tag: 'same-tag' },
        ],
        result_info: { page: 1, total_pages: 1 },
      }),
    });
    await expect(listWorkers()).rejects.toThrow(
      'Worker inventory contained duplicate immutable tag: same-tag'
    );

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          { id: 'test-ar-auth', tag: 'tag-a' },
          { id: 'test-ar-auth', tag: 'tag-b' },
        ],
        result_info: { page: 1, total_pages: 1 },
      }),
    });
    await expect(listWorkers()).rejects.toThrow(
      'Worker inventory contained duplicate script name: test-ar-auth'
    );
  });
});

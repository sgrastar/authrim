import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({ execa: execaMock }));

import { deletePagesProject, listPagesProjects } from '../core/cloudflare.js';

const accountId = '0123456789abcdef0123456789abcdef';
const createdOn = '2026-08-31T00:00:00.000Z';
const expected = { name: 'test-ar-admin-ui', id: 'project-id', createdOn };

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    name: expected.name,
    id: expected.id,
    created_on: createdOn,
    domains: [`${expected.name}.pages.dev`],
    ...overrides,
  };
}

describe('Cloudflare Pages immutable deletion identity', () => {
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  it('reads every Pages API page and retains id plus created_on', async () => {
    fetchMock.mockImplementation(async (rawUrl: string | URL) => {
      const page = new URL(String(rawUrl)).searchParams.get('page');
      return jsonResponse(200, {
        success: true,
        result: [
          project({
            name: page === '1' ? 'test-ar-admin-ui' : 'test-ar-login-ui',
            id: page === '1' ? 'admin-id' : 'login-id',
          }),
        ],
        result_info: {
          count: 1,
          page: Number(page),
          per_page: 100,
          total_count: 2,
          total_pages: 2,
        },
      });
    });

    await expect(listPagesProjects({ requireIdentity: true })).resolves.toEqual([
      expect.objectContaining({ name: 'test-ar-admin-ui', id: 'admin-id', createdOn }),
      expect.objectContaining({ name: 'test-ar-login-ui', id: 'login-id', createdOn }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks a legacy name-only Pages deletion before any destructive request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: project() }));

    await expect(deletePagesProject({ name: expected.name, id: '', createdOn: '' })).resolves.toBe(
      false
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as FetchInit | undefined)?.method === 'DELETE')
    ).toBe(false);
  });

  it('preserves a same-name replacement whose immutable Pages identity changed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: project({ id: 'replacement-id' }) })
    );

    await expect(deletePagesProject(expected)).resolves.toBe(false);
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as FetchInit | undefined)?.method === 'DELETE')
    ).toBe(false);
  });

  it('does not delete a Pages project after custom-domain removal fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          result: project({ domains: ['custom.example.com'] }),
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          result: project({ domains: ['custom.example.com'] }),
        })
      )
      .mockResolvedValueOnce(jsonResponse(500, { success: false }));

    await expect(deletePagesProject(expected)).resolves.toBe(false);
    const destructiveUrls = fetchMock.mock.calls
      .filter(([, init]) => (init as FetchInit | undefined)?.method === 'DELETE')
      .map(([url]) => String(url));
    expect(destructiveUrls).toEqual([expect.stringContaining('/domains/custom.example.com')]);
  });

  it.each([
    ['absent', null, true],
    ['same identity', project(), false],
    ['same-name replacement', project({ id: 'replacement-id' }), false],
  ])(
    'reconciles an ambiguous Pages project DELETE when readback is %s',
    async (_label, afterDelete, expectedResult) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { success: true, result: project() }))
        .mockResolvedValueOnce(jsonResponse(200, { success: true, result: project() }))
        .mockRejectedValueOnce(new Error('response lost after commit'))
        .mockResolvedValueOnce(
          afterDelete === null
            ? jsonResponse(404, { success: false })
            : jsonResponse(200, { success: true, result: afterDelete })
        );

      await expect(deletePagesProject(expected)).resolves.toBe(expectedResult);
      expect(
        fetchMock.mock.calls.filter(
          ([, init]) => (init as FetchInit | undefined)?.method === 'DELETE'
        )
      ).toHaveLength(1);
    }
  );
});

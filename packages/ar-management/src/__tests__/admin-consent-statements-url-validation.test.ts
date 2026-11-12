import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env, PreparedStatement } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  getTenantIdFromContext: vi.fn(),
  createAuthContextFromHono: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: mocked.getTenantIdFromContext,
    createAuthContextFromHono: mocked.createAuthContextFromHono,
  };
});

import { adminConsentLocalizationUpsertHandler } from '../admin-consent-statements';

function createMockAdapter(
  options: {
    localizationExists?: boolean;
  } = {}
): DatabaseAdapter {
  const query = vi.fn(async <T>(sql: string): Promise<T[]> => {
    if (sql.includes('SELECT id, status FROM consent_statement_versions')) {
      return [{ id: 'version-1', status: 'draft' }] as T[];
    }
    if (sql.includes('SELECT id FROM consent_statement_localizations')) {
      return (options.localizationExists ? [{ id: 'loc-1' }] : []) as T[];
    }
    if (sql.includes('SELECT * FROM consent_statement_localizations')) {
      return [{ id: 'loc-1', document_url: 'https://example.com/privacy' }] as T[];
    }
    return [];
  });
  const transactionImpl: DatabaseAdapter['transaction'] = async <T>(
    fn: Parameters<DatabaseAdapter['transaction']>[0]
  ): Promise<T> =>
    (await fn({} as Parameters<Parameters<DatabaseAdapter['transaction']>[0]>[0])) as T;

  const execute: DatabaseAdapter['execute'] = vi
    .fn()
    .mockResolvedValue({ success: true, rowsAffected: 1 });
  return {
    query: query as unknown as DatabaseAdapter['query'],
    queryOne: vi.fn().mockResolvedValue(null),
    execute,
    transaction: vi.fn(transactionImpl) as unknown as DatabaseAdapter['transaction'],
    batch: vi.fn(async (statements: PreparedStatement[]) => [
      { success: true, rowsAffected: 1 },
      await execute(statements[1].sql, statements[1].params),
    ]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(options: {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}) {
  const contextStore = new Map<string, unknown>();

  return {
    req: {
      path: '/api/admin/consent-statements/stmt-1/versions/ver-1/localizations/en',
      param: vi.fn((name: string) => options.params?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {} as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;
}

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json();
}

describe('admin consent statement URL validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getTenantIdFromContext.mockReturnValue('default');
  });

  it('rejects unsafe localization document_url before writing to storage', async () => {
    const coreAdapter = createMockAdapter({ localizationExists: true });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await adminConsentLocalizationUpsertHandler(
      createMockContext({
        params: { vid: 'ver-1', lang: 'en' },
        body: {
          title: 'Privacy notice',
          description: 'Read this notice',
          document_url: 'javascript:alert(1)',
        },
      })
    );
    const body = await responseJson<{ error: string; error_description: string }>(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe('document_url must be an http(s) URL');
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it('stores normalized http(s) localization document_url values', async () => {
    const coreAdapter = createMockAdapter({ localizationExists: true });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await adminConsentLocalizationUpsertHandler(
      createMockContext({
        params: { vid: 'ver-1', lang: 'en' },
        body: {
          title: 'Privacy notice',
          description: 'Read this notice',
          document_url: ' https://example.com/privacy ',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(coreAdapter.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(coreAdapter.execute).mock.calls[0]?.[1]).toEqual([
      'Privacy notice',
      'Read this notice',
      null,
      null,
      'https://example.com/privacy',
      null,
      expect.any(Number),
      'ver-1',
      'en',
      'default',
    ]);
  });

  it('falls back when optional localization user-facing columns are not present yet', async () => {
    const coreAdapter = createMockAdapter({ localizationExists: true });
    vi.mocked(coreAdapter.execute)
      .mockRejectedValueOnce(
        new Error('no such column: consent_statement_localizations.processing_purpose')
      )
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await adminConsentLocalizationUpsertHandler(
      createMockContext({
        params: { vid: 'ver-1', lang: 'en' },
        body: {
          title: 'Attribute release',
          description: 'Review released attributes',
          processing_purpose: 'SAML attribute release confirmation',
          inline_content: '<p>Allow release?</p>',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(coreAdapter.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(coreAdapter.execute).mock.calls[1]?.[0]).not.toContain('processing_purpose');
    expect(vi.mocked(coreAdapter.execute).mock.calls[1]?.[1]).toEqual([
      'Attribute release',
      'Review released attributes',
      null,
      '<p>Allow release?</p>',
      expect.any(Number),
      'ver-1',
      'en',
      'default',
    ]);
  });
});

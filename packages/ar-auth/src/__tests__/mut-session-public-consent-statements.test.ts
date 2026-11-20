import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'default',
  createAuthContextFromHono: () => ({ coreAdapter: { query: mocks.query } }),
  getLogger: () => ({ module: () => ({ error: vi.fn() }) }),
}));

import {
  publicConsentStatementHandler,
  requestedStatementLanguage,
} from '../public-consent-statements';

type Row = Record<string, unknown>;

function serve(versions: Row[], localizations: Row[]) {
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM consent_statements')) {
      return params[1] === 'terms' ? [{ id: 'st-1', slug: 'terms', category: 'privacy' }] : [];
    }
    if (sql.includes('FROM consent_statement_versions')) return versions;
    if (sql.includes('FROM consent_statement_localizations')) {
      return localizations.filter((row) => row.version_id === params[1]);
    }
    return [];
  });
}

function context(input: {
  slug?: string;
  query?: Record<string, string>;
  acceptLanguage?: string;
}) {
  return {
    env: {} as Env,
    req: {
      param: (name: string) => (name === 'slug' ? input.slug : undefined),
      query: (name: string) => input.query?.[name],
      header: (name: string) => (name === 'Accept-Language' ? input.acceptLanguage : undefined),
    },
    header: vi.fn(),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

async function get(input: Parameters<typeof context>[0]) {
  const response = await publicConsentStatementHandler(context(input));
  return { status: response.status, body: await response.json<Row>() };
}

const version = (id: string, v: string, current: unknown, contentType = 'inline') => ({
  id,
  version: v,
  content_type: contentType,
  effective_at: '1700000000',
  is_current: current,
});

const loc = (versionId: string, language: string, extra: Row = {}) => ({
  id: `${versionId}-${language}`,
  tenant_id: 'default',
  version_id: versionId,
  language,
  title: `Title ${language}`,
  description: `Description ${language}`,
  processing_purpose: null,
  withdrawal_impact: null,
  document_url: null,
  inline_content: null,
  created_at: 1,
  updated_at: 1,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  serve([version('v-1', '20260101', true)], [loc('v-1', 'en')]);
});

describe('requestedStatementLanguage', () => {
  it('prefers a well-formed lang, trimmed', () => {
    expect(requestedStatementLanguage(' ja ', 'fr')).toBe('ja');
  });

  it('falls back to the first Accept-Language tag, trimmed and without its weight', () => {
    expect(requestedStatementLanguage('not a tag', ' de-AT ;q=0.9, en')).toBe('de-AT');
    expect(requestedStatementLanguage(undefined, 'fr;q=1')).toBe('fr');
  });

  it('defaults to English', () => {
    expect(requestedStatementLanguage(undefined, undefined)).toBe('en');
    expect(requestedStatementLanguage('', '*')).toBe('en');
  });
});

describe('public consent statement handler', () => {
  const notFound = {
    status: 404,
    body: { error: 'not_found', error_description: 'Statement not found' },
  };

  it('answers not found for a missing or overlong slug without reading the database', async () => {
    expect(await get({})).toEqual(notFound);
    expect(await get({ slug: 'a'.repeat(129) })).toEqual(notFound);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('looks up a slug of exactly the maximum length', async () => {
    expect(await get({ slug: 'a'.repeat(128) })).toEqual(notFound);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed version', async () => {
    expect(await get({ slug: 'terms', query: { version: '2026-01-01' } })).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'version must be YYYYMMDD' },
    });
  });

  it('reads the versions of the statement found', async () => {
    await get({ slug: 'terms' });
    expect(mocks.query.mock.calls[1][1]).toEqual(['default', 'st-1']);
  });

  it('treats a string "1" as current and reports the localization language and fields', async () => {
    serve(
      [version('v-2', '20261101', '1', 'url'), version('v-1', '20260101', 0)],
      [loc('v-2', 'en', { document_url: 'https://example.com/terms' })]
    );
    const { status, body } = await get({ slug: 'terms', query: { lang: 'ja' } });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      language: 'en',
      title: 'Title en',
      description: 'Description en',
      content_type: 'url',
      document_url: 'https://example.com/terms',
      inline_content: null,
      version: { version: '20261101', effective_at: 1700000000, is_current: true },
      versions: [
        { version: '20261101', effective_at: 1700000000, is_current: true },
        { version: '20260101', effective_at: 1700000000, is_current: false },
      ],
    });
  });

  it('falls back to the slug and empty text when the version has no localization', async () => {
    serve([version('v-1', '20260101', true)], []);
    const { body } = await get({ slug: 'terms', query: { lang: 'ja' } });
    expect(body).toMatchObject({
      language: 'ja',
      title: 'terms',
      description: '',
      document_url: null,
      inline_content: null,
      content_type: 'inline',
    });
  });

  it('answers server_error when the database fails', async () => {
    mocks.query.mockRejectedValue(new Error('d1'));
    expect(await get({ slug: 'terms' })).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to read the statement' },
    });
  });
});

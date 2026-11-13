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

interface Fixture {
  statements: Array<{ id: string; slug: string; category: string }>;
  versions: Array<{
    id: string;
    version: string;
    content_type: string;
    effective_at: number;
    is_current: number;
  }>;
  localizations: Array<Record<string, unknown>>;
}

function serve(fixture: Fixture) {
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM consent_statements')) {
      return fixture.statements.filter((row) => row.slug === params[1]);
    }
    if (sql.includes('FROM consent_statement_versions')) return fixture.versions;
    if (sql.includes('FROM consent_statement_localizations')) {
      return fixture.localizations.filter((row) => row.version_id === params[1]);
    }
    return [];
  });
}

function context(input: { slug: string; query?: Record<string, string>; acceptLanguage?: string }) {
  const headers = new Headers();
  return {
    env: {} as Env,
    req: {
      param: (name: string) => (name === 'slug' ? input.slug : undefined),
      query: (name: string) => input.query?.[name],
      header: (name: string) =>
        name.toLowerCase() === 'accept-language' ? input.acceptLanguage : undefined,
    },
    header: (name: string, value: string) => headers.set(name, value),
    json: (body: unknown, status = 200) => {
      const response = Response.json(body, { status });
      headers.forEach((value, name) => response.headers.set(name, value));
      return response;
    },
  } as unknown as Context<{ Bindings: Env }>;
}

const localization = (versionId: string, language: string, title: string) => ({
  id: `${versionId}-${language}`,
  tenant_id: 'default',
  version_id: versionId,
  language,
  title,
  description: `${title} description`,
  processing_purpose: null,
  withdrawal_impact: null,
  document_url: null,
  inline_content: `<p>${title}</p>`,
  created_at: 1,
  updated_at: 1,
});

const FIXTURE: Fixture = {
  statements: [{ id: 'st-1', slug: 'terms', category: 'terms_of_service' }],
  versions: [
    { id: 'v-2', version: '20261113', content_type: 'inline', effective_at: 20, is_current: 1 },
    { id: 'v-1', version: '20260101', content_type: 'inline', effective_at: 10, is_current: 0 },
  ],
  localizations: [
    localization('v-2', 'en', 'Terms'),
    localization('v-2', 'ja', '利用規約'),
    localization('v-1', 'en', 'Old terms'),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  serve(FIXTURE);
});

describe('public consent statement page API', () => {
  it('shows the current version in the asked language, with the published versions', async () => {
    const response = await publicConsentStatementHandler(
      context({ slug: 'terms', query: { lang: 'ja' } })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      slug: 'terms',
      language: 'ja',
      title: '利用規約',
      content_type: 'inline',
      inline_content: '<p>利用規約</p>',
      version: { version: '20261113', is_current: true },
      versions: [
        { version: '20261113', is_current: true },
        { version: '20260101', is_current: false },
      ],
    });
  });

  it('shows an earlier published version, falling back to English', async () => {
    const response = await publicConsentStatementHandler(
      context({ slug: 'terms', query: { version: '20260101' }, acceptLanguage: 'ja,en;q=0.5' })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      title: 'Old terms',
      version: { version: '20260101', is_current: false },
    });
  });

  it('reads only published versions of an active statement', async () => {
    await publicConsentStatementHandler(context({ slug: 'terms' }));
    const [statementSql] = mocks.query.mock.calls[0] as [string];
    const [versionSql] = mocks.query.mock.calls[1] as [string];
    expect(statementSql).toContain('is_active = 1');
    expect(statementSql).toContain('retired_at IS NULL');
    expect(versionSql).toContain("status IN ('active', 'archived')");
  });

  it('answers 404 for an unknown statement or version, and 400 for a malformed version', async () => {
    expect((await publicConsentStatementHandler(context({ slug: 'nope' }))).status).toBe(404);
    expect(
      (
        await publicConsentStatementHandler(
          context({ slug: 'terms', query: { version: '20990101' } })
        )
      ).status
    ).toBe(404);
    expect(
      (await publicConsentStatementHandler(context({ slug: 'terms', query: { version: 'x' } })))
        .status
    ).toBe(400);
  });

  it('answers 404 when no version is current', async () => {
    serve({ ...FIXTURE, versions: FIXTURE.versions.map((row) => ({ ...row, is_current: 0 })) });
    expect((await publicConsentStatementHandler(context({ slug: 'terms' }))).status).toBe(404);
  });
});

describe('requestedStatementLanguage', () => {
  it('prefers a well-formed lang, then the first Accept-Language tag, then English', () => {
    expect(requestedStatementLanguage('ja', 'de')).toBe('ja');
    expect(requestedStatementLanguage('<script>', 'de-DE,en;q=0.5')).toBe('de-DE');
    expect(requestedStatementLanguage(undefined, undefined)).toBe('en');
  });
});

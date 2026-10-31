import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCreateAccountAuthContextFromHono,
  mockCoreAdapter,
  mockAccountCoreAdapter,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  // Tenant metadata (statements, clients) and the user's account database (OAuth consents).
  const coreAdapter = {
    query: vi.fn(),
  };
  const accountCoreAdapter = {
    query: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({ coreAdapter }),
    mockCreateAccountAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter: accountCoreAdapter,
    }),
    mockCoreAdapter: coreAdapter,
    mockAccountCoreAdapter: accountCoreAdapter,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createAccountAuthContextFromHono: mockCreateAccountAuthContextFromHono,
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

import { listAccountConsentsHandler } from '../account-consents';

function createMockContext(cookie?: string, acceptLanguage?: string) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/consents', {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(acceptLanguage ? { 'Accept-Language': acceptLanguage } : {}),
    },
  });
  return {
    env: {} as Env,
    req: {
      method: 'GET',
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    header: (name: string, value: string) => {
      headers.set(name, value);
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...Object.fromEntries(headers.entries()),
        },
      }),
  } as unknown as Context<{ Bindings: Env }>;
}

type Row = Record<string, unknown>;

interface Data {
  /** The user's statement consent records, in the account database. */
  records: Row[];
  /** Statement and localization definitions, in the tenant metadata database. */
  statements: Row[];
  localizations: Row[];
  /** Flow consent records (tenant metadata for now). */
  flow: Row[];
  /** OAuth client consents (account database) and their clients (metadata). */
  oauthConsents: Row[];
  clients: Row[];
}

function record(overrides: Row): Row {
  return {
    id: 'record',
    tenant_id: 'default',
    user_id: 'user-001',
    statement_id: 'statement',
    version_id: 'version',
    version: '1',
    status: 'granted',
    granted_at: null,
    withdrawn_at: null,
    expires_at: null,
    retain_until: null,
    consent_settings_snapshot_at: null,
    record_retention_days_snapshot: null,
    reconsent_interval_days_snapshot: null,
    client_id: null,
    ip_address_hash: null,
    user_agent: null,
    receipt_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

/** Each database answers only for the tables it owns; asking it for any other table fails. */
function serve(data: Partial<Data>) {
  const all: Data = {
    records: [],
    statements: [],
    localizations: [],
    flow: [],
    oauthConsents: [],
    clients: [],
    ...data,
  };
  mockAccountCoreAdapter.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM user_consent_records')) return all.records;
    if (sql.includes('FROM oauth_client_consents')) return all.oauthConsents;
    throw new Error(`account database asked for a table it does not own: ${sql}`);
  });
  mockCoreAdapter.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM consent_statements')) return all.statements;
    if (sql.includes('FROM consent_statement_localizations')) return all.localizations;
    if (sql.includes('FROM consent_records cr')) return all.flow;
    if (sql.includes('FROM oauth_clients')) return all.clients;
    throw new Error(`metadata database asked for a table it does not own: ${sql}`);
  });
}

interface ConsentsBody {
  total: number;
  consents: Array<Record<string, unknown>>;
}

async function bodyOf(response: Response): Promise<ConsentsBody> {
  return (await response.json()) as ConsentsBody;
}

const COOKIE = 'authrim_session=g1%3Aapac%3A3%3Asession_current';

describe('Account Page consents API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    serve({
      records: [
        record({
          id: 'record-1',
          statement_id: 'privacy-policy',
          version_id: 'version-1',
          version: '20260623',
          granted_at: 1_777_100_000,
          client_id: 'client-abc',
          receipt_id: 'receipt-1',
          updated_at: 1_777_100_000,
        }),
      ],
      statements: [{ id: 'privacy-policy', slug: 'privacy', category: 'privacy_policy' }],
      localizations: [
        {
          version_id: 'version-1',
          language: 'en',
          title: 'Privacy Policy',
          description: 'Privacy policy consent',
        },
      ],
      flow: [
        {
          id: 'flow-consent-1',
          statement_id: 'terms-of-service',
          version_id: 'version-terms-1',
          version: '20260623',
          decision: 'accepted',
          record_status: 'active',
          granted_at: 1_777_150_000,
          withdrawn_at: null,
          expires_at: null,
          client_id: null,
          receipt_id: null,
          updated_at: 1_777_150_000,
          slug: 'terms_of_service',
          category: 'terms_of_service',
          title: 'Terms of Service',
          description: 'Terms consent',
        },
      ],
      oauthConsents: [
        {
          id: 'consent-1',
          client_id: 'client-abc',
          scope: 'openid profile email',
          selected_scopes: JSON.stringify(['openid', 'profile']),
          granted_at: 1_777_200_000,
          expires_at: null,
          privacy_policy_version: 'privacy-v1',
          tos_version: 'tos-v1',
          consent_version: 2,
        },
      ],
      clients: [
        {
          client_id: 'client-abc',
          client_name: 'Example App',
          logo_uri: 'https://example.test/logo.png',
        },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists statement and OAuth consents for the authenticated Account Page session user', async () => {
    const response = await listAccountConsentsHandler(createMockContext(COOKIE));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // The user's statement records and OAuth consents come from the user's account database.
    expect(mockAccountCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM user_consent_records'),
      ['default', 'user-001']
    );
    expect(mockAccountCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM oauth_client_consents'),
      ['default', 'user-001']
    );
    // What the records name (statements, texts, clients) is tenant metadata, read by id.
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM consent_statements'),
      ['default', 'privacy-policy']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM consent_statement_localizations'),
      ['default', 'en', 'version-1']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM consent_records cr'),
      ['en', 'default', 'user-001']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM oauth_clients'),
      ['default', 'client-abc']
    );
    // Neither side is asked for the other's tables.
    for (const [sql] of mockCoreAdapter.query.mock.calls) {
      expect(sql).not.toContain('user_consent_records');
      expect(sql).not.toContain('oauth_client_consents');
    }
    for (const [sql] of mockAccountCoreAdapter.query.mock.calls) {
      expect(sql).not.toContain('consent_statements');
      expect(sql).not.toContain('consent_statement_localizations');
    }
    expect(body).toEqual({
      consents: [
        {
          kind: 'statement',
          id: 'flow-consent-1',
          statementId: 'terms-of-service',
          versionId: 'version-terms-1',
          version: '20260623',
          status: 'granted',
          title: 'Terms of Service',
          description: 'Terms consent',
          slug: 'terms_of_service',
          category: 'terms_of_service',
          grantedAt: 1_777_150_000,
          updatedAt: 1_777_150_000,
        },
        {
          kind: 'statement',
          id: 'record-1',
          statementId: 'privacy-policy',
          versionId: 'version-1',
          version: '20260623',
          status: 'granted',
          title: 'Privacy Policy',
          description: 'Privacy policy consent',
          slug: 'privacy',
          category: 'privacy_policy',
          grantedAt: 1_777_100_000,
          clientId: 'client-abc',
          receiptId: 'receipt-1',
          updatedAt: 1_777_100_000,
        },
        {
          kind: 'oauth_client',
          id: 'consent-1',
          clientId: 'client-abc',
          clientName: 'Example App',
          clientLogoUri: 'https://example.test/logo.png',
          scopes: ['openid', 'profile', 'email'],
          selectedScopes: ['openid', 'profile'],
          grantedAt: 1_777_200_000,
          policyVersions: {
            privacyPolicyVersion: 'privacy-v1',
            tosVersion: 'tos-v1',
            consentVersion: 2,
          },
        },
      ],
      total: 3,
    });
  });

  it.each([
    ['zh-Hans', 'zh-CN'],
    ['zh-Hant-TW', 'zh-TW'],
    ['fr-FR', 'fr'],
    ['id-ID', 'id'],
    ['ar-SA', 'ar'],
    ['it-IT', 'it'],
    ['th-TH', 'th'],
    ['vi-VN', 'vi'],
    ['hi-IN', 'hi'],
    ['bn-BD', 'bn'],
    ['tr-TR', 'tr'],
    ['sw-KE', 'sw'],
    ['am-ET', 'am'],
    ['pl-PL', 'pl'],
  ])('selects %s consent localizations with language %s', async (header, language) => {
    await listAccountConsentsHandler(createMockContext(COOKIE, header));

    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM consent_statement_localizations'),
      ['default', language, 'version-1']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM consent_records cr'),
      [language, 'default', 'user-001']
    );
  });

  it('requires an account session before reading consent history', async () => {
    const response = await listAccountConsentsHandler(createMockContext());

    expect(response.status).toBe(401);
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
    expect(mockAccountCoreAdapter.query).not.toHaveBeenCalled();
  });

  it('still returns a record whose statement and texts are gone from the metadata database', async () => {
    serve({
      records: [
        record({ id: 'orphan', statement_id: 'statement-deleted', version_id: 'version-deleted' }),
      ],
    });

    const response = await listAccountConsentsHandler(createMockContext(COOKIE));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.consents).toEqual([
      expect.objectContaining({
        id: 'orphan',
        statementId: 'statement-deleted',
        versionId: 'version-deleted',
        title: 'statement-deleted',
      }),
    ]);
  });

  it('does not answer from the metadata database when the account database cannot be read', async () => {
    serve({ records: [record({ id: 'in-metadata-only' })] });
    mockAccountCoreAdapter.query.mockReset().mockRejectedValue(new Error('account database down'));

    await expect(listAccountConsentsHandler(createMockContext(COOKIE))).rejects.toThrow(
      'account database down'
    );
    for (const [sql] of mockCoreAdapter.query.mock.calls) {
      expect(sql).not.toContain('user_consent_records');
    }
  });

  it('normalizes revoked/denied records and omits malformed optional consent data', async () => {
    serve({
      records: [
        record({
          id: 'statement-minimal',
          statement_id: 'statement-1',
          version_id: 'version-1',
          version: '1',
          status: 'withdrawn',
          updated_at: 10,
        }),
      ],
      flow: [
        {
          id: 'flow-revoked',
          statement_id: 'statement-2',
          version_id: 'version-2',
          version: '2',
          decision: 'accepted',
          selected_value: null,
          record_status: 'revoked',
          granted_at: null,
          withdrawn_at: 20,
          expires_at: null,
          client_id: null,
          receipt_id: null,
          updated_at: 20,
          slug: null,
          category: null,
          title: null,
          description: null,
        },
        {
          id: 'flow-denied',
          statement_id: 'statement-3',
          version_id: 'version-3',
          version: '3',
          decision: 'rejected',
          selected_value: 'no',
          record_status: 'active',
          granted_at: null,
          withdrawn_at: null,
          expires_at: null,
          client_id: null,
          receipt_id: null,
          updated_at: 30,
          slug: 'statement-three',
          category: null,
          title: null,
          description: null,
        },
      ],
      oauthConsents: [
        {
          id: 'oauth-minimal',
          client_id: 'client-1',
          scope: 'openid  email ',
          selected_scopes: '{bad json',
          granted_at: 40,
          expires_at: null,
          privacy_policy_version: null,
          tos_version: null,
          consent_version: null,
        },
      ],
    });

    const response = await listAccountConsentsHandler(createMockContext(COOKIE, 'ja-JP, en;q=0.8'));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(expect.any(String), [
      'ja',
      'default',
      'user-001',
    ]);
    expect(body.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'flow-revoked', status: 'withdrawn' }),
        expect.objectContaining({ id: 'flow-denied', status: 'denied', selectedValue: 'no' }),
        expect.objectContaining({ id: 'statement-minimal', title: 'statement-1' }),
        expect.objectContaining({ id: 'oauth-minimal', scopes: ['openid', 'email'] }),
      ])
    );
    const oauth = body.consents.find((consent) => consent.id === 'oauth-minimal');
    expect(oauth).not.toHaveProperty('selectedScopes');
    expect(oauth).not.toHaveProperty('policyVersions');
  });

  it.each([
    ['non-array JSON', JSON.stringify({ scope: 'openid' })],
    ['mixed array JSON', JSON.stringify(['openid', 42])],
    ['empty value', null],
  ])('omits selected scopes for %s', async (_label, selectedScopes) => {
    serve({
      oauthConsents: [
        {
          id: 'oauth-1',
          client_id: 'client-1',
          scope: 'openid',
          selected_scopes: selectedScopes,
          granted_at: 1,
          expires_at: null,
          privacy_policy_version: null,
          tos_version: null,
          consent_version: null,
        },
      ],
    });

    const response = await listAccountConsentsHandler(createMockContext(COOKIE));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.consents[0]).not.toHaveProperty('selectedScopes');
  });
});

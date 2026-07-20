import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCoreAdapter,
  mockTxExecute,
  mockBatch,
  mockInvalidateConsentCache,
  mockRecordAccountOperation,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const txExecute = vi.fn();
  const batch = vi.fn();
  const coreAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    transaction: vi.fn(async (callback: (tx: { execute: typeof txExecute }) => Promise<unknown>) =>
      callback({ execute: txExecute })
    ),
    batch,
  };
  return {
    mockSessionStore: sessionStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({ coreAdapter }),
    mockCoreAdapter: coreAdapter,
    mockTxExecute: txExecute,
    mockBatch: batch,
    mockInvalidateConsentCache: vi.fn(),
    mockRecordAccountOperation: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    invalidateConsentCache: mockInvalidateConsentCache,
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

vi.mock('../account-operation-log', () => ({
  recordAccountOperation: mockRecordAccountOperation,
}));

import { listAccountConsentsHandler, withdrawAccountConsentHandler } from '../account-consents';

function createMockContext(
  cookie?: string,
  acceptLanguage?: string,
  options: { method?: string; params?: Record<string, string> } = {}
) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/consents', {
    method: options.method ?? 'GET',
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
      param: (name: string) => options.params?.[name],
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
  } as any;
}

describe('Account Page consents API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    mockTxExecute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mockBatch.mockImplementation(async (statements: Array<{ sql: string; params: unknown[] }>) => {
      for (const statement of statements) {
        expect(statement.sql.match(/\?/gu) ?? []).toHaveLength(statement.params.length);
      }
      return statements.map(() => ({ success: true, rowsAffected: 1 }));
    });
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    mockCoreAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'record-1',
          statement_id: 'privacy-policy',
          version_id: 'version-1',
          version: '20260623',
          status: 'granted',
          granted_at: 1_777_100_000,
          withdrawn_at: null,
          expires_at: null,
          client_id: 'client-abc',
          receipt_id: 'receipt-1',
          updated_at: 1_777_100_000,
          slug: 'privacy',
          category: 'privacy_policy',
          title: 'Privacy Policy',
          description: 'Privacy policy consent',
        },
      ])
      .mockResolvedValueOnce([
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
      ])
      .mockResolvedValueOnce([
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
          client_name: 'Example App',
          logo_uri: 'https://example.test/logo.png',
        },
      ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists statement and OAuth consents for the authenticated Account Page session user', async () => {
    const response = await listAccountConsentsHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current')
    );
    const body = (await response.json()) as {
      total: number;
      consents: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM user_consent_records ucr'),
      ['en', 'default', 'user-001']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM consent_records cr'),
      ['en', 'default', 'user-001']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'), [
      'en',
      'default',
      'user-001',
    ]);
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining("newer.status = 'revoked'"),
      ['en', 'default', 'user-001']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining("cr.status <> 'revoked'"),
      ['en', 'default', 'user-001']
    );
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM oauth_client_consents c'),
      ['default', 'user-001']
    );
    expect(body).toEqual({
      consents: [
        {
          kind: 'statement',
          recordType: 'document_acceptance',
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
          gateKind: 'legal_document',
        },
        {
          kind: 'statement',
          recordType: 'document_acceptance',
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
          recordType: 'release_grant',
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

  it('requires an account session before reading consent history', async () => {
    const response = await listAccountConsentsHandler(createMockContext());

    expect(response.status).toBe(401);
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
  });

  it('separates Flow release grants from document acceptances without exposing raw values', async () => {
    mockCoreAdapter.query.mockReset();
    mockCoreAdapter.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'release-1',
          statement_id: 'oidc-release:client-a',
          version_id: 'release-hash',
          version: 'release-hash',
          decision: 'selected',
          selected_value: null,
          record_status: 'active',
          granted_at: 100,
          withdrawn_at: null,
          expires_at: null,
          client_id: 'client-a',
          receipt_id: null,
          updated_at: 100,
          slug: null,
          category: null,
          title: 'OIDC authorization',
          description: null,
          protocol: 'oidc',
          consent_kind: 'scope_claim_release',
          recipient_type: 'oidc_client',
          recipient_id: 'client-a',
          flow_id: 'flow-a',
          flow_version_id: 'flow-version-a',
          flow_node_id: 'consent-a',
          released_scopes_json: JSON.stringify(['openid', 'profile']),
          released_claims_json: JSON.stringify(['email']),
          released_attributes_json: null,
          evidence_json: JSON.stringify({
            consent_gate_receipt_id: 'cgr_0123456789abcdef0123456789abcdef',
          }),
        },
      ])
      .mockResolvedValueOnce([]);

    const response = await listAccountConsentsHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current')
    );
    const body = (await response.json()) as { consents: Array<Record<string, unknown>> };

    expect(body.consents).toEqual([
      expect.objectContaining({
        id: 'release-1',
        recordType: 'release_grant',
        gateKind: 'oidc_authorization',
        targetId: 'client-a',
        releasedScopes: ['openid', 'profile'],
        releasedClaims: ['email'],
        receiptId: 'cgr_0123456789abcdef0123456789abcdef',
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('raw');
  });

  it('normalizes revoked/denied records and omits malformed optional consent data', async () => {
    mockCoreAdapter.query.mockReset();
    mockCoreAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'statement-minimal',
          statement_id: 'statement-1',
          version_id: 'version-1',
          version: '1',
          status: 'withdrawn',
          granted_at: null,
          withdrawn_at: null,
          expires_at: null,
          client_id: null,
          receipt_id: null,
          updated_at: 10,
          slug: null,
          category: null,
          title: null,
          description: null,
        },
      ])
      .mockResolvedValueOnce([
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
      ])
      .mockResolvedValueOnce([
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
          client_name: null,
          logo_uri: null,
        },
      ]);

    const response = await listAccountConsentsHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', 'ja-JP, en;q=0.8')
    );
    const body = (await response.json()) as { consents: Array<Record<string, unknown>> };

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
    mockCoreAdapter.query.mockReset();
    mockCoreAdapter.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
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
          client_name: null,
          logo_uri: null,
        },
      ]);

    const response = await listAccountConsentsHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current')
    );
    const body = (await response.json()) as { consents: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.consents[0]).not.toHaveProperty('selectedScopes');
  });

  it('accepts PostgreSQL JSONB arrays without leaking raw values', async () => {
    mockCoreAdapter.query.mockReset();
    mockCoreAdapter.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'release-jsonb',
          statement_id: 'release-client-a',
          version_id: 'hash-a',
          version: 'hash-a',
          decision: 'selected',
          selected_value: null,
          record_status: 'active',
          granted_at: 100,
          withdrawn_at: null,
          expires_at: null,
          client_id: 'client-a',
          receipt_id: null,
          updated_at: 100,
          slug: null,
          category: null,
          title: 'Release',
          description: null,
          protocol: 'oidc',
          consent_kind: 'scope_claim_release',
          recipient_type: 'oidc_client',
          recipient_id: 'client-a',
          flow_id: 'flow-a',
          flow_version_id: 'version-a',
          flow_node_id: 'gate-a',
          released_scopes_json: ['openid'],
          released_claims_json: ['email'],
          released_attributes_json: null,
          evidence_json: { consent_gate_receipt_id: 'cgr_0123456789abcdef0123456789abcdef' },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'oauth-jsonb',
          client_id: 'client-a',
          scope: 'openid email',
          selected_scopes: ['openid'],
          granted_at: 100,
          expires_at: null,
          privacy_policy_version: null,
          tos_version: null,
          consent_version: 1,
          client_name: null,
          logo_uri: null,
        },
      ]);

    const response = await listAccountConsentsHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current')
    );
    const body = (await response.json()) as { consents: Array<Record<string, unknown>> };

    expect(body.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'release-jsonb',
          releasedScopes: ['openid'],
          releasedClaims: ['email'],
          receiptId: 'cgr_0123456789abcdef0123456789abcdef',
        }),
        expect.objectContaining({ id: 'oauth-jsonb', selectedScopes: ['openid'] }),
      ])
    );
  });

  it('withdraws a document version globally through its current projection', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) },
    });
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'document-evidence-1',
      protocol: 'oidc',
      consent_kind: 'terms',
      statement_id: 'tos-a',
      statement_version: '1',
      client_id: 'client-a',
      saml_sp_id: null,
      recipient_type: 'oidc_client',
      recipient_id: 'client-a',
    });

    const response = await withdrawAccountConsentHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', undefined, {
        method: 'DELETE',
        params: { kind: 'document_acceptance', id: 'document-evidence-1' },
      })
    );

    expect(response.status).toBe(200);
    const statements = mockBatch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params: unknown[];
    }>;
    expect(statements[0]?.sql).toContain('INSERT INTO consent_records');
    expect(statements[0]?.params).toEqual(
      expect.arrayContaining(['default', 'user-001', 'document-evidence-1'])
    );
    expect(statements[1]?.sql).toContain("SET status = 'withdrawn'");
    expect(statements[1]?.params).toEqual(
      expect.arrayContaining(['default', 'user-001', 'terms', 'tos-a', '1'])
    );
    expect(mockCoreAdapter.transaction).not.toHaveBeenCalled();
    expect(mockRecordAccountOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'account.consent.withdrawn' })
    );
  });

  it('does not report withdrawal success when the atomic current-state claim loses', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) },
    });
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'document-evidence-1',
      protocol: 'oidc',
      consent_kind: 'terms',
      statement_id: 'tos-a',
      statement_version: '1',
      client_id: 'client-a',
      saml_sp_id: null,
      recipient_type: 'oidc_client',
      recipient_id: 'client-a',
    });
    mockBatch.mockResolvedValue([
      { success: true, rowsAffected: 0 },
      { success: true, rowsAffected: 0 },
    ]);

    const response = await withdrawAccountConsentHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', undefined, {
        method: 'DELETE',
        params: { kind: 'document_acceptance', id: 'document-evidence-1' },
      })
    );

    expect(response.status).toBe(409);
    expect(mockRecordAccountOperation).not.toHaveBeenCalled();
  });

  it('requires recent authentication before withdrawing consent', async () => {
    const response = await withdrawAccountConsentHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', undefined, {
        method: 'DELETE',
        params: { kind: 'document_acceptance', id: 'document-evidence-1' },
      })
    );

    expect(response.status).toBe(403);
    expect(mockCoreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('revokes a SAML release current state without accepting a cross-user record', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) },
    });
    mockCoreAdapter.queryOne.mockResolvedValueOnce(null);
    const denied = await withdrawAccountConsentHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', undefined, {
        method: 'DELETE',
        params: { kind: 'release_grant', id: 'other-user-release' },
      })
    );
    expect(denied.status).toBe(404);
    expect(mockBatch).not.toHaveBeenCalled();

    mockCoreAdapter.queryOne.mockResolvedValueOnce({
      id: 'saml-release-1',
      protocol: 'saml',
      consent_kind: 'attribute_release',
      statement_id: 'saml-release:sp-a',
      statement_version: 'hash-a',
      client_id: null,
      saml_sp_id: 'https://sp.example.test/entity',
      recipient_type: 'saml_sp',
      recipient_id: 'https://sp.example.test/entity',
    });
    const revoked = await withdrawAccountConsentHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', undefined, {
        method: 'DELETE',
        params: { kind: 'release_grant', id: 'saml-release-1' },
      })
    );

    expect(revoked.status).toBe(200);
    const statements = mockBatch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params: unknown[];
    }>;
    expect(statements[1]?.sql).toContain("SET consent_state = 'revoked'");
    expect(statements[1]?.params).toEqual(
      expect.arrayContaining(['default', 'user-001', 'https://sp.example.test/entity'])
    );
    expect(mockCoreAdapter.transaction).not.toHaveBeenCalled();
  });

  it('removes an OIDC current grant and invalidates only that Client cache entry', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) },
    });
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'oauth-grant-1',
      client_id: 'client-a',
      scope: 'openid profile',
    });

    const response = await withdrawAccountConsentHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', undefined, {
        method: 'DELETE',
        params: { kind: 'oauth_client', id: 'oauth-grant-1' },
      })
    );

    expect(response.status).toBe(200);
    const statements = mockBatch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params: unknown[];
    }>;
    expect(statements[0]?.sql).toContain('INSERT INTO consent_history');
    expect(statements[1]?.sql).toContain('DELETE FROM oauth_client_consents');
    expect(statements[1]?.params).toEqual(
      expect.arrayContaining(['default', 'user-001', 'oauth-grant-1', 'client-a'])
    );
    expect(mockCoreAdapter.transaction).not.toHaveBeenCalled();
    expect(mockInvalidateConsentCache).toHaveBeenCalledWith(
      expect.anything(),
      'user-001',
      'default',
      'client-a'
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCoreAdapter,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const coreAdapter = {
    query: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({ coreAdapter }),
    mockCoreAdapter: coreAdapter,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

import { listAccountConsentsHandler } from '../account-consents';

function createMockContext(cookie?: string) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/consents', {
    headers: cookie ? { Cookie: cookie } : {},
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
  } as any;
}

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
      expect.stringContaining('FROM oauth_client_consents c'),
      ['default', 'user-001']
    );
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
});

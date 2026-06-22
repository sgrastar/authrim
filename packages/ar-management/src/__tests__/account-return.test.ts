import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { mockChallengeStore, mockGetChallengeStoreByChallengeId, mockGetTenantIdFromContext } =
  vi.hoisted(() => {
    const challengeStore = {
      storeChallengeRpc: vi.fn(),
      consumeChallengeRpc: vi.fn(),
    };
    return {
      mockChallengeStore: challengeStore,
      mockGetChallengeStoreByChallengeId: vi.fn().mockResolvedValue(challengeStore),
      mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    };
  });

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    generateId: vi.fn(() => 'ret_001'),
    getChallengeStoreByChallengeId: mockGetChallengeStoreByChallengeId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
  };
});

import { createAccountReturnHandler, consumeAccountReturnHandler } from '../account-return';

function createSettingsKV(records: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => {
      const value = records[key];
      return value === undefined ? null : JSON.stringify(value);
    }),
  };
}

function createMockContext(
  options: {
    body?: unknown;
    params?: Record<string, string>;
    settings?: Record<string, unknown>;
  } = {}
) {
  const headers = new Headers();
  const settings = createSettingsKV(options.settings);
  return {
    env: { SETTINGS: settings } as unknown as Env,
    req: {
      param: (name: string) => options.params?.[name] ?? '',
      json: vi.fn().mockResolvedValue(options.body),
    },
    header: (name: string, value: string) => {
      headers.append(name, value);
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

describe('Account Page return transaction API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChallengeStore.storeChallengeRpc.mockResolvedValue({ success: true });
    mockChallengeStore.consumeChallengeRpc.mockResolvedValue({
      metadata: {
        path: '/mypage/security?tab=passkeys',
        accountPagePath: '/mypage',
      },
    });
  });

  it('creates a short-lived return transaction for configured Account Page paths', async () => {
    const response = await createAccountReturnHandler(
      createMockContext({
        body: { path: '/mypage/security?tab=passkeys' },
        settings: {
          'settings:tenant:default:self-service': {
            'self-service.account_page_enabled': true,
            'self-service.account_page_path': '/mypage',
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.account_return).toBe('ret_001');
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'account_page_return:ret_001',
        tenantId: 'default',
        type: 'account_page_return',
        ttl: 300,
        metadata: {
          path: '/mypage/security?tab=passkeys',
          accountPagePath: '/mypage',
        },
      })
    );
  });

  it('rejects return paths outside the Account Page prefix', async () => {
    const response = await createAccountReturnHandler(
      createMockContext({
        body: { path: '/admin/users' },
        settings: {
          'settings:tenant:default:self-service': {
            'self-service.account_page_enabled': true,
            'self-service.account_page_path': '/mypage',
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('rejects creating return transactions when Account Page is disabled', async () => {
    const response = await createAccountReturnHandler(
      createMockContext({
        body: { path: '/account/security' },
        settings: {
          'settings:tenant:default:self-service': {
            'self-service.account_page_enabled': false,
            'self-service.account_page_path': '/account',
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('account_page_disabled');
    expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('consumes a return transaction once and returns the validated redirect URL', async () => {
    const response = await consumeAccountReturnHandler(
      createMockContext({
        params: { id: 'ret_001' },
        settings: {
          'settings:tenant:default:self-service': {
            'self-service.account_page_enabled': true,
            'self-service.account_page_path': '/mypage',
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.redirect_url).toBe('/mypage/security?tab=passkeys');
    expect(mockChallengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'account_page_return:ret_001',
      tenantId: 'default',
      type: 'account_page_return',
    });
  });

  it('rejects consuming return transactions when Account Page is disabled', async () => {
    const response = await consumeAccountReturnHandler(
      createMockContext({
        params: { id: 'ret_001' },
        settings: {
          'settings:tenant:default:self-service': {
            'self-service.account_page_enabled': false,
            'self-service.account_page_path': '/mypage',
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('account_page_disabled');
  });
});

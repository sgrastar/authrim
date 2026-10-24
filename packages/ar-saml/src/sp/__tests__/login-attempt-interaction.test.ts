/**
 * The SAML sign-in start keeps the Flow interaction it checked in the stored request's context, so
 * the ACS can record a failed sign-in against it. Only an interaction the check returned is kept:
 * never the raw query value.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { handleSPLogin } from '../login';

const { mockGetIdPConfig, mockResolveCoreAdapter, mockResolveInteraction } = vi.hoisted(() => ({
  mockGetIdPConfig: vi.fn(),
  mockResolveCoreAdapter: vi.fn(),
  mockResolveInteraction: vi.fn(),
}));

vi.mock('../../admin/providers', () => ({
  getIdPConfig: (...args: unknown[]): unknown => mockGetIdPConfig(...args),
  listIdPConfigs: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveCoreAdapter,
    resolveSignInAttemptInteraction: mockResolveInteraction,
    getLogger: () => ({
      module: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }),
  };
});

describe('SP login records the interaction it belongs to', () => {
  const coreDb = { name: 'tenant-core' };
  let storeBodies: Array<Record<string, unknown>>;
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();
    storeBodies = [];
    mockGetIdPConfig.mockResolvedValue({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMapping: {},
      allowedBindings: ['post'],
    });
    mockResolveCoreAdapter.mockResolvedValue(coreDb);
    mockResolveInteraction.mockResolvedValue(null);
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      SAML_REQUEST_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn(async (_url: string, init: RequestInit) => {
            if (typeof init.body !== 'string') throw new Error('fixture-request-body-not-string');
            storeBodies.push(JSON.parse(init.body) as Record<string, unknown>);
            return new Response('OK', { status: 200 });
          }),
        })),
      } as unknown as Env['SAML_REQUEST_STORE'],
    };
  });

  function loginContext(query: Record<string, string>): Parameters<typeof handleSPLogin>[0] {
    return {
      env: mockEnv,
      req: {
        query: vi.fn((name: string) => {
          if (name === 'idp') return 'idp-1';
          if (name === 'return_url') return 'https://app.example.com/';
          return query[name];
        }),
        header: vi.fn().mockReturnValue(undefined),
      },
      get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-a' : undefined)),
      redirect: vi.fn(),
      json: vi.fn(
        (data: unknown, status: number) => new Response(JSON.stringify(data), { status })
      ),
      html: vi.fn((html: string) => new Response(html, { status: 200 })),
    } as unknown as Parameters<typeof handleSPLogin>[0];
  }

  it('keeps a live interaction in the stored request context', async () => {
    mockResolveInteraction.mockResolvedValue('int-1');

    const res = await handleSPLogin(loginContext({ runtime_interaction_id: 'int-raw' }));

    expect(res.status).toBe(200);
    // The tenant's own database checks it, for the query value.
    expect(mockResolveCoreAdapter).toHaveBeenCalledWith(mockEnv, expect.any(String), {
      tenantId: 'tenant-a',
    });
    expect(mockResolveInteraction).toHaveBeenCalledWith(coreDb, {
      tenantId: 'tenant-a',
      interactionId: 'int-raw',
    });
    // The checked id is stored, not what the query said.
    expect(storeBodies[0]?.context).toEqual({ attemptInteractionId: 'int-1' });
  });

  it.each([
    ['one that is not live', null],
    ['a check that fails', new Error('database unavailable')],
  ])('stores no interaction for %s', async (_label, outcome) => {
    if (outcome instanceof Error) mockResolveInteraction.mockRejectedValue(outcome);
    else mockResolveInteraction.mockResolvedValue(outcome);

    const res = await handleSPLogin(loginContext({ runtime_interaction_id: 'int-raw' }));

    expect(res.status).toBe(200);
    expect(storeBodies).toHaveLength(1);
    expect(storeBodies[0]).not.toHaveProperty('context');
  });

  it('stores no context for a sign-in with no interaction at all', async () => {
    const res = await handleSPLogin(loginContext({}));

    expect(res.status).toBe(200);
    // Nothing named: nothing is looked up, not even the tenant database.
    expect(mockResolveInteraction).not.toHaveBeenCalled();
    expect(storeBodies[0]).not.toHaveProperty('context');
  });
});

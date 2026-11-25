/**
 * OpenID Connect Front-Channel Logout 1.0: what is accepted, which sessions end, and the answers.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { argRec, callArg } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  createDiag: vi.fn(),
  logAuthDecision: vi.fn(),
  cleanup: vi.fn(),
  listSessions: vi.fn(),
  getSessionStore: vi.fn(),
  getSession: vi.fn(),
  invalidate: vi.fn(),
  isSharded: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createDiagnosticLoggerFromContext: mocks.createDiag,
  getDiagnosticSessionId: () => 'diag-session',
  getLogger: () => ({ module: () => ({ warn: mocks.warn }) }),
  getSessionStoreBySessionId: mocks.getSessionStore,
  getTenantIdFromContext: () => 'tenant-1',
  isShardedSessionId: mocks.isSharded,
  listExternalProviderSessions: mocks.listSessions,
}));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.getProvider }));

import { handleFrontchannelLogout } from '../handlers/frontchannel-logout';

const ENV = {} as unknown as Env;

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/auth/external/:provider/frontchannel-logout', handleFrontchannelLogout);
  instance.get('/frontchannel-logout', handleFrontchannelLogout);
  return instance;
}
const get = (
  query = 'iss=https%3A%2F%2Fop.example&sid=op-session-1',
  path = '/auth/external/suite/frontchannel-logout'
) => Promise.resolve(app().request(`https://rp.example${path}?${query}`, {}, ENV));

const session = (overrides: Record<string, unknown> = {}) => ({
  id: '0_s1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  data: { external_provider_id: 'prov-1', external_provider_sid: 'op-session-1' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProvider.mockResolvedValue({
    id: 'prov-1',
    issuer: 'https://op.example',
    clientId: 'upstream-client',
  });
  mocks.createDiag.mockResolvedValue({
    logAuthDecision: mocks.logAuthDecision,
    cleanup: mocks.cleanup,
  });
  mocks.logAuthDecision.mockResolvedValue(undefined);
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.listSessions.mockResolvedValue([{ sessionId: '0_s1' }]);
  mocks.isSharded.mockReturnValue(true);
  mocks.getSessionStore.mockReturnValue({
    stub: { getSessionRpc: mocks.getSession, invalidateSessionRpc: mocks.invalidate },
  });
  mocks.getSession.mockResolvedValue(session());
  mocks.invalidate.mockResolvedValue(true);
});

describe('a valid request', () => {
  it('ends the matching session and answers with the logout page', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html><title>Logout complete</title>');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors *"
    );
    expect(response.headers.get('X-Authrim-Diagnostic-Flow-Id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.getProvider).toHaveBeenCalledWith(ENV, 'suite', 'tenant-1');
    expect(argRec(mocks.listSessions, 0, 1)).toEqual({
      tenantId: 'tenant-1',
      providerId: 'prov-1',
      claimKind: 'sid',
      claim: 'op-session-1',
    });
    expect(callArg(mocks.getSessionStore, 0, 0)).toBe(ENV);
    expect(callArg(mocks.getSessionStore, 0, 1)).toBe('0_s1');
    expect(callArg(mocks.getSessionStore, 0, 2)).toBe('tenant-1');
    expect(mocks.invalidate).toHaveBeenCalledWith('0_s1');
  });

  it('records the number of sessions it ended and cleans up', async () => {
    mocks.listSessions.mockResolvedValue([{ sessionId: '0_s1' }, { sessionId: '0_s2' }]);
    const response = await get();
    const flowId = response.headers.get('X-Authrim-Diagnostic-Flow-Id');
    expect(argRec(mocks.createDiag, 0, 1)).toEqual({
      tenantId: 'tenant-1',
      clientId: 'upstream-client',
    });
    expect(mocks.logAuthDecision).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      flowId,
      decision: 'allow',
      reason: 'frontchannel_logout_processed',
      flow: 'frontchannel_logout',
      context: { issuer_valid: true, sid_present: true, sessions_terminated: 2 },
    });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not a sharded session id', () => mocks.isSharded.mockReturnValue(false)],
    ['no such session', () => mocks.getSession.mockResolvedValue(null)],
    ['another tenant', () => mocks.getSession.mockResolvedValue(session({ tenantId: 'tenant-2' }))],
    [
      'another provider',
      () =>
        mocks.getSession.mockResolvedValue(
          session({
            data: { external_provider_id: 'other', external_provider_sid: 'op-session-1' },
          })
        ),
    ],
    [
      'another upstream session',
      () =>
        mocks.getSession.mockResolvedValue(
          session({ data: { external_provider_id: 'prov-1', external_provider_sid: 'different' } })
        ),
    ],
    ['no session data', () => mocks.getSession.mockResolvedValue(session({ data: undefined }))],
  ])('leaves a session alone when it is %s', async (_name, arrange) => {
    arrange();
    const response = await get();
    expect(response.status).toBe(200);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(argRec(mocks.logAuthDecision).context).toMatchObject({ sessions_terminated: 0 });
  });

  it('ends no session when the OP has none', async () => {
    mocks.listSessions.mockResolvedValue([]);
    expect((await get()).status).toBe(200);
    expect(mocks.getSessionStore).not.toHaveBeenCalled();
  });
});

describe('a request that is refused', () => {
  const expectRefusal = (reason: string) => {
    const { flowId, ...rest } = argRec(mocks.logAuthDecision);
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rest).toEqual({
      diagnosticSessionId: 'diag-session',
      decision: 'deny',
      reason: 'frontchannel_logout_rejected',
      flow: 'frontchannel_logout',
      context: { validation_error: reason },
    });
  };

  it.each([
    ['a mismatching issuer', 'iss=https%3A%2F%2Fevil.example&sid=op-session-1', 'issuer_mismatch'],
    ['a missing issuer', 'sid=op-session-1', 'issuer_mismatch'],
    ['a missing sid', 'iss=https%3A%2F%2Fop.example', 'missing_sid'],
    ['an empty sid', 'iss=https%3A%2F%2Fop.example&sid=', 'missing_sid'],
  ])('answers 400 for %s', async (_name, query, reason) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid front-channel logout request');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(mocks.logAuthDecision).toHaveBeenCalledTimes(1);
    expect(mocks.logAuthDecision.mock.calls[0]?.[0]).toMatchObject({
      decision: 'deny',
      reason: 'frontchannel_logout_rejected',
      context: { validation_error: reason },
    });
    expectRefusal(reason);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('answers 400 for an unknown provider or one without an issuer, without diagnostics', async () => {
    mocks.getProvider.mockResolvedValue(null);
    expect((await get()).status).toBe(400);
    expect(mocks.createDiag).not.toHaveBeenCalled();
    mocks.getProvider.mockResolvedValue({ id: 'prov-1', clientId: 'c' });
    const response = await get();
    expect(response.status).toBe(400);
    expectRefusal('unknown_provider');
  });

  it('answers 400 when the route names no provider, without looking one up', async () => {
    const response = await get('iss=https%3A%2F%2Fop.example&sid=s', '/frontchannel-logout');
    expect(response.status).toBe(400);
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it('still answers when the diagnostics cannot be created or written', async () => {
    mocks.createDiag.mockRejectedValue(new Error('no logger'));
    expect((await get()).status).toBe(200);
    mocks.createDiag.mockResolvedValue({
      logAuthDecision: vi.fn().mockRejectedValue(new Error('diag down')),
      cleanup: vi.fn().mockRejectedValue(new Error('flush failed')),
    });
    expect((await get()).status).toBe(200);
    expect((await get('sid=s')).status).toBe(400);
  });
});

describe('a session that cannot be ended', () => {
  const failed = async () => {
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Front-channel logout failed');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(mocks.logAuthDecision).toHaveBeenCalledTimes(1);
    expect(argRec(mocks.logAuthDecision)).toMatchObject({
      decision: 'deny',
      reason: 'frontchannel_logout_rejected',
      context: { validation_error: 'session_invalidation_failed' },
    });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  };

  it('answers 500 when the store refuses to invalidate it', async () => {
    mocks.invalidate.mockResolvedValue(false);
    await failed();
    expect(mocks.warn).toHaveBeenCalledWith('Front-channel logout session invalidation failed', {
      errorType: 'Error',
    });
  });

  it('answers 500 when the store fails, and still tries the other sessions', async () => {
    mocks.listSessions.mockResolvedValue([{ sessionId: '0_s1' }, { sessionId: '0_s2' }]);
    mocks.getSession.mockRejectedValueOnce(new Error('store down')).mockResolvedValue(session());
    await failed();
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anyOf } from './helpers/matchers';
import { argRec, callArg, rec } from './helpers/mock-args';
import { NOW_MS, NOW_S, TENANT, postBackchannel } from './helpers/backchannel-harness';

const m = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getProvider: vi.fn(),
  jwtVerify: vi.fn(),
  listSessions: vi.fn(),
  sessionGet: vi.fn(),
  sessionInvalidate: vi.fn(),
  issuerUrl: vi.fn(),
  authCtx: vi.fn(),
  resolveIssuer: vi.fn(),
  resolveConfig: vi.fn(),
  resolveWebhook: vi.fn(),
  resolveTargets: vi.fn(),
  reportUnavailable: vi.fn(),
  reportNotSent: vi.fn(),
  reportIncomplete: vi.fn(),
  purge: vi.fn(),
  audit: vi.fn(),
  sendBc: vi.fn(),
  sendWebhook: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    recordReplayJti: async () => 'recorded',
    getLogger: () => ({ module: () => m.log }),
    getTenantIdFromContext: (c: { get: (k: string) => unknown }) => c.get('tenantId'),
    createErrorResponse: (_c: unknown, code: string) =>
      new Response(null, { status: 400, statusText: code }),
    safeFetchJson: async () => ({ keys: [] }),
    createDiagnosticLoggerFromContext: async () => null,
    getDiagnosticSessionId: () => undefined,
    resolveAccountDataContextByIdentifier: async () => ({ piiDb: {} }),
    listExternalProviderSessions: m.listSessions,
    isShardedSessionId: () => true,
    getSessionStoreBySessionId: () => ({
      stub: { getSessionRpc: m.sessionGet, invalidateSessionRpc: m.sessionInvalidate },
    }),
    buildRequestIssuerUrl: m.issuerUrl,
    createAuthContextFromHono: m.authCtx,
    resolveLogoutIssuerWithRetry: m.resolveIssuer,
    resolveLogoutConfig: m.resolveConfig,
    resolveLogoutWebhookConfig: m.resolveWebhook,
    resolveLogoutTargetsFromSessionClientStore: m.resolveTargets,
    reportLogoutTargetsUnavailable: m.reportUnavailable,
    reportLogoutNotSent: m.reportNotSent,
    reportIncompleteLogouts: m.reportIncomplete,
    purgeEndedSessionsFromSessionClientStore: m.purge,
    createAuditLog: m.audit,
    sendBackchannelLogoutFanout: m.sendBc,
    sendLogoutWebhookFanout: m.sendWebhook,
  };
});
vi.mock('jose', () => ({ createLocalJWKSet: () => 'JWKS', jwtVerify: m.jwtVerify }));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: m.getProvider }));
vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentitiesByProviderSub: async () => [],
  updateLinkedIdentity: async () => true,
}));

const ENV = { DB: {} } as never;
const REPO = { repo: true };
const CHANNEL_CFG = { enabled: true, marker: 'bc' };
const LOGOUT_CONFIG = { backchannel: CHANNEL_CFG };
const WEBHOOK_CFG = { enabled: true, marker: 'wh' };
const client = (id: string) => ({ client_id: id });

function sessionData(id: string) {
  return {
    tenantId: TENANT,
    userId: `user-${id}`,
    data: { external_provider_id: 'prov', external_provider_sub: 'sub-1' },
  };
}

/** Runs the handler and waits for the downstream work it handed to waitUntil. */
async function run(sessionIds: string[] = ['s1']) {
  m.listSessions.mockResolvedValue(sessionIds.map((sessionId) => ({ sessionId })));
  const { response, waited } = await postBackchannel(ENV);
  expect(response.status).toBe(200);
  expect(waited).toHaveLength(1);
  await Promise.all(waited);
  return response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  vi.clearAllMocks();
  m.getProvider.mockReset().mockResolvedValue({
    id: 'prov',
    name: 'P',
    issuer: 'https://idp.example',
    clientId: 'cid',
    jwksUri: 'https://idp.example/jwks',
  });
  m.jwtVerify.mockReset().mockResolvedValue({
    payload: {
      iss: 'https://idp.example',
      aud: 'cid',
      iat: NOW_S,
      jti: 'j',
      sub: 'sub-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    },
  });
  m.sessionGet.mockReset().mockImplementation(async (id: string) => sessionData(id));
  m.sessionInvalidate.mockReset().mockResolvedValue(true);
  m.issuerUrl.mockReset().mockReturnValue('https://request-host.example');
  m.authCtx.mockReset().mockReturnValue({ repositories: { sessionClient: REPO } });
  m.resolveIssuer.mockReset().mockResolvedValue('https://canonical.example');
  m.resolveConfig.mockReset().mockResolvedValue(LOGOUT_CONFIG);
  m.resolveWebhook.mockReset().mockResolvedValue(WEBHOOK_CFG);
  m.resolveTargets.mockReset().mockResolvedValue({
    backchannelClients: [client('bc-1')],
    webhookClients: [client('wh-1')],
  });
  m.reportUnavailable.mockReset().mockResolvedValue(undefined);
  m.reportNotSent.mockReset().mockResolvedValue(undefined);
  m.reportIncomplete.mockReset().mockResolvedValue(undefined);
  m.purge.mockReset().mockResolvedValue(undefined);
  m.audit.mockReset().mockResolvedValue(undefined);
  m.sendBc.mockReset().mockResolvedValue({ sent: 'bc-result' });
  m.sendWebhook.mockReset().mockResolvedValue({ sent: 'wh-result' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('downstream logout for an upstream notice', () => {
  it('reads the settings and the session targets with the request issuer for old records', async () => {
    const response = await run(['s1', 's2']);
    const flowId = response.headers.get('X-Authrim-Diagnostic-Flow-Id');
    expect(m.resolveIssuer).toHaveBeenCalledWith(ENV, TENANT, { log: m.log });
    expect(m.resolveConfig).toHaveBeenCalledWith(ENV, TENANT);
    expect(m.resolveWebhook).toHaveBeenCalledWith(ENV, TENANT);
    expect(m.resolveTargets.mock.calls).toEqual([
      [ENV, TENANT, 's1', REPO, 'https://request-host.example'],
      [ENV, TENANT, 's2', REPO, 'https://request-host.example'],
    ]);
    expect(m.reportUnavailable).toHaveBeenCalledWith(ENV, {
      tenantId: TENANT,
      trigger: 'upstream_backchannel_logout',
      sessionCount: 0,
      metadata: { provider_id: 'prov', upstream_flow_id: flowId },
      log: m.log,
    });
  });

  it('sends the back-channel and webhook notices with the canonical issuer', async () => {
    await run();
    const sessions = [
      {
        sessionId: 's1',
        userId: 'user-s1',
        backchannelClients: [client('bc-1')],
        webhookClients: [client('wh-1')],
      },
    ];
    const bc = argRec(m.sendBc, 0, 1);
    expect(bc).toMatchObject({
      tenantId: TENANT,
      issuer: 'https://canonical.example',
      sessions,
      config: CHANNEL_CFG,
      startedAt: NOW_MS,
      log: m.log,
    });
    expect(bc.onIncomplete).toEqual(expect.any(Function));
    expect(bc.onAlert).toEqual(expect.any(Function));
    expect(callArg(m.sendBc, 0, 0)).toBe(ENV);
    const wh = argRec(m.sendWebhook, 0, 1);
    expect(wh).toMatchObject({
      issuer: 'https://canonical.example',
      sessions,
      config: WEBHOOK_CFG,
      log: m.log,
    });
    expect(wh.onIncomplete).toEqual(expect.any(Function));
    expect(m.log.info).toHaveBeenCalledWith('Downstream logout for upstream notice completed', {
      upstreamFlowId: anyOf(String),
      sessions: 1,
      backchannel: { sent: 'bc-result' },
      webhook: { sent: 'wh-result' },
    });
  });

  it('audits each ended session with the clients that were told', async () => {
    const response = await run(['s1', 's2']);
    const flowId = response.headers.get('X-Authrim-Diagnostic-Flow-Id');
    const logoutAudits = m.audit.mock.calls.map((c) => rec(c[1]));
    expect(logoutAudits).toHaveLength(2);
    expect(logoutAudits[0]).toEqual({
      tenantId: TENANT,
      userId: 'user-s1',
      action: 'user.logout',
      resource: 'session',
      resourceId: 's1',
      ipAddress: '',
      userAgent: '',
      metadata: JSON.stringify({
        reason: 'upstream_backchannel_logout',
        provider_id: 'prov',
        upstream_flow_id: flowId,
        backchannel_client_ids: ['bc-1'],
        webhook_client_ids: ['wh-1'],
      }),
      severity: 'info',
    });
    expect(logoutAudits[1]?.resourceId).toBe('s2');
    expect(callArg(m.audit, 0, 0)).toBe(ENV);
  });

  it('does not list clients of a disabled channel in the audit', async () => {
    m.resolveConfig.mockResolvedValue({ backchannel: { enabled: false } });
    m.resolveWebhook.mockResolvedValue({ enabled: false });
    await run();
    const meta = JSON.parse(String(argRec(m.audit, 0, 1).metadata)) as Record<string, unknown>;
    expect(meta.backchannel_client_ids).toEqual([]);
    expect(meta.webhook_client_ids).toEqual([]);
  });

  it('lists no webhook clients when the webhook settings are unreadable, and records why', async () => {
    m.resolveWebhook.mockRejectedValue(new Error('kv down'));
    await run(['s1', 's2']);
    expect(m.log.warn).toHaveBeenCalledWith('Logout webhook settings could not be read', {
      error: 'kv down',
    });
    expect(m.sendWebhook).not.toHaveBeenCalled();
    const meta = JSON.parse(String(argRec(m.audit, 0, 1).metadata)) as Record<string, unknown>;
    expect(meta.webhook_client_ids).toEqual([]);
    expect(m.reportIncomplete).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({
        incomplete: [
          { kind: 'webhook', sessionIds: ['s1', 's2'], reason: 'webhook_settings_unavailable' },
        ],
      })
    );
    // the sessions that were not fully told keep their records
    expect(m.purge).not.toHaveBeenCalled();
  });

  it('names only the sessions that have webhook clients as not told', async () => {
    m.resolveWebhook.mockRejectedValue('text');
    m.resolveTargets
      .mockResolvedValueOnce({ backchannelClients: [], webhookClients: [client('w')] })
      .mockResolvedValueOnce({ backchannelClients: [client('b')], webhookClients: [] });
    await run(['s1', 's2']);
    expect(m.log.warn).toHaveBeenCalledWith('Logout webhook settings could not be read', {
      error: 'text',
    });
    expect(rec(argRec(m.reportIncomplete, 0, 1)).incomplete).toEqual([
      { kind: 'webhook', sessionIds: ['s1'], reason: 'webhook_settings_unavailable' },
    ]);
    expect(argRec(m.sendBc, 0, 1).sessions).toHaveLength(2);
    expect(m.purge).toHaveBeenCalledWith(ENV, TENANT, ['s2']);
  });

  it('falls back to the default logout settings when they cannot be read', async () => {
    const actual =
      await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
    m.resolveConfig.mockRejectedValue(new Error('cfg down'));
    await run();
    expect(m.log.warn).toHaveBeenCalledWith('Logout settings could not be read', {
      error: 'cfg down',
    });
    expect(argRec(m.sendBc, 0, 1).config).toBe(actual.DEFAULT_LOGOUT_CONFIG.backchannel);
    m.resolveConfig.mockRejectedValue('t');
    await run();
    expect(m.log.warn).toHaveBeenLastCalledWith('Logout settings could not be read', {
      error: 't',
    });
  });

  it('keeps going without the clients of a session whose targets cannot be read', async () => {
    m.resolveTargets
      .mockRejectedValueOnce(new Error('store down'))
      .mockResolvedValueOnce({ backchannelClients: [client('b')], webhookClients: [] });
    const response = await run(['s1', 's2']);
    expect(m.log.warn).toHaveBeenCalledWith(
      'Failed to load logout clients from SessionClientStore',
      {
        sessionId: 's1',
        error: 'store down',
      }
    );
    expect(rec(argRec(m.reportUnavailable, 0, 1))).toMatchObject({
      sessionCount: 1,
      metadata: {
        provider_id: 'prov',
        upstream_flow_id: response.headers.get('X-Authrim-Diagnostic-Flow-Id'),
      },
    });
    const sessions = argRec(m.sendBc, 0, 1).sessions as Array<Record<string, unknown>>;
    expect(sessions[0]).toEqual({
      sessionId: 's1',
      userId: 'user-s1',
      backchannelClients: [],
      webhookClients: [],
    });
    // the unreadable session keeps its record; the other is removed
    expect(m.purge).toHaveBeenCalledWith(ENV, TENANT, ['s2']);
  });

  it('reports a non-Error target failure as text', async () => {
    m.resolveTargets.mockRejectedValueOnce('boom');
    await run();
    expect(m.log.warn).toHaveBeenCalledWith(
      'Failed to load logout clients from SessionClientStore',
      expect.objectContaining({ error: 'boom' })
    );
  });

  it('sends nothing when the tenant issuer cannot be resolved, and reports who was not told', async () => {
    m.resolveIssuer.mockResolvedValue(null);
    const response = await run();
    expect(m.sendBc).not.toHaveBeenCalled();
    expect(m.sendWebhook).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
    expect(m.purge).not.toHaveBeenCalled();
    expect(m.reportNotSent).toHaveBeenCalledWith(ENV, {
      tenantId: TENANT,
      trigger: 'upstream_backchannel_logout',
      sessions: [
        {
          sessionId: 's1',
          userId: 'user-s1',
          backchannelClients: [client('bc-1')],
          webhookClients: [client('wh-1')],
        },
      ],
      backchannelEnabled: true,
      webhookEnabled: true,
      metadata: {
        provider_id: 'prov',
        upstream_flow_id: response.headers.get('X-Authrim-Diagnostic-Flow-Id'),
      },
      log: m.log,
    });
  });

  it('reports the enabled flags of the settings when there is no issuer', async () => {
    m.resolveIssuer.mockResolvedValue(null);
    m.resolveConfig.mockResolvedValue({ backchannel: { enabled: false } });
    m.resolveWebhook.mockResolvedValue({ enabled: false });
    await run();
    expect(argRec(m.reportNotSent, 0, 1)).toMatchObject({
      backchannelEnabled: false,
      webhookEnabled: false,
    });
    m.resolveWebhook.mockResolvedValue(null);
    await run();
    expect(m.reportNotSent).toHaveBeenLastCalledWith(
      ENV,
      expect.objectContaining({ webhookEnabled: true })
    );
  });

  it('records a failed back-channel send in the audit log with its trigger', async () => {
    await run();
    const onAlert = argRec(m.sendBc, 0, 1).onAlert as (d: unknown) => Promise<void>;
    m.audit.mockClear();
    await onAlert({ userId: 'u9', sessionId: 's9', clientId: 'rp-9', attempts: 3 });
    const entry = argRec(m.audit, 0, 1);
    expect(entry).toMatchObject({
      tenantId: TENANT,
      userId: 'u9',
      action: 'backchannel_logout.failed',
      resource: 'session',
      resourceId: 's9',
      ipAddress: '',
      userAgent: '',
      severity: 'warning',
    });
    expect(JSON.parse(String(entry.metadata))).toMatchObject({
      client_id: 'rp-9',
      attempts: 3,
      trigger: 'upstream_backchannel_logout',
      provider_id: 'prov',
    });
  });

  it('logs and carries on when an audit entry cannot be written', async () => {
    m.audit.mockRejectedValue(new Error('audit down'));
    await run();
    expect(m.log.error).toHaveBeenCalledWith(
      'Failed to create audit log for upstream logout',
      { action: 'audit_log' },
      expect.any(Error)
    );
    expect(m.purge).toHaveBeenCalledWith(ENV, TENANT, ['s1']);
  });

  it('reports the notices that could not be sent and keeps those sessions', async () => {
    m.sendBc.mockImplementation(async (_env: unknown, args: Record<string, unknown>) => {
      (args.onIncomplete as (i: unknown) => void)({ kind: 'backchannel', sessionIds: ['s2'] });
      return {};
    });
    const response = await run(['s1', 's2', 's3']);
    expect(m.reportIncomplete).toHaveBeenCalledWith(ENV, {
      tenantId: TENANT,
      trigger: 'upstream_backchannel_logout',
      sessions: argRec(m.sendBc, 0, 1).sessions,
      incomplete: [{ kind: 'backchannel', sessionIds: ['s2'] }],
      metadata: {
        provider_id: 'prov',
        upstream_flow_id: response.headers.get('X-Authrim-Diagnostic-Flow-Id'),
      },
      log: m.log,
    });
    expect(m.purge).toHaveBeenCalledWith(ENV, TENANT, ['s1', 's3']);
  });

  it('passes the webhook fan-out its own incomplete collector', async () => {
    m.sendWebhook.mockImplementation(async (_env: unknown, args: Record<string, unknown>) => {
      (args.onIncomplete as (i: unknown) => void)({ kind: 'webhook', sessionIds: ['s1'] });
      return {};
    });
    await run();
    expect(m.reportIncomplete).toHaveBeenCalledTimes(1);
    expect(m.purge).not.toHaveBeenCalled();
  });

  it('does not report or keep anything when every notice was sent', async () => {
    await run();
    expect(m.reportIncomplete).not.toHaveBeenCalled();
    expect(m.purge).toHaveBeenCalledWith(ENV, TENANT, ['s1']);
  });

  it('logs a downstream failure instead of throwing it', async () => {
    m.sendBc.mockRejectedValue(new Error('send crashed'));
    await run();
    expect(m.log.error).toHaveBeenCalledWith(
      'Downstream logout for upstream notice failed',
      { upstreamFlowId: anyOf(String) },
      expect.any(Error)
    );
    expect(m.purge).not.toHaveBeenCalled();
  });
});

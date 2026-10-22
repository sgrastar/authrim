/**
 * Upstream back-channel logout → downstream relying parties.
 *
 * When the upstream IdP ends a user's session, the Authrim sessions that came from it end, and the
 * relying parties signed in through those sessions are told as they are on a user logout: one
 * logout token per client with that client's sid, sent after the upstream has its answer.
 *
 * Real crypto on both sides: the upstream logout token is signed with an upstream key and
 * verified by the handler; the downstream logout tokens are signed with the OP key from the
 * KeyManager and verified here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import type { LogoutConfig, SessionClientWithDetails } from '@authrim/ar-lib-core';

const UPSTREAM_ISSUER = 'https://upstream.example.com';
const UPSTREAM_CLIENT_ID = 'authrim-at-upstream';
const OP_ISSUER = 'https://op.example.com';
// The tenant's canonical issuer: not the host the upstream notice came in on (OP_ISSUER).
const CANONICAL_ISSUER = 'https://login.tenant-a.example';
const SESSION_ID = '7_session_upstream_user';
const RP_A = 'https://rp-a.example.com/backchannel-logout';
const RP_B = 'https://rp-b.example.com/backchannel-logout';
const RP_C_WEBHOOK = 'https://rp-c.example.com/logout-webhook';
const WEBHOOK_KEY = 'a'.repeat(64);

const {
  mockListExternalProviderSessions,
  mockSessionGet,
  mockSessionInvalidate,
  mockResolveTargets,
  mockCreateAuditLog,
  mockResolveLogoutConfig,
  mockResolveLogoutWebhookConfig,
  mockResolveLogoutIssuer,
  mockSafeFetchJson,
  mockDiagnosticAuthDecision,
} = vi.hoisted(() => ({
  mockListExternalProviderSessions: vi.fn(),
  mockSessionGet: vi.fn(),
  mockSessionInvalidate: vi.fn(),
  mockResolveTargets: vi.fn(),
  mockCreateAuditLog:
    vi.fn<(env: unknown, entry: { action: string; metadata: string }) => Promise<void>>(),
  mockResolveLogoutConfig: vi.fn(),
  mockResolveLogoutWebhookConfig: vi.fn(),
  mockResolveLogoutIssuer: vi.fn(),
  mockSafeFetchJson: vi.fn(),
  mockDiagnosticAuthDecision: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    ...actual,
    getLogger: vi.fn(() => ({ module: vi.fn(() => noopLog) })),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (_c: unknown, code: string) => new Response(null, { status: code === 'internal' ? 500 : 400 })
    ),
    AR_ERROR_CODES: {
      ...actual.AR_ERROR_CODES,
      ADMIN_RESOURCE_NOT_FOUND: 'not_found',
      VALIDATION_REQUIRED_FIELD: 'required',
      VALIDATION_INVALID_VALUE: 'invalid',
      INTERNAL_ERROR: 'internal',
    },
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue({
      logTokenValidation: vi.fn().mockResolvedValue(undefined),
      logAuthDecision: mockDiagnosticAuthDecision,
      cleanup: vi.fn().mockResolvedValue(undefined),
    }),
    getDiagnosticSessionId: vi.fn().mockReturnValue(undefined),
    safeFetchJson: mockSafeFetchJson,
    resolveAccountDataContextByIdentifier: vi.fn().mockResolvedValue({
      accountId: 'account:user-1',
      legacyUserId: 'user-1',
      piiDb: { binding: 'pii' },
    }),
    listExternalProviderSessions: mockListExternalProviderSessions,
    isShardedSessionId: vi.fn(() => true),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: { getSessionRpc: mockSessionGet, invalidateSessionRpc: mockSessionInvalidate },
    })),
    createAuthContextFromHono: vi.fn(() => ({ repositories: { sessionClient: {} } })),
    resolveLogoutTargetsFromSessionClientStore: mockResolveTargets,
    resolveLogoutConfig: mockResolveLogoutConfig,
    resolveLogoutWebhookConfig: mockResolveLogoutWebhookConfig,
    resolveLogoutIssuer: mockResolveLogoutIssuer,
    createAuditLog: mockCreateAuditLog,
  };
});

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: vi.fn().mockResolvedValue({
    id: 'provider-upstream',
    name: 'Upstream',
    issuer: 'https://upstream.example.com',
    clientId: 'authrim-at-upstream',
    jwksUri: 'https://upstream.example.com/jwks',
  }),
}));

vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentitiesByProviderSub: vi.fn().mockResolvedValue([]),
  updateLinkedIdentity: vi.fn().mockResolvedValue(true),
}));

import {
  DEFAULT_LOGOUT_CONFIG,
  DEFAULT_LOGOUT_WEBHOOK_CONFIG,
  encryptValue,
} from '@authrim/ar-lib-core';
import { handleBackchannelLogout } from '../handlers/backchannel-logout';

type Keys = { privateKey: CryptoKey; publicJwk: jose.JWK };

async function rsaKeys(kid: string): Promise<Keys> {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
  return {
    privateKey: privateKey as CryptoKey,
    publicJwk: { ...(await jose.exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
}

/** `oidcSub`: the sub the client's ID token carried, as the session-client records it. */
function backchannelClient(clientId: string, uri: string, oidcSid: string, oidcSub?: string) {
  return {
    id: `sc-${clientId}`,
    tenant_id: 'tenant-a',
    session_id: SESSION_ID,
    client_id: clientId,
    oidc_sid: oidcSid,
    ...(oidcSub ? { oidc_sub: oidcSub } : {}),
    first_token_at: 1,
    last_token_at: 1,
    last_seen_at: null,
    client_name: clientId,
    backchannel_logout_uri: uri,
    backchannel_logout_session_required: true,
    frontchannel_logout_uri: null,
    frontchannel_logout_session_required: false,
  } satisfies SessionClientWithDetails;
}

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    })),
  };
}

let upstream: Keys;
let op: Keys;
let opPrivatePem: string;

async function upstreamLogoutToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new jose.SignJWT({
    sub: 'upstream-sub-1',
    sid: 'upstream-sid-1',
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    jti: crypto.randomUUID(),
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'upstream-key' })
    .setIssuer(UPSTREAM_ISSUER)
    .setAudience(UPSTREAM_CLIENT_ID)
    .setIssuedAt()
    .sign(upstream.privateKey);
}

function buildContext(logoutToken: string) {
  const settings = memoryKv();
  const pending: Promise<unknown>[] = [];
  const headers = new Map<string, string>();
  const env = {
    ISSUER_URL: OP_ISSUER,
    RP_TOKEN_ENCRYPTION_KEY: WEBHOOK_KEY,
    SETTINGS: settings,
    KEY_MANAGER: {
      idFromName: vi.fn(() => 'km'),
      get: vi.fn(() => ({
        getAllPublicKeysRpc: vi.fn().mockResolvedValue([op.publicJwk]),
        getActiveKeyWithPrivateRpc: vi
          .fn()
          .mockResolvedValue({ kid: 'op-key', privatePEM: opPrivatePem }),
      })),
    },
  };
  const c = {
    req: {
      raw: new Request(`${OP_ISSUER}/auth/external/upstream/backchannel-logout`, {
        method: 'POST',
      }),
      param: vi.fn(() => 'upstream'),
      header: vi.fn((name: string) =>
        name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
      ),
      parseBody: vi.fn().mockResolvedValue({ logout_token: logoutToken }),
    },
    env,
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-a' : undefined)),
    header: vi.fn((name: string, value: string) => headers.set(name, value)),
    executionCtx: { waitUntil: vi.fn((p: Promise<unknown>) => pending.push(p)) },
  };
  return { c, settings, pending };
}

type Sent = { url: string; token: string; body: string };
type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : input;
}

function captureDownstream(statusFor: (url: string) => number = () => 200) {
  const sent: Sent[] = [];
  globalThis.fetch = vi.fn(async (input: FetchInput, init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    sent.push({
      url,
      token: body.get('logout_token') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(null, { status: statusFor(url) });
  }) as typeof fetch;
  return sent;
}

async function verifyDownstream(token: string) {
  const { payload, protectedHeader } = await jose.jwtVerify(
    token,
    await jose.importJWK(op.publicJwk, 'RS256'),
    { issuer: CANONICAL_ISSUER, algorithms: ['RS256'] }
  );
  return { payload, protectedHeader };
}

function config(overrides: Partial<LogoutConfig['backchannel']> = {}): LogoutConfig {
  return {
    ...DEFAULT_LOGOUT_CONFIG,
    backchannel: {
      ...DEFAULT_LOGOUT_CONFIG.backchannel,
      retry: { ...DEFAULT_LOGOUT_CONFIG.backchannel.retry, max_attempts: 0 },
      ...overrides,
    },
  };
}

describe('upstream back-channel logout reaches downstream relying parties', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    upstream ??= await rsaKeys('upstream-key');
    if (!op) {
      op = await rsaKeys('op-key');
      opPrivatePem = await jose.exportPKCS8(op.privateKey);
    }
    mockSafeFetchJson.mockResolvedValue({ keys: [upstream.publicJwk] });
    mockListExternalProviderSessions.mockResolvedValue([
      { sessionId: SESSION_ID, userId: 'user-1', expiresAtMs: Date.now() + 60_000 },
    ]);
    mockSessionGet.mockResolvedValue({
      id: SESSION_ID,
      tenantId: 'tenant-a',
      userId: 'user-1',
      data: {
        external_provider_id: 'provider-upstream',
        external_provider_sub: 'upstream-sub-1',
        external_provider_sid: 'upstream-sid-1',
      },
    });
    mockSessionInvalidate.mockResolvedValue(true);
    mockResolveTargets.mockResolvedValue({
      backchannelClients: [
        backchannelClient('rp-a', RP_A, 'sid-for-rp-a', 'sub-for-rp-a'),
        backchannelClient('rp-b', RP_B, 'sid-for-rp-b', 'sub-for-rp-b'),
      ],
      frontchannelClients: [],
      webhookClients: [],
    });
    mockCreateAuditLog.mockResolvedValue(undefined);
    mockResolveLogoutConfig.mockResolvedValue(config());
    mockResolveLogoutWebhookConfig.mockResolvedValue(DEFAULT_LOGOUT_WEBHOOK_CONFIG);
    mockResolveLogoutIssuer.mockResolvedValue(CANONICAL_ISSUER);
  });

  it('sends each downstream client its own logout token with that client sid and sub', async () => {
    const sent = captureDownstream();
    const { c, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);
    expect(response.status).toBe(200);
    expect(mockSessionInvalidate).toHaveBeenCalledWith(SESSION_ID);
    await Promise.all(pending);

    const downstream = sent.filter((s) => s.url === RP_A || s.url === RP_B);
    expect(downstream.map((s) => s.url).sort()).toEqual([RP_A, RP_B]);
    for (const { url, token } of downstream) {
      const { payload, protectedHeader } = await verifyDownstream(token);
      const clientId = url === RP_A ? 'rp-a' : 'rp-b';
      expect(protectedHeader.kid).toBe('op-key');
      expect(payload.aud).toBe(clientId);
      expect(payload.sid).toBe(`sid-for-${clientId}`);
      // The sub the client's ID token carried, never the user's internal id.
      expect(payload.sub).toBe(`sub-for-${clientId}`);
      expect(JSON.stringify(payload)).not.toContain('user-1');
      expect(payload.events).toEqual({
        'http://schemas.openid.net/event/backchannel-logout': {},
      });
      expect(payload.nonce).toBeUndefined();
    }
    // The tokens are signed for the tenant's canonical issuer, whatever host the notice came in on.
    expect(mockResolveLogoutIssuer).toHaveBeenCalledWith(c.env, 'tenant-a');
    // The targets are read for the session that was ended, with the issuer the request is on
    // (it derives the sid of an old record as it was when issued).
    expect(mockResolveTargets).toHaveBeenCalledWith(
      c.env,
      'tenant-a',
      SESSION_ID,
      expect.anything(),
      OP_ISSUER
    );
  });

  it('names the session by its sid alone for a client with no recorded sub', async () => {
    mockResolveTargets.mockResolvedValue({
      backchannelClients: [backchannelClient('rp-a', RP_A, 'sid-for-rp-a')],
      frontchannelClients: [],
      webhookClients: [],
    });
    const sent = captureDownstream();
    const { c, pending } = buildContext(await upstreamLogoutToken());

    expect((await handleBackchannelLogout(c as never)).status).toBe(200);
    await Promise.all(pending);

    const downstream = sent.filter((s) => s.url === RP_A);
    expect(downstream).toHaveLength(1);
    const { payload } = await verifyDownstream(downstream[0].token);
    expect(payload.sid).toBe('sid-for-rp-a');
    expect(payload).not.toHaveProperty('sub');
    expect(JSON.stringify(payload)).not.toContain('user-1');
  });

  it('answers the upstream before the downstream sends finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput) => {
      sent.push(urlOf(input));
      await gate;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const { c, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(200);
    expect(c.executionCtx.waitUntil).toHaveBeenCalled();
    release();
    await Promise.all(pending);
    expect(sent.sort()).toEqual([RP_A, RP_B]);
  });

  it('records a downstream rejection for the admin failure list', async () => {
    captureDownstream((url) => (url === RP_B ? 400 : 200));
    const { c, settings, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(JSON.parse(settings.store.get('logout:failures:rp-b') ?? 'null')).toMatchObject({
      statusCode: 400,
    });
    expect(settings.store.has('logout:failures:rp-a')).toBe(false);
  });

  it('links the downstream logout to the upstream notice in audit and diagnostics', async () => {
    captureDownstream((url) => (url === RP_B ? 503 : 200));
    mockResolveLogoutConfig.mockResolvedValue(config({ on_final_failure: 'alert' }));
    const { c, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);
    await Promise.all(pending);
    const flowId = vi
      .mocked(c.header)
      .mock.calls.find(([name]) => name === 'X-Authrim-Diagnostic-Flow-Id')?.[1];
    expect(flowId).toEqual(expect.any(String));
    expect(response.status).toBe(200);

    expect(mockDiagnosticAuthDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId,
        decision: 'allow',
        context: expect.objectContaining({ downstream_logout_sessions: 1 }),
      })
    );
    const logoutAudit = mockCreateAuditLog.mock.calls.find(
      ([, entry]) => entry.action === 'user.logout'
    )?.[1];
    expect(logoutAudit).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user-1',
      resourceId: SESSION_ID,
    });
    expect(JSON.parse(logoutAudit?.metadata ?? 'null')).toMatchObject({
      reason: 'upstream_backchannel_logout',
      provider_id: 'provider-upstream',
      upstream_flow_id: flowId,
      backchannel_client_ids: ['rp-a', 'rp-b'],
    });
    const failureAudit = mockCreateAuditLog.mock.calls.find(
      ([, entry]) => entry.action === 'backchannel_logout.failed'
    )?.[1];
    expect(failureAudit).toMatchObject({ resourceId: SESSION_ID });
    expect(JSON.parse(failureAudit?.metadata ?? 'null')).toMatchObject({
      client_id: 'rp-b',
      trigger: 'upstream_backchannel_logout',
      upstream_flow_id: flowId,
    });
  });

  it('notifies relying parties of sessions it ended even when another could not be ended', async () => {
    const sent = captureDownstream();
    mockListExternalProviderSessions.mockResolvedValue([
      { sessionId: SESSION_ID, userId: 'user-1', expiresAtMs: Date.now() + 60_000 },
      { sessionId: '8_session_other', userId: 'user-1', expiresAtMs: Date.now() + 60_000 },
    ]);
    mockSessionGet.mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      tenantId: 'tenant-a',
      userId: 'user-1',
      data: {
        external_provider_id: 'provider-upstream',
        external_provider_sub: 'upstream-sub-1',
        external_provider_sid: 'upstream-sid-1',
      },
    }));
    mockSessionInvalidate.mockImplementation(async (sessionId: string) => {
      if (sessionId === SESSION_ID) return true;
      throw new Error('store unavailable');
    });
    const { c, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);
    await Promise.all(pending);

    expect(response.status).toBe(500);
    expect(sent.map((s) => s.url).sort()).toEqual([RP_A, RP_B]);
    expect(mockResolveTargets).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '8_session_other',
      expect.anything(),
      expect.anything()
    );
  });

  it('does not hold a later session behind a slow relying party of an earlier one', async () => {
    const SLOW = 'https://slow.example.com/backchannel-logout';
    const sessionIds = ['1_session_slow', '2_session_slow', '3_session_fast'];
    mockListExternalProviderSessions.mockResolvedValue(
      sessionIds.map((sessionId) => ({
        sessionId,
        userId: 'user-1',
        expiresAtMs: Date.now() + 60_000,
      }))
    );
    mockSessionGet.mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      tenantId: 'tenant-a',
      userId: 'user-1',
      data: {
        external_provider_id: 'provider-upstream',
        external_provider_sub: 'upstream-sub-1',
        external_provider_sid: 'upstream-sid-1',
      },
    }));
    mockResolveTargets.mockImplementation(async (_env, _tenant, sessionId: string) => ({
      backchannelClients: [
        sessionId === '3_session_fast'
          ? backchannelClient('rp-a', RP_A, 'sid-fast')
          : backchannelClient(`slow-${sessionId}`, SLOW, `sid-${sessionId}`),
      ],
      frontchannelClients: [],
      webhookClients: [],
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput) => {
      const url = urlOf(input);
      sent.push(url);
      if (url === SLOW) await gate;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const { c, pending } = buildContext(await upstreamLogoutToken({ sid: undefined }));

    const response = await handleBackchannelLogout(c as never);
    expect(response.status).toBe(200);
    // The slow relying parties have not answered: the fast one is still told.
    await vi.waitFor(() => expect(sent).toContain(RP_A));
    release();
    await Promise.all(pending);
  });

  it('sends the logout webhook to webhook clients as a user logout does', async () => {
    const sent = captureDownstream();
    mockResolveLogoutWebhookConfig.mockResolvedValue({
      ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
      enabled: true,
      retry: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG.retry, max_attempts: 0 },
    });
    mockResolveTargets.mockResolvedValue({
      backchannelClients: [backchannelClient('rp-a', RP_A, 'sid-for-rp-a')],
      frontchannelClients: [],
      webhookClients: [
        {
          id: 'sc-rp-c',
          session_id: SESSION_ID,
          client_id: 'rp-c',
          oidc_sid: 'sid-for-rp-c',
          oidc_sub: 'sub-for-rp-c',
          client_name: 'rp-c',
          logout_webhook_uri: RP_C_WEBHOOK,
          logout_webhook_secret_encrypted: (
            await encryptValue('webhook-secret', WEBHOOK_KEY, 'AES-256-GCM', 1)
          ).encrypted,
        },
      ],
    });
    const { c, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(sent.map((s) => s.url).sort()).toEqual([RP_A, RP_C_WEBHOOK]);
    // The webhook names the tenant's canonical issuer and the sub the client's ID token carried,
    // never the user's internal id.
    const webhook = JSON.parse(sent.find((s) => s.url === RP_C_WEBHOOK)!.body);
    expect(webhook).toMatchObject({
      event: 'user.logout',
      client_id: 'rp-c',
      issuer: CANONICAL_ISSUER,
      sub: 'sub-for-rp-c',
      sid: 'sid-for-rp-c',
    });
    expect(JSON.stringify(webhook)).not.toContain('user-1');
  });

  it('sends nothing downstream when the tenant issuer cannot be resolved, and still answers the upstream', async () => {
    mockResolveLogoutIssuer.mockRejectedValue(new Error('lookup failed'));
    mockResolveLogoutWebhookConfig.mockResolvedValue({
      ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
      enabled: true,
    });
    const sent = captureDownstream();
    const { c, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(mockSessionInvalidate).toHaveBeenCalledWith(SESSION_ID);
    // No other issuer is made up from the request's host.
    expect(sent).toEqual([]);
  });

  it('keeps notifying the other sessions when one session fails, and waits for them', async () => {
    const RP_D_WEBHOOK = 'https://rp-d.example.com/logout-webhook';
    mockResolveLogoutWebhookConfig.mockResolvedValue({
      ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
      enabled: true,
      retry: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG.retry, max_attempts: 0 },
    });
    mockListExternalProviderSessions.mockResolvedValue(
      ['1_session_broken', '2_session_ok'].map((sessionId) => ({
        sessionId,
        userId: 'user-1',
        expiresAtMs: Date.now() + 60_000,
      }))
    );
    mockSessionGet.mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      tenantId: 'tenant-a',
      userId: 'user-1',
      data: {
        external_provider_id: 'provider-upstream',
        external_provider_sub: 'upstream-sub-1',
        external_provider_sid: 'upstream-sid-1',
      },
    }));
    const secret = (await encryptValue('webhook-secret', WEBHOOK_KEY, 'AES-256-GCM', 1)).encrypted;
    mockResolveTargets.mockImplementation(async (_env, _tenant, sessionId: string) => ({
      backchannelClients: [],
      frontchannelClients: [],
      webhookClients: [
        {
          id: `sc-${sessionId}`,
          session_id: sessionId,
          client_id: sessionId === '2_session_ok' ? 'rp-d' : 'rp-broken',
          oidc_sid: `sid-${sessionId}`,
          client_name: null,
          logout_webhook_uri: sessionId === '2_session_ok' ? RP_D_WEBHOOK : RP_C_WEBHOOK,
          logout_webhook_secret_encrypted: secret,
        },
      ],
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput) => {
      const url = urlOf(input);
      sent.push(url);
      if (url === RP_D_WEBHOOK) await gate;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const { c, settings, pending } = buildContext(await upstreamLogoutToken({ sid: undefined }));
    const kvGet = settings.get.getMockImplementation()!;
    // The store fails for the first session's webhook lock only.
    settings.get.mockImplementation(async (key: string) => {
      if (key.includes('1_session_broken') && key.includes('rp-broken')) {
        throw new Error('kv unavailable');
      }
      return kvGet(key);
    });

    const response = await handleBackchannelLogout(c as never);
    expect(response.status).toBe(200);
    let settled = false;
    const done = Promise.all(pending).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(sent).toContain(RP_D_WEBHOOK));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await done;
    expect(sent).not.toContain(RP_C_WEBHOOK);
  });

  it('sends nothing downstream when back-channel logout is disabled', async () => {
    const sent = captureDownstream();
    mockResolveLogoutConfig.mockResolvedValue(config({ enabled: false }));
    const { c, pending } = buildContext(await upstreamLogoutToken());

    const response = await handleBackchannelLogout(c as never);
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(sent.filter((s) => s.url === RP_A || s.url === RP_B)).toEqual([]);
  });

  it('does not notify downstream for a rejected upstream token', async () => {
    const sent = captureDownstream();
    const { c, pending } = buildContext(await upstreamLogoutToken({ nonce: 'x' }));

    const response = await handleBackchannelLogout(c as never);
    await Promise.all(pending);

    expect(response.status).toBe(400);
    expect(mockSessionInvalidate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

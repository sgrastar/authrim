import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { STATUS_CODES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  row: null as null | { state: string; saml_sp_id: string | null; context_json: string | null },
  consume: vi.fn(),
  errorResponse: vi.fn(async (..._args: unknown[]) => '<failure/>'),
  send: vi.fn(
    (_c: unknown, acs: string, xml: string, relayState?: string) =>
      new Response(JSON.stringify({ acs, xml, relayState }), { status: 200 })
  ),
  audit: vi.fn(),
  sp: null as Record<string, unknown> | null,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveSamlRequestTtlSeconds: vi.fn(async () => 300),
    getLogger: () => ({ module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }),
    // A one-row interaction table that applies the claim's compare-and-set.
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({
      queryOne: async () => (mocks.row ? { ...mocks.row } : null),
      execute: async (_sql: string, params: unknown[]) => {
        const [next, , , , expected] = params as [string, number, string, string, string];
        if (mocks.row && mocks.row.state === 'failed' && mocks.row.context_json === expected) {
          mocks.row.context_json = next;
          return { success: true, rowsAffected: 1 };
        }
        return { success: true, rowsAffected: 0 };
      },
    })),
  };
});
vi.mock('../../admin/providers', () => ({ getSPConfig: vi.fn(async () => mocks.sp) }));
vi.mock('../../common/entity-id', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/entity-id')>()),
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    idpEntityId: 'https://tenant.example.test/saml/idp',
  })),
}));
vi.mock('../response-destination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../response-destination')>()),
  resolveSAMLResponseDestination: vi.fn(() => 'https://sp.example.test/acs'),
}));
vi.mock('../sso-stored-request', () => ({ consumeStoredAuthnRequest: mocks.consume }));
vi.mock('../sso', () => ({
  generateSAMLProtocolErrorResponse: mocks.errorResponse,
  sendSAMLResponse: mocks.send,
}));
vi.mock('../audit', () => ({ scheduleSAMLPolicyFailureAudit: mocks.audit }));

import { createSAMLLoginCancelGrant } from '@authrim/ar-lib-core';
import { handleIdPLoginCancel } from '../login-cancel';

function app() {
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.get('/saml/idp/login-cancel', handleIdPLoginCancel as never);
  return route;
}

const request = (token: string, id = 'interaction_1') =>
  app().request(`/saml/idp/login-cancel?interaction_id=${id}&token=${token}`, undefined, {});

describe('answering the SP for a sign-in the person cancelled', () => {
  let token: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    const grant = await createSAMLLoginCancelGrant();
    token = grant.token;
    mocks.sp = { entityId: 'https://sp.example.test/entity' };
    mocks.row = {
      state: 'failed',
      saml_sp_id: 'https://sp.example.test/entity',
      context_json: JSON.stringify({
        saml_request_id: 'req_1',
        saml_login_nonce_hash: 'nonce-hash',
        login_cancel: grant.context,
      }),
    };
    mocks.consume.mockResolvedValue({
      data: { id: 'req_1', issuer: 'https://sp.example.test/entity' },
      relayState: 'relay-1',
    });
  });

  it('posts a Responder / AuthnFailed Response to the ACS with the RelayState, once', async () => {
    const first = await request(token);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      acs: 'https://sp.example.test/acs',
      xml: '<failure/>',
      relayState: 'relay-1',
    });
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'req_1',
      'https://sp.example.test/entity',
      { loginNonceHash: 'nonce-hash' }
    );
    const args = mocks.errorResponse.mock.calls[0];
    expect(args.slice(6, 9)).toEqual([
      STATUS_CODES.RESPONDER,
      STATUS_CODES.AUTHN_FAILED,
      expect.any(String),
    ]);

    // The same link again answers nothing, and touches nothing.
    const second = await request(token);
    expect(second.status).toBe(400);
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('answers nothing for a wrong token, without using up the stored request', async () => {
    const other = await createSAMLLoginCancelGrant();
    const response = await request(other.token);
    expect(response.status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('answers nothing for an interaction still in progress or one that failed another way', async () => {
    mocks.row = { ...(mocks.row as NonNullable<typeof mocks.row>), state: 'active' };
    expect((await request(token)).status).toBe(400);
    mocks.row = {
      state: 'failed',
      saml_sp_id: 'https://sp.example.test/entity',
      context_json: JSON.stringify({ saml_request_id: 'req_1', saml_login_nonce_hash: 'h' }),
    };
    expect((await request(token)).status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('answers nothing when the stored request was sent with another nonce', async () => {
    // The store refuses a request that does not hold the interaction's nonce hash, consuming
    // nothing (a conditional consume, not a consume followed by a refusal).
    mocks.consume.mockRejectedValue(new Error('Stored SAML request not found or already used'));
    const response = await request(token);
    expect(response.status).toBe(400);
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'req_1',
      'https://sp.example.test/entity',
      { loginNonceHash: 'nonce-hash' }
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('answers nothing for an interaction started without a login nonce', async () => {
    mocks.row = {
      ...(mocks.row as NonNullable<typeof mocks.row>),
      context_json: JSON.stringify({
        saml_request_id: 'req_1',
        login_cancel: (JSON.parse(String(mocks.row?.context_json)) as { login_cancel: unknown })
          .login_cancel,
      }),
    };
    expect((await request(token)).status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('answers nothing for a cancel token older than its lifetime', async () => {
    const old = JSON.parse(String(mocks.row?.context_json)) as {
      login_cancel: { created_at_ms: number };
    };
    old.login_cancel.created_at_ms = Date.now() - 11 * 60 * 1000;
    mocks.row = {
      ...(mocks.row as NonNullable<typeof mocks.row>),
      context_json: JSON.stringify(old),
    };
    expect((await request(token)).status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('answers the SP on a runtime with request ports too, consuming on the nonce hash', async () => {
    const response = await app().request(
      `/saml/idp/login-cancel?interaction_id=interaction_1&token=${token}`,
      undefined,
      { SAML_RUNTIME_PORTS: {} }
    );
    expect(response.status).toBe(200);
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({ SAML_RUNTIME_PORTS: {} }),
      'tenant-a',
      'req_1',
      'https://sp.example.test/entity',
      { loginNonceHash: 'nonce-hash' }
    );
  });

  it('answers nothing for a bare request id or an unknown interaction', async () => {
    mocks.row = null;
    expect((await request(token, 'req_1')).status).toBe(400);
    expect((await app().request('/saml/idp/login-cancel?saml_request_id=req_1')).status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('answers nothing when the stored AuthnRequest is gone', async () => {
    mocks.consume.mockRejectedValue(new Error('Stored SAML request not found or already used'));
    const response = await request(token);
    expect(response.status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

/**
 * Starting SAML sign-in through a federation source: `federation` names the source, `entityID`
 * the IdP picked from its inventory. Without `entityID` the request is only the hop to the
 * institution picker (or the source's Discovery Service).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { handleSPLogin } from '../login';

const mocks = vi.hoisted(() => ({
  getIdPConfig: vi.fn(),
  getSource: vi.fn(),
  resolveIdP: vi.fn(),
  usagePolicy: vi.fn(),
  challengeKind: vi.fn(),
  humanVerification: vi.fn(),
}));

vi.mock('../../admin/providers', () => ({
  getIdPConfig: (...args: unknown[]): unknown => mocks.getIdPConfig(...args),
  listIdPConfigs: vi.fn(),
  getFederationSourceForLogin: (...args: unknown[]): unknown => mocks.getSource(...args),
  resolveFederationIdPForLogin: (...args: unknown[]): unknown => mocks.resolveIdP(...args),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readExternalProviderUsagePolicy: mocks.usagePolicy,
    readAuthorizationChallengeKind: mocks.challengeKind,
    verifyHumanVerificationWithRunner: mocks.humanVerification,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    getLogger: () => ({
      module: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }),
  };
});

const idpConfig = {
  entityId: 'https://idp.u-alpha.example/idp',
  ssoUrl: 'https://idp.u-alpha.example/sso',
  certificate: 'mock-certificate',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  attributeMapping: {},
  allowedBindings: ['post'],
};

describe('SP login through a federation source', () => {
  let storeBodies: Array<Record<string, unknown>>;
  let consumed: Set<string>;
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();
    storeBodies = [];
    consumed = new Set();
    mocks.getIdPConfig.mockResolvedValue(idpConfig);
    mocks.getSource.mockResolvedValue({
      id: 'fed_1',
      displayName: 'Research Federation',
      idpSelection: { mode: 'authrim_search' },
      policy: { mode: 'automatic', roles: ['saml_idp'], idpFieldMappingSetId: 'set-1' },
    });
    mocks.resolveIdP.mockResolvedValue({ kind: 'federation', config: idpConfig });
    mocks.usagePolicy.mockResolvedValue({
      loginEnabled: true,
      signupEnabled: true,
      reauthEnabled: false,
    });
    mocks.humanVerification.mockResolvedValue({ verified: true });
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      SAML_REQUEST_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn(async (url: string, init: RequestInit) => {
            if (url.includes('/consume/')) {
              const id = url.split('/consume/')[1];
              const held = storeBodies.find((body) => body.requestId === id);
              // Used up once: a second consume finds nothing.
              if (!held || consumed.has(id)) return new Response('', { status: 404 });
              consumed.add(id);
              return Response.json(held);
            }
            if (typeof init.body !== 'string') throw new Error('fixture-request-body-not-string');
            storeBodies.push(JSON.parse(init.body) as Record<string, unknown>);
            return new Response('OK', { status: 200 });
          }),
        })),
      } as unknown as Env['SAML_REQUEST_STORE'],
    };
  });

  function loginContext(query: Record<string, string>, cookie?: string) {
    const header = vi.fn();
    const redirect = vi.fn((location: string, status?: number) => {
      return new Response(null, { status: status ?? 302, headers: { Location: location } });
    });
    const search = new URLSearchParams(query).toString();
    const context = {
      env: mockEnv,
      req: {
        url: `https://auth.example.com/saml/sp/login?${search}`,
        query: vi.fn((name: string) => query[name]),
        header: vi.fn((name: string) => (name.toLowerCase() === 'cookie' ? cookie : undefined)),
      },
      get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-a' : undefined)),
      header,
      redirect,
      json: vi.fn(
        (data: unknown, status: number) => new Response(JSON.stringify(data), { status })
      ),
      html: vi.fn((html: string) => new Response(html, { status: 200 })),
    } as unknown as Parameters<typeof handleSPLogin>[0];
    return { context, redirect, header };
  }

  describe('the hop (no entityID)', () => {
    it('sends the user to the institution picker with only the screen parameters', async () => {
      const { context, redirect } = loginContext({
        federation: 'fed_1',
        purpose: 'signup',
        return_url: 'https://app.example.com/',
        invite_token: 'invite-1',
        human_verification_response: 'token-1',
        unrelated: 'dropped',
      });
      const response = await handleSPLogin(context);
      expect(response.status).toBe(302);
      const location = new URL(String(redirect.mock.calls[0]?.[0]));
      expect(location.origin + location.pathname).toBe(
        'https://auth.example.com/login/federation/fed_1'
      );
      expect(Object.fromEntries(location.searchParams)).toEqual({
        purpose: 'signup',
        return_url: 'https://app.example.com/',
        invite_token: 'invite-1',
        human_verification_response: 'token-1',
      });
      // Nothing is started or stored, and the human-verification token is not spent here: it is
      // checked when the institution is chosen.
      expect(storeBodies).toHaveLength(0);
      expect(mocks.humanVerification).not.toHaveBeenCalled();
    });

    it('sends the user to the stored Discovery Service and keeps the rest server-side', async () => {
      mocks.getSource.mockResolvedValue({
        id: 'fed_1',
        displayName: 'Research Federation',
        idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example.org/WAYF' },
        policy: {},
      });
      const { context, redirect } = loginContext({
        federation: 'fed_1',
        purpose: 'signup',
        return_url: 'https://app.example.com/',
        invite_token: 'invite-1',
        human_verification_response: 'token-1',
        is_passive: '1',
        discoveryServiceUrl: 'https://evil.example/ds',
      });
      const response = await handleSPLogin(context);
      expect(response.status).toBe(302);
      const location = new URL(String(redirect.mock.calls[0]?.[0]));
      // Only the stored address, whatever the request said.
      expect(location.origin + location.pathname).toBe('https://ds.example.org/WAYF');
      expect(location.searchParams.get('returnIDParam')).toBe('entityID');
      expect(location.searchParams.get('isPassive')).toBe('true');
      expect(location.searchParams.get('entityID')).toMatch(/^https?:\/\//u);
      const back = new URL(location.searchParams.get('return') as string);
      expect(back.origin + back.pathname).toBe('https://auth.example.com/saml/sp/login');
      // Only an opaque id goes to the Discovery Service: no invitation, no token, nothing else.
      expect([...back.searchParams.keys()].sort()).toEqual(['federation', 'fs']);
      const stateId = back.searchParams.get('fs') as string;
      expect(stateId).toMatch(/^_[0-9a-f]{32}$/u);
      expect(location.href).not.toContain('invite-1');
      expect(location.href).not.toContain('token-1');
      // The human-verification token is checked and spent here, since it will not come back.
      expect(mocks.humanVerification).toHaveBeenCalledOnce();
      // What the screen sent is kept server-side, in a store apart from real IdPs, and the id is
      // bound to this browser by a cookie.
      expect(storeBodies[0]).toMatchObject({
        requestId: stateId,
        destination: 'urn:authrim:federation-start:fed_1',
        context: {
          federationStart: {
            params: {
              purpose: 'signup',
              return_url: 'https://app.example.com/',
              invite_token: 'invite-1',
            },
          },
        },
      });
      expect(JSON.stringify(storeBodies[0])).not.toContain('token-1');
      expect(response.headers.get('Set-Cookie')).toContain(`${stateId}=1`);
    });

    it('answers 404 for a source that cannot serve IdPs', async () => {
      mocks.getSource.mockResolvedValue(null);
      const { context } = loginContext({ federation: 'fed_1' });
      expect((await handleSPLogin(context)).status).toBe(404);
    });
  });

  describe('request validation', () => {
    it.each([
      ['idp and federation together', { idp: 'idp-1', federation: 'fed_1' }],
      ['a source id that is not an identifier', { federation: 'fed 1/../x' }],
      ['an entityID without a federation', { entityID: 'https://idp.example/idp' }],
      ['an empty entityID', { federation: 'fed_1', entityID: '' }],
      ['an entityID that is too long', { federation: 'fed_1', entityID: 'x'.repeat(1025) }],
    ])('refuses %s with 400 before anything is read', async (_label, query) => {
      const { context } = loginContext(query);
      const response = await handleSPLogin(context);
      expect(response.status).toBe(400);
      expect(mocks.getSource).not.toHaveBeenCalled();
      expect(mocks.resolveIdP).not.toHaveBeenCalled();
    });
  });

  describe('the start (with an entityID)', () => {
    const query = { federation: 'fed_1', entityID: 'https://idp.u-alpha.example/idp' };

    it('starts the AuthnRequest with the resolved IdP and remembers the source for the ACS', async () => {
      const { context } = loginContext(query);
      const response = await handleSPLogin(context);
      expect(response.status).toBe(200);
      expect(mocks.resolveIdP).toHaveBeenCalledWith(
        mockEnv,
        'tenant-a',
        'fed_1',
        'https://idp.u-alpha.example/idp'
      );
      expect(mocks.getIdPConfig).not.toHaveBeenCalled();
      expect(storeBodies[0]?.context).toEqual({ federationSourceId: 'fed_1' });
      // The human-verification check runs here, where the IdP is chosen.
      expect(mocks.humanVerification).toHaveBeenCalledOnce();
    });

    it('reads the sign-in switches under the source', async () => {
      const { context } = loginContext(query);
      await handleSPLogin(context);
      expect(mocks.usagePolicy).toHaveBeenCalledWith(mockEnv, 'tenant-a', {
        providerId: 'fed_1',
        ids: ['saml-federation:fed_1', 'fed_1'],
      });
    });

    it('refuses a sign-in the tenant has switched off for the source', async () => {
      mocks.usagePolicy.mockResolvedValue({ loginEnabled: false, signupEnabled: true });
      const { context } = loginContext(query);
      expect((await handleSPLogin(context)).status).toBeGreaterThanOrEqual(400);
      expect(storeBodies).toHaveLength(0);
    });

    it('answers 404 for an entity that is not in this source, excluded, or not allowed', async () => {
      mocks.resolveIdP.mockResolvedValue(null);
      const { context } = loginContext(query);
      expect((await handleSPLogin(context)).status).toBe(404);
      expect(storeBodies).toHaveLength(0);
    });

    it('answers 404 when the source itself cannot serve IdPs', async () => {
      mocks.getSource.mockResolvedValue(null);
      const { context } = loginContext(query);
      expect((await handleSPLogin(context)).status).toBe(404);
      expect(mocks.resolveIdP).not.toHaveBeenCalled();
    });

    it('starts the entity’s own approved provider in place, with human verification once', async () => {
      mocks.resolveIdP.mockResolvedValue({ kind: 'explicit', providerId: 'idp-9' });
      const { context, redirect } = loginContext({ ...query, purpose: 'signup' });
      const response = await handleSPLogin(context);
      // No redirect: a redirect would carry a single-use token to a second check.
      expect(redirect).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(mocks.getIdPConfig).toHaveBeenCalledWith(mockEnv, 'tenant-a', 'idp-9');
      expect(mocks.humanVerification).toHaveBeenCalledOnce();
      // It is that provider's start: its own switches, no federation context.
      expect(mocks.usagePolicy).toHaveBeenCalledWith(mockEnv, 'tenant-a', {
        providerId: 'idp-9',
        ids: ['saml:idp-9', 'idp-9'],
      });
      expect(storeBodies[0]).not.toHaveProperty('context');
    });

    it('does not start, or spend the human-verification token, for an entity that is refused', async () => {
      mocks.resolveIdP.mockResolvedValue(null);
      const { context } = loginContext(query);
      expect((await handleSPLogin(context)).status).toBe(404);
      expect(mocks.humanVerification).not.toHaveBeenCalled();
    });

    it('refuses the start when human verification fails', async () => {
      mocks.humanVerification.mockResolvedValue({ verified: false });
      const { context } = loginContext(query);
      expect((await handleSPLogin(context)).status).toBe(400);
      expect(storeBodies).toHaveLength(0);
    });

    it('takes no part in a re-authentication, which asks one known IdP', async () => {
      mocks.challengeKind.mockResolvedValue('reauth');
      const { context } = loginContext({ ...query, authorization_challenge_id: 'challenge-1' });
      expect((await handleSPLogin(context)).status).toBeGreaterThanOrEqual(400);
      expect(storeBodies).toHaveLength(0);
    });
  });

  describe('the return from a Discovery Service (fs)', () => {
    const stateId = `_${'a'.repeat(32)}`;
    const returned = {
      federation: 'fed_1',
      entityID: 'https://idp.u-alpha.example/idp',
      fs: stateId,
      // Whatever a caller adds here is ignored: the kept values are the ones used.
      purpose: 'login',
      invite_token: 'forged',
    };
    const cookie = `__Host-authrim_saml_request_${stateId}=1`;
    const keep = () =>
      storeBodies.push({
        requestId: stateId,
        destination: 'urn:authrim:federation-start:fed_1',
        context: {
          federationStart: {
            params: { purpose: 'signup', return_url: 'https://auth.example.com/welcome' },
          },
        },
      });

    it('starts the chosen IdP from what was kept, without checking human verification again', async () => {
      keep();
      const { context } = loginContext(returned, cookie);
      const response = await handleSPLogin(context);
      expect(response.status).toBe(200);
      expect(mocks.humanVerification).not.toHaveBeenCalled();
      // The purpose is the kept one (sign-up), not the request's: its switch is the one read.
      expect(mocks.usagePolicy).toHaveBeenCalled();
      const started = storeBodies.at(-1);
      expect(started?.relayState).toBe('https://auth.example.com/welcome');
      expect(started?.context).toEqual({ federationSourceId: 'fed_1' });
      // The kept state is used up and its cookie cleared, beside the cookie of the AuthnRequest
      // (both Set-Cookie headers must survive).
      expect(consumed.has(stateId)).toBe(true);
      const cookies = response.headers.getSetCookie();
      expect(cookies.some((value) => value.includes(`${stateId}=;`))).toBe(true);
      expect(
        cookies.some((value) => /__Host-authrim_saml_request__[0-9a-f]{32}=1/u.test(value))
      ).toBe(true);
    });

    it('clears the state cookie on a refusal after the state was spent', async () => {
      keep();
      // The source stopped while the user was at the Discovery Service.
      mocks.getSource.mockResolvedValue(null);
      const { context } = loginContext(returned, cookie);
      const response = await handleSPLogin(context);
      expect(response.status).toBe(404);
      expect(consumed.has(stateId)).toBe(true);
      expect(response.headers.get('Set-Cookie')).toContain(`${stateId}=;`);
    });

    it('refuses a state with no matching browser cookie, without consuming it', async () => {
      keep();
      const { context } = loginContext(returned, '__Host-other=1');
      expect((await handleSPLogin(context)).status).toBe(400);
      expect(consumed.has(stateId)).toBe(false);
    });

    it('refuses a state used before, one that is unknown, and one for another source', async () => {
      keep();
      await handleSPLogin(loginContext(returned, cookie).context);
      // Used up.
      expect((await handleSPLogin(loginContext(returned, cookie).context)).status).toBe(400);
      // Unknown id.
      const unknown = `_${'b'.repeat(32)}`;
      const other = { ...returned, fs: unknown };
      expect(
        (
          await handleSPLogin(
            loginContext(other, `__Host-authrim_saml_request_${unknown}=1`).context
          )
        ).status
      ).toBe(400);
    });

    it.each([
      ['fs without an entityID', { federation: 'fed_1', fs: `_${'a'.repeat(32)}` }],
      ['an fs that is not an id of ours', { federation: 'fed_1', entityID: 'x', fs: 'abc' }],
    ])('refuses %s with 400', async (_label, query) => {
      expect((await handleSPLogin(loginContext(query).context)).status).toBe(400);
    });
  });
});

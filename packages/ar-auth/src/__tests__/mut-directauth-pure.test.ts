import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContext, mocks, resetDirectAuthMocks } from './helpers/mut-directauth-harness';

/**
 * The exported decisions of direct-auth.ts that do not run a whole handler: which channel a
 * client takes, which origin a passkey ceremony is bound to, which origins a client accepts, and
 * what a session's amr proves for a re-authentication.
 */
type DirectAuth = typeof import('../direct-auth');
let da: DirectAuth;

function proxied(headers: Record<string, string>, url = 'https://api.example.com/auth') {
  return createContext(
    {},
    {
      'x-authrim-ui-proxy': 'login-ui',
      'x-authrim-browser-origin': 'https://login.example.com',
      ...headers,
    },
    url
  );
}

describe('Direct Auth decisions', () => {
  beforeAll(async () => {
    da = await import('../direct-auth');
  }, 20_000);
  beforeEach(() => resetDirectAuthMocks());

  describe('isDirectAuthClientChannelAllowed', () => {
    it('treats an empty channel list as no list at all', () => {
      expect(da.isDirectAuthClientChannelAllowed({ allowed_channels: [] }, 'browser')).toBe(true);
      expect(
        da.isDirectAuthClientChannelAllowed(
          { application_type: 'native', allowed_channels: [] },
          'browser'
        )
      ).toBe(false);
      expect(da.isDirectAuthClientChannelAllowed({ allowed_channels: ['native'] }, 'browser')).toBe(
        false
      );
    });
  });

  describe('getDirectAuthWebAuthnOrigin (Login UI proxy)', () => {
    it.each([
      ['the request URL', 'https://api.example.com', {}],
      [
        'x-authrim-forwarded-host',
        'https://tenant.example.com',
        { 'x-authrim-forwarded-host': 'tenant.example.com' },
      ],
      [
        'x-forwarded-host (first of a list)',
        'https://tenant.example.com',
        { 'x-forwarded-host': 'tenant.example.com, other.example.com' },
      ],
      ['host, in any case', 'https://tenant.example.com', { host: 'Tenant.Example.com' }],
      ['a local host with a port over http', 'http://localhost:8787', { host: 'localhost:8787' }],
      ['127.0.0.1 over http', 'http://127.0.0.1:8787', { host: '127.0.0.1:8787' }],
    ])('takes the browser origin when the origin is the same as %s', (_n, origin, headers) => {
      const context = proxied({ origin, ...headers });
      expect(da.getDirectAuthWebAuthnOrigin(context as never, origin)).toBe(
        'https://login.example.com'
      );
    });

    it.each([
      ['a non-local host over http', 'http://tenant.example.com', { host: 'tenant.example.com' }],
      [
        'a host that is only second in a list',
        'https://other.example.com',
        { 'x-forwarded-host': 'tenant.example.com, other.example.com' },
      ],
      ['an unrelated origin', 'https://evil.example.net', { host: 'tenant.example.com' }],
    ])('keeps the request origin for %s', (_n, origin, headers) => {
      const context = proxied({ origin, ...headers });
      expect(da.getDirectAuthWebAuthnOrigin(context as never, origin)).toBe(origin);
    });

    it('keeps the request origin when the browser origin is not a URL', () => {
      const context = proxied({ 'x-authrim-browser-origin': 'not a url' });
      expect(da.getDirectAuthWebAuthnOrigin(context as never, 'https://api.example.com/path')).toBe(
        'https://api.example.com'
      );
    });

    it('has no origin without a usable origin header', () => {
      const context = proxied({});
      expect(da.getDirectAuthWebAuthnOrigin(context as never, undefined)).toBeUndefined();
      expect(da.getDirectAuthWebAuthnOrigin(context as never, 'not a url')).toBeUndefined();
    });
  });

  describe('validateDirectAuthClient', () => {
    const validate = (channel: 'browser' | 'native', origin?: string, headers = {}) =>
      da.validateDirectAuthClient(
        createContext({}, headers, 'https://api.example.com/auth') as never,
        'web-client',
        channel,
        origin
      );

    it('refuses an unknown client and a channel the client does not take', async () => {
      mocks.getClient.mockResolvedValueOnce(null);
      const unknown = await validate('browser');
      expect(unknown.valid).toBe(false);
      expect(((await unknown.errorResponse?.json()) as Record<string, unknown>).error_code).toBe(
        'AR020002'
      );

      const native = await validate('native');
      expect(native.valid).toBe(false);
      expect(((await native.errorResponse?.json()) as Record<string, unknown>).error_code).toBe(
        'AR130003'
      );
      expect(mocks.getWebOriginRegistry).not.toHaveBeenCalled();
    });

    it('accepts only origins the registry allows to hand off', async () => {
      mocks.getWebOriginRegistry.mockResolvedValue({
        origins: [
          { origin: 'https://app.example.com', handoff_allowed: true },
          { origin: 'https://nohandoff.example.com', handoff_allowed: false },
        ],
      });
      expect((await validate('browser', 'https://app.example.com')).valid).toBe(true);
      const refused = await validate('browser', 'https://nohandoff.example.com');
      expect(refused.valid).toBe(false);
      expect(((await refused.errorResponse?.json()) as Record<string, unknown>).error_code).toBe(
        'AR050006'
      );
    });

    it('falls back to the client’s redirect origins when the registry cannot be read', async () => {
      mocks.getWebOriginRegistry.mockRejectedValue(new Error('registry down'));
      expect((await validate('browser', 'https://app.example.com')).valid).toBe(true);
      expect((await validate('browser', 'https://evil.example.net')).valid).toBe(false);
    });

    it('accepts any origin for a client with no origins at all', async () => {
      mocks.getWebOriginRegistry.mockResolvedValue({ origins: [] });
      mocks.getClient.mockResolvedValue({ client_id: 'web-client', application_type: 'web' });
      expect((await validate('browser', 'https://anything.example.net')).valid).toBe(true);
    });

    it('accepts the request’s own origin for the browser channel only', async () => {
      mocks.getClient.mockResolvedValue({
        client_id: 'web-client',
        allowed_channels: ['browser', 'native'],
        allowed_redirect_origins: ['https://app.example.com'],
      });
      expect((await validate('browser', 'https://api.example.com')).valid).toBe(true);
      expect((await validate('native', 'https://api.example.com')).valid).toBe(false);
    });
  });

  describe('reauthProvenMethodFromAmr / reauthProofFromRecord', () => {
    it.each([
      [['otp'], 'email_otp'],
      [['email_code'], 'email_otp'],
      [['email_verification_protocol'], 'email_otp'],
      [['pwd'], 'directory_password'],
      [['did'], 'other'],
      [['hwk'], undefined],
    ])('maps %j to %s', (amr, method) => {
      expect(da.reauthProvenMethodFromAmr(amr)).toBe(method);
    });

    it('leaves out methods recorded as unverified', () => {
      expect(da.reauthProvenMethodFromAmr(['passkey', 'otp'], ['passkey'])).toBe('email_otp');
    });

    it('answers nothing for a recorded pair of methods it does not know', () => {
      expect(
        da.reauthProofFromRecord({ reauth_proven_at: 5, reauth_proven_amr: ['hwk'] }, ['otp'])
      ).toStrictEqual({});
      expect(
        da.reauthProofFromRecord({ reauth_proven_at: 5, reauth_proven_amr: ['otp', 1] }, [])
      ).toStrictEqual({ method: 'email_otp', provenAtMs: 5 });
    });

    it('needs the bridge’s pair for an external IdP or SAML login, not for a DID', () => {
      expect(da.reauthProofFromRecord({ proven_at: 5 }, ['external_idp'])).toStrictEqual({});
      expect(da.reauthProofFromRecord({ proven_at: 5 }, ['saml'])).toStrictEqual({});
      expect(da.reauthProofFromRecord({ proven_at: 5 }, ['did'])).toStrictEqual({
        method: 'other',
        provenAtMs: 5,
      });
      expect(da.reauthProofFromRecord(undefined, ['otp'])).toStrictEqual({ method: 'email_otp' });
    });
  });

  describe('isProofOlderThanChallengeRequirement', () => {
    it.each([
      [{ kind: 'reauth', issuedAt: 1000 }, 0, undefined, true],
      [{ kind: 'reauth', issuedAt: 1000 }, 0, 999, true],
      [{ kind: 'reauth', issuedAt: 1000 }, 0, 1000, false],
      [{ kind: 'login', issuedAt: 5000 }, 0, 4999, true],
      [{ kind: 'login', issuedAt: 5000 }, 0, 5000, false],
      [{ kind: 'login', issuedAt: 5000 }, 4, undefined, false],
      [{ kind: 'login', issuedAt: 5001 }, 4, undefined, true],
    ] as const)('freshness %j, auth_time %s, proven %s: older %s', (f, authTime, proven, older) => {
      expect(da.isProofOlderThanChallengeRequirement(f, authTime, proven)).toBe(older);
    });
  });

  describe('directLogoutHandler', () => {
    it('logs out a request whose body is not JSON', async () => {
      const context = createContext({});
      context.req.json = (async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      }) as never;
      const response = await da.directLogoutHandler(context as never);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, message: 'Logged out successfully' });
    });
  });
});

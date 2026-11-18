/**
 * SP login start: error and edge paths (client IP forwarding, human verification denial,
 * a request without an ID, interaction/challenge mismatch, IdP selection hints).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { handleSPLogin } from '../login';

const {
  mockGetIdPConfig,
  mockListIdPConfigs,
  mockVerifyHuman,
  mockResolveInteraction,
  mockAssertInteraction,
  mockIsMismatch,
  mockResolveCoreAdapter,
  mockChallengeKind,
  mockGenerateId,
} = vi.hoisted(() => ({
  mockGetIdPConfig: vi.fn(),
  mockListIdPConfigs: vi.fn(),
  mockVerifyHuman: vi.fn(),
  mockResolveInteraction: vi.fn(),
  mockAssertInteraction: vi.fn(),
  mockIsMismatch: vi.fn(),
  mockResolveCoreAdapter: vi.fn(),
  mockChallengeKind: vi.fn(),
  mockGenerateId: vi.fn(),
}));

vi.mock('../../admin/providers', () => ({
  getIdPConfig: (...args: unknown[]): unknown => mockGetIdPConfig(...args),
  listIdPConfigs: (...args: unknown[]): unknown => mockListIdPConfigs(...args),
}));

vi.mock('../../common/xml-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/xml-utils')>();
  return {
    ...actual,
    generateSAMLId: (): string => {
      const forced = mockGenerateId() as string | undefined;
      return forced === undefined ? actual.generateSAMLId() : forced;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    verifyHumanVerificationWithRunner: (...args: unknown[]): unknown => mockVerifyHuman(...args),
    resolveSignInAttemptInteraction: (...args: unknown[]): unknown =>
      mockResolveInteraction(...args),
    assertInteractionAnswersChallenge: (...args: unknown[]): unknown =>
      mockAssertInteraction(...args),
    isInteractionChallengeMismatchError: (...args: unknown[]): unknown => mockIsMismatch(...args),
    resolveAuthCorePersistenceAdapterFromEnv: (...args: unknown[]): unknown =>
      mockResolveCoreAdapter(...args),
    readAuthorizationChallengeKind: (...args: unknown[]): unknown => mockChallengeKind(...args),
    getLogger: () => ({
      module: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }),
  };
});

type LoginContext = Parameters<typeof handleSPLogin>[0];

function createContext(
  env: Partial<Env>,
  query: Record<string, string | undefined>,
  headers: Record<string, string> = {}
): LoginContext {
  return {
    env,
    req: {
      query: vi.fn((name: string) => query[name]),
      header: vi.fn((name: string) => headers[name]),
    },
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-a' : undefined)),
    header: vi.fn(),
    redirect: vi.fn(),
    json: vi.fn((data: unknown, status: number) => new Response(JSON.stringify(data), { status })),
    html: vi.fn((html: string) => new Response(html, { status: 200 })),
  } as unknown as LoginContext;
}

describe('SP login error paths', () => {
  let storeBodies: Array<Record<string, unknown>>;
  let env: Partial<Env>;
  const coreDb = { name: 'tenant-core' };

  beforeEach(() => {
    vi.clearAllMocks();
    storeBodies = [];
    mockVerifyHuman.mockResolvedValue({ verified: true });
    mockGenerateId.mockReturnValue(undefined);
    mockResolveInteraction.mockResolvedValue(null);
    mockAssertInteraction.mockResolvedValue(undefined);
    mockIsMismatch.mockReturnValue(false);
    mockResolveCoreAdapter.mockResolvedValue(coreDb);
    mockChallengeKind.mockResolvedValue('login');
    mockListIdPConfigs.mockResolvedValue([]);
    mockGetIdPConfig.mockResolvedValue({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMapping: {},
      allowedBindings: ['post'],
    });
    env = {
      ISSUER_URL: 'https://auth.example.com',
      SAML_REQUEST_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn(async (_url: string, init: RequestInit) => {
            storeBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
            return new Response('OK', { status: 200 });
          }),
        })),
      } as unknown as Env['SAML_REQUEST_STORE'],
    };
  });

  describe('human verification', () => {
    it.each([
      ['CF-Connecting-IP', { 'CF-Connecting-IP': '203.0.113.7' }, '203.0.113.7'],
      [
        'the first X-Forwarded-For entry',
        { 'X-Forwarded-For': ' 198.51.100.1 , 10.0.0.1' },
        '198.51.100.1',
      ],
      [
        'CF-Connecting-IP before X-Forwarded-For',
        { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' },
        '203.0.113.7',
      ],
      ['nothing when no header is sent', {}, undefined],
    ])('passes %s to the verifier as the remote IP', async (_label, headers, expected) => {
      const res = await handleSPLogin(
        createContext(env, { idp: 'idp-1', human_verification_response: 'tok' }, headers)
      );

      expect(res.status).toBe(200);
      expect(mockVerifyHuman).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          tenantId: 'tenant-a',
          action: 'login',
          responseToken: 'tok',
          remoteIp: expected,
        })
      );
    });

    it('falls back to the cf_turnstile_response token', async () => {
      await handleSPLogin(createContext(env, { idp: 'idp-1', cf_turnstile_response: 'cf-tok' }));
      expect(mockVerifyHuman.mock.calls[0][1]).toMatchObject({ responseToken: 'cf-tok' });
    });

    it('denies the start with a validation error when verification is not satisfied', async () => {
      mockVerifyHuman.mockResolvedValue({ verified: false });

      const res = await handleSPLogin(createContext(env, { idp: 'idp-1' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_request' });
      expect(mockGetIdPConfig).not.toHaveBeenCalled();
      expect(storeBodies).toHaveLength(0);
    });

    it('gives a runner failure the same public denial', async () => {
      mockVerifyHuman.mockRejectedValue(new Error('runner down'));

      const res = await handleSPLogin(createContext(env, { idp: 'idp-1' }));

      expect(res.status).toBe(400);
      expect(mockGetIdPConfig).not.toHaveBeenCalled();
      expect(storeBodies).toHaveLength(0);
    });
  });

  describe('request ID', () => {
    it('answers 500 and stores nothing when the AuthnRequest has no ID', async () => {
      mockGenerateId.mockReturnValue('');

      const res = await handleSPLogin(createContext(env, { idp: 'idp-1' }));

      expect(res.status).toBe(500);
      expect(storeBodies).toHaveLength(0);
    });
  });

  describe('interaction answering an authorization challenge', () => {
    const query = {
      idp: 'idp-1',
      authorization_challenge_id: 'login_1',
      runtime_interaction_id: 'int-raw',
    };

    beforeEach(() => {
      mockResolveInteraction.mockResolvedValue('int-1');
    });

    it('checks the interaction against the challenge and stores both in the context', async () => {
      const res = await handleSPLogin(createContext(env, query));

      expect(res.status).toBe(200);
      expect(mockAssertInteraction).toHaveBeenCalledWith(coreDb, 'tenant-a', 'int-1', 'login_1');
      expect(mockResolveCoreAdapter).toHaveBeenCalledWith(env, 'saml-sign-in-attempt', {
        tenantId: 'tenant-a',
      });
      expect(storeBodies[0]?.context).toEqual({
        attemptInteractionId: 'int-1',
        flowChallengeId: 'login_1',
      });
    });

    it('does not check the challenge when no live interaction was resolved', async () => {
      mockResolveInteraction.mockResolvedValue(null);

      const res = await handleSPLogin(createContext(env, query));

      expect(res.status).toBe(200);
      expect(mockAssertInteraction).not.toHaveBeenCalled();
      expect(storeBodies[0]?.context).toEqual({ flowChallengeId: 'login_1' });
    });

    it('answers 403 for an interaction started for another authorization request', async () => {
      const mismatch = new Error('mismatch');
      mockAssertInteraction.mockRejectedValue(mismatch);
      mockIsMismatch.mockImplementation((error: unknown) => error === mismatch);

      const res = await handleSPLogin(createContext(env, query));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'authorization_challenge_mismatch',
        error_description: 'The sign-in was not started for this authorization request.',
      });
      expect(mockIsMismatch).toHaveBeenCalledWith(mismatch);
      expect(storeBodies).toHaveLength(0);
    });

    it('answers 503 when the check itself cannot be made', async () => {
      mockAssertInteraction.mockRejectedValue(new Error('database unavailable'));

      const res = await handleSPLogin(createContext(env, query));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'The sign-in flow is unavailable.',
      });
      expect(storeBodies).toHaveLength(0);
    });
  });

  describe('IdP selection page', () => {
    beforeEach(() => {
      mockListIdPConfigs.mockResolvedValue([
        { id: 'idp-1', name: 'Campus <One>', entityId: 'https://idp.example.com' },
      ]);
    });

    it('keeps a valid runtime interaction on every choice', async () => {
      const res = await handleSPLogin(createContext(env, { runtime_interaction_id: ' int_1-A ' }));
      const html = await res.text();

      expect(html).toContain('&runtime_interaction_id=int_1-A"');
      expect(html).toContain('Campus &lt;One&gt;');
      expect(mockGetIdPConfig).not.toHaveBeenCalled();
    });

    it.each(['has space', 'bad/char', 'a'.repeat(129), '   '])(
      'drops a malformed runtime interaction (%j)',
      async (value) => {
        const html = await (
          await handleSPLogin(createContext(env, { runtime_interaction_id: value }))
        ).text();

        expect(html).not.toContain('runtime_interaction_id');
      }
    );

    it('lists no IdP when none is configured', async () => {
      mockListIdPConfigs.mockResolvedValue([]);
      const html = await (await handleSPLogin(createContext(env, {}))).text();
      expect(html).toContain('No identity providers configured.');
    });

    it('falls back to the issuer for a return URL of another origin', async () => {
      const html = await (
        await handleSPLogin(createContext(env, { return_url: 'https://evil.example.org/x' }))
      ).text();
      expect(html).toContain(`return_url=${encodeURIComponent('https://auth.example.com/')}`);
    });

    it('ignores an unparsable UI_URL when checking the return URL origin', async () => {
      (env as Record<string, unknown>).UI_URL = 'not a url';
      const html = await (
        await handleSPLogin(createContext(env, { return_url: 'https://ui.example.com/x' }))
      ).text();
      // Not an allowed origin: the default return URL (built from the UI base) is used instead.
      expect(html).not.toContain(encodeURIComponent('https://ui.example.com/x'));
      expect(html).toContain('return_url=not%20a%20url%2F');
    });

    it('accepts a return URL on the UI_URL origin', async () => {
      (env as Record<string, unknown>).UI_URL = 'https://ui.example.com';
      const html = await (
        await handleSPLogin(createContext(env, { return_url: 'https://ui.example.com/x' }))
      ).text();
      expect(html).toContain(`return_url=${encodeURIComponent('https://ui.example.com/x')}`);
    });
  });
});

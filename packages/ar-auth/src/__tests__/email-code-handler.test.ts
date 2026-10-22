import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  findById: vi.fn(),
  findForOtpLogin: vi.fn(),
  syncUser: vi.fn(),
  markEmailVerifiedForOtpLogin: vi.fn(),
  markEmailVerifiedAndTouchLastLogin: vi.fn(),
  validateRegistration: vi.fn(),
  buildCanonicalFields: vi.fn(),
  persistRegistrationFields: vi.fn(),
  generateCode: vi.fn(),
  hashCode: vi.fn(),
  verifyCode: vi.fn(),
  hashEmail: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  deleteChallengeRpc: vi.fn(),
  notifierSend: vi.fn(),
  getNotifier: vi.fn(),
  incrementRpc: vi.fn(),
  createSessionRpc: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
  resolveOtpAccountCoreDataContextByIdentifierFromHono: vi.fn(),
  resolveAccountDataContextByIdentifierFromHono: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  markOtpLoginEmailVerified: vi.fn(),
  ensureDatabaseAdapter: vi.fn((source) => source),
  provisionTenantD1EmailAccount: vi.fn(),
  ensureAccountAuthenticationState: vi.fn(),
  guestCredentialFence: vi.fn(),
  findCanonicalAccountAuthenticationState: vi.fn(),
}));

// Overrides the deleted-account re-registration check for one test (null: the real check).
const registrationCheck = vi.hoisted(() => ({
  override: null as null | 'blocked' | 'unavailable',
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    checkEmailRegistration: async (...args: unknown[]) =>
      registrationCheck.override ??
      (actual as typeof import('@authrim/ar-lib-core')).checkEmailRegistration(
        ...(args as Parameters<typeof import('@authrim/ar-lib-core').checkEmailRegistration>)
      ),
    withGroupInputWrite: <T>(
      db: import('@authrim/ar-lib-core').DatabaseAdapter,
      tenant: string,
      user: string,
      operation: string,
      write: () => Promise<T>
    ) =>
      actual.withGroupInputWrite(
        typeof db.execute === 'function'
          ? db
          : { ...db, execute: async () => ({ success: true, rowsAffected: 1 }) },
        tenant,
        user,
        operation,
        write
      ),
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    getTenantMetadataContextFromHono: vi.fn((c) =>
      c.env.__TENANT_D1
        ? { tenantId: 'tenant-1', storageProfileId: 'builtin:storage:tenant-d1' }
        : undefined
    ),
    resolveAccountDataContextByIdentifierFromHono:
      mocks.resolveAccountDataContextByIdentifierFromHono,
    resolveOtpAccountCoreDataContextByIdentifierFromHono:
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    markOtpLoginEmailVerified: mocks.markOtpLoginEmailVerified,
    ensureDatabaseAdapter: mocks.ensureDatabaseAdapter,
    createAccountAuthContextFromHono: mocks.createAccountAuthContextFromHono,
    ensureAccountAuthenticationState: mocks.ensureAccountAuthenticationState,
    assertGuestCredentialAuthenticationAllowed: mocks.guestCredentialFence,
    findCanonicalAccountAuthenticationState: mocks.findCanonicalAccountAuthenticationState,
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      findByEmail = mocks.findByEmail;
      findById = mocks.findById;
      findForOtpLogin = mocks.findForOtpLogin;
      syncUser = mocks.syncUser;
      markEmailVerifiedForOtpLogin = mocks.markEmailVerifiedForOtpLogin;
      markEmailVerifiedAndTouchLastLogin = mocks.markEmailVerifiedAndTouchLastLogin;
    },
    generateUserIdFromSettings: vi.fn(async () => 'new-user-1'),
    getChallengeStoreByChallengeId: vi.fn(async () => ({
      storeChallengeRpc: mocks.storeChallengeRpc,
      consumeChallengeRpc: mocks.consumeChallengeRpc,
      deleteChallengeRpc: mocks.deleteChallengeRpc,
    })),
    getRequiredPluginContext: vi.fn(() => ({
      registry: { getNotifier: mocks.getNotifier },
    })),
    produceNotificationDelivery: vi.fn(async (_env, input) => {
      const notifier = mocks.getNotifier('email');
      if (!notifier) throw new Error('notification_delivery_provider_order_unavailable');
      const result = await notifier.send(input.payload);
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'TDB_SHARED_CORE',
        delivery: result.success ? 'delivered' : 'permanent_failure',
      };
    }),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: { createSessionRpc: mocks.createSessionRpc },
      sessionId: 'session-1',
    })),
    generateBrowserState: vi.fn(async () => 'browser-state-1'),
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    publishEvent: mocks.publishEvent,
    createAuditLog: mocks.createAuditLog,
    getLogger: vi.fn(() => ({
      module: () => ({ error: mocks.error, warn: mocks.warn }),
    })),
  };
});

vi.mock('../utils/email-code-utils', () => ({
  generateEmailCode: mocks.generateCode,
  hashEmailCode: mocks.hashCode,
  verifyEmailCodeHash: mocks.verifyCode,
  hashEmail: mocks.hashEmail,
}));

vi.mock('../registration-field-utils', () => ({
  validateRegistrationFieldSubmissionFromEnv: mocks.validateRegistration,
  buildCanonicalProfileRuntimeUserFields: mocks.buildCanonicalFields,
  persistRegistrationFieldValuesFromEnv: mocks.persistRegistrationFields,
}));

vi.mock('../issuer', () => ({
  getRequestIssuer: vi.fn(() => 'https://auth.example.com'),
}));

vi.mock('../account-provisioning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../account-provisioning')>();
  return {
    ...actual,
    provisionTenantD1EmailAccount: mocks.provisionTenantD1EmailAccount,
  };
});

import { emailCodeSendHandler, emailCodeVerifyHandler } from '../email-code';

// The tenant's authentication-methods settings, as the KV namespace returns them.
function methodSettings(values: Record<string, unknown>) {
  return { get: vi.fn(async () => JSON.stringify(values)) };
}

const EMAIL_OTP_ENABLED = {
  'authentication-methods.email_otp.login_enabled': true,
  'authentication-methods.email_otp.signup_enabled': true,
};

function env(overrides: Record<string, unknown> = {}) {
  return {
    ISSUER_URL: 'https://auth.example.com',
    SETTINGS: methodSettings(EMAIL_OTP_ENABLED),
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ incrementRpc: mocks.incrementRpc })),
    },
    ...overrides,
  };
}

function app() {
  const instance = new Hono();
  instance.post('/send', emailCodeSendHandler);
  instance.post('/verify', emailCodeVerifyHandler);
  return instance;
}

async function post(
  path: '/send' | '/verify',
  body: unknown,
  bindings: Record<string, unknown> = {},
  cookie?: string,
  options: { awaitBackground?: boolean } = {}
) {
  const background: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      background.push(promise);
    }),
    passThroughOnException: vi.fn(),
    props: {},
  };
  const responsePromise = app().request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        'CF-Connecting-IP': '192.0.2.20',
        'User-Agent': 'Authrim Email Test',
      },
      body: JSON.stringify(body),
    },
    env(bindings),
    executionCtx
  );
  await vi.runAllTimersAsync();
  const response = await responsePromise;
  // The mail goes out after the reply.
  if (options.awaitBackground !== false) await Promise.allSettled(background);
  return response;
}

const validChallenge = {
  challenge: 'hashed-code',
  userId: 'user-1',
  email: 'user@example.com',
  metadata: {
    email_hash: 'email-hash',
    otp_session_id: 'otp-session-1',
    issued_at: 1_900_000_000,
    purpose: 'login',
  },
};

describe('email code handlers through HTTP', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createAccountAuthContextFromHono.mockReturnValue({ coreAdapter: {} });
    mocks.ensureAccountAuthenticationState.mockResolvedValue({ lifecycle: 'active' });
    mocks.findCanonicalAccountAuthenticationState.mockResolvedValue({
      userId: 'user-1',
      accountType: 'user',
      lifecycle: 'active',
      sourceVersionMs: 1_000,
    });
    mocks.incrementRpc.mockResolvedValue({ allowed: true, retryAfter: 0 });
    mocks.findByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
    });
    mocks.findById.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      active: 1,
      email_verified: 0,
      created_at: '2023-11-14T22:13:20.000Z',
    });
    mocks.findForOtpLogin.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      active: 1,
      email_verified: 0,
    });
    mocks.validateRegistration.mockResolvedValue({ ok: true, values: {} });
    mocks.buildCanonicalFields.mockReturnValue({ piiFields: {}, sensitiveValues: {} });
    mocks.generateCode.mockReturnValue('123456');
    mocks.hashCode.mockResolvedValue('hashed-code');
    mocks.hashEmail.mockResolvedValue('email-hash');
    mocks.storeChallengeRpc.mockResolvedValue(undefined);
    mocks.deleteChallengeRpc.mockResolvedValue(undefined);
    mocks.consumeChallengeRpc.mockResolvedValue(validChallenge);
    mocks.verifyCode.mockResolvedValue(true);
    mocks.getNotifier.mockReturnValue({ send: mocks.notifierSend });
    mocks.notifierSend.mockResolvedValue({ success: true, messageId: 'message-1' });
    mocks.createSessionRpc.mockResolvedValue(undefined);
    mocks.syncUser.mockResolvedValue(undefined);
    mocks.markEmailVerifiedForOtpLogin.mockResolvedValue(undefined);
    mocks.markEmailVerifiedAndTouchLastLogin.mockResolvedValue(undefined);
    mocks.markOtpLoginEmailVerified.mockResolvedValue(true);
    mocks.persistRegistrationFields.mockResolvedValue(undefined);
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.resolveAccountDataContextByIdentifierFromHono.mockResolvedValue({});
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({});
    mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValue({
      tenantId: 'tenant-1',
      accountId: 'account:user-1',
      legacyUserId: 'user-1',
      storageProfileId: 'builtin:storage:tenant-d1',
      coreDb: { adapter: 'tenant-core' },
      coreBindingRef: 'TDB_USERS',
      coreResidencyPartition: 'default',
      accountRouteGeneration: 1,
      membership: {},
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: 'User',
        active: 1,
        email_verified: 0,
        account_type: 'end_user',
        created_at: '2023-11-14T22:13:20.000Z',
      },
    });
    mocks.provisionTenantD1EmailAccount.mockResolvedValue({
      status: 'ready',
      accountId: 'account:new-user-1',
      userId: 'new-user-1',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('send', () => {
    it.each([{}, { email: 'invalid' }, { email: 'user @example.com' }])(
      'rejects malformed input before rate limiting: %j',
      async (body) => {
        const response = await post('/send', body);
        expect(response.status).toBe(400);
        expect(mocks.incrementRpc).not.toHaveBeenCalled();
      }
    );

    describe('when the tenant has switched email code off', () => {
      const body = { email: 'user@example.com' };
      const noEffects = () => {
        expect(mocks.generateCode).not.toHaveBeenCalled();
        expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
        expect(mocks.notifierSend).not.toHaveBeenCalled();
        expect(mocks.syncUser).not.toHaveBeenCalled();
        expect(mocks.provisionTenantD1EmailAccount).not.toHaveBeenCalled();
      };

      it.each([
        ['login_enabled is false', { 'authentication-methods.email_otp.login_enabled': false }],
        ['the method was never configured', {}],
        [
          'only signup is allowed',
          {
            'authentication-methods.email_otp.login_enabled': false,
            'authentication-methods.email_otp.signup_enabled': true,
          },
        ],
      ])('sends no code to an existing user when %s', async (_name, settings) => {
        const response = await post('/send', body, {
          SETTINGS: methodSettings(settings),
          OTP_HMAC_SECRET: 'private-secret',
        });

        // The same reply as a sent code, so it does not say whether the address has an account.
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true });
        expect(response.headers.get('set-cookie')).toContain('authrim_otp_session=');
        noEffects();
      });

      it('still counts the request against the send limit', async () => {
        await post('/send', body, {
          SETTINGS: methodSettings({}),
          OTP_HMAC_SECRET: 'private-secret',
        });
        expect(mocks.incrementRpc).toHaveBeenCalledTimes(1);
      });

      it('creates no account for a new address when signup is not allowed', async () => {
        mocks.findByEmail.mockResolvedValueOnce(null);

        const response = await post(
          '/send',
          { email: 'new@example.com' },
          {
            SETTINGS: methodSettings({
              'authentication-methods.email_otp.login_enabled': true,
              'authentication-methods.email_otp.signup_enabled': false,
            }),
            OTP_HMAC_SECRET: 'private-secret',
          }
        );

        expect(response.status).toBe(200);
        noEffects();
      });

      it('replies to an existing and to a new address the same way', async () => {
        const settings = { SETTINGS: methodSettings({}), OTP_HMAC_SECRET: 'private-secret' };
        const existing = await post('/send', body, settings);
        mocks.findByEmail.mockResolvedValueOnce(null);
        const created = await post('/send', { email: 'new@example.com' }, settings);

        expect(existing.status).toBe(created.status);
        expect(Object.keys(await existing.json()).sort()).toEqual(
          Object.keys(await created.json()).sort()
        );
      });
    });

    describe('the public reply does not tell an address with an account from one without', () => {
      const secret = { OTP_HMAC_SECRET: 'private-secret' };
      const mixed = {
        'authentication-methods.email_otp.login_enabled': true,
        'authentication-methods.email_otp.signup_enabled': false,
      };
      const both = EMAIL_OTP_ENABLED;

      // What a caller can see: status, body fields, and the cookie's name and attributes.
      async function publicShape(response: Response) {
        const body = (await response.json()) as Record<string, unknown>;
        return {
          status: response.status,
          body: Object.fromEntries(
            Object.entries(body).map(([key, value]) => [
              key,
              typeof value === 'string' ? value.replace(/[0-9a-f-]{36}/g, '<id>') : value,
            ])
          ),
          cookie: (response.headers.get('set-cookie') ?? '').replace(/=[0-9a-f-]{36}/, '=<id>'),
        };
      }

      async function bothShapes(settings: Record<string, unknown>, extra = {}) {
        const bindings = { SETTINGS: methodSettings(settings), ...secret, ...extra };
        const existing = await publicShape(
          await post('/send', { email: 'user@example.com' }, bindings)
        );
        mocks.findByEmail.mockResolvedValueOnce(null);
        const created = await publicShape(
          await post('/send', { email: 'new@example.com' }, bindings)
        );
        return { existing, created };
      }

      it('is the same when login is allowed and signup is not', async () => {
        const { existing, created } = await bothShapes(mixed);
        expect(created).toEqual(existing);
        expect(existing.status).toBe(200);
        // Only the existing address was sent a code.
        expect(mocks.notifierSend).toHaveBeenCalledTimes(1);
        expect(mocks.syncUser).not.toHaveBeenCalled();
      });

      it('is the same when sending fails', async () => {
        mocks.notifierSend.mockResolvedValue({ success: false, error: 'provider rejected' });
        const { existing, created } = await bothShapes(both);
        expect(created).toEqual(existing);
        expect(existing.status).toBe(200);
        expect(existing.cookie).toContain('authrim_otp_session=<id>');
        expect(mocks.error).toHaveBeenCalledWith(
          'Failed to send email code',
          expect.objectContaining({ action: 'email_send' })
        );
      });

      it('is the same when the sending fails for one address and the other is not sent to', async () => {
        mocks.notifierSend.mockResolvedValue({ success: false, error: 'provider rejected' });
        const { existing, created } = await bothShapes(mixed);
        expect(created).toEqual(existing);
      });

      it('is the same when the OTP secret is not configured', async () => {
        mocks.findByEmail.mockResolvedValueOnce(null);
        const settings = { SETTINGS: methodSettings(both) };
        const existing = await publicShape(
          await post('/send', { email: 'user@example.com' }, settings)
        );
        mocks.findByEmail.mockResolvedValueOnce(null);
        const created = await publicShape(
          await post('/send', { email: 'new@example.com' }, settings)
        );
        expect(created).toEqual(existing);
        expect(existing.status).toBe(200);
      });

      it('is the same when the new account cannot be created', async () => {
        mocks.syncUser.mockRejectedValue(new Error('database down'));
        const { existing, created } = await bothShapes(both);
        expect(created).toEqual(existing);
      });

      it('is the same when saving the code fails', async () => {
        mocks.storeChallengeRpc.mockRejectedValue(new Error('challenge store unavailable'));
        const { existing, created } = await bothShapes(both);
        expect(created).toEqual(existing);
        expect(existing.status).toBe(200);
        expect(existing.cookie).toContain('authrim_otp_session=<id>');
        expect(mocks.notifierSend).not.toHaveBeenCalled();
      });

      it('is the same when a tenant write fence stops the new account', async () => {
        mocks.syncUser.mockRejectedValue(new Error('tenant_placement_migration_write_fenced'));
        const { existing, created } = await bothShapes(both);
        expect(created).toEqual(existing);
        expect(existing.status).toBe(200);
      });

      describe('when finding the account fails', () => {
        it('is the same in standard storage', async () => {
          // The account is found but cannot be read; the unknown address is simply not found.
          const bindings = { SETTINGS: methodSettings(both), ...secret };
          mocks.findByEmail.mockRejectedValueOnce(new Error('core read failed'));
          const existing = await publicShape(
            await post('/send', { email: 'user@example.com' }, bindings)
          );
          mocks.findByEmail.mockResolvedValueOnce(null);
          const unknown = await publicShape(
            await post('/send', { email: 'new@example.com' }, bindings)
          );
          expect(unknown).toEqual(existing);
          expect(existing.status).toBe(200);
        });

        it('is the same in tenant-D1 storage, and creates nothing', async () => {
          const bindings = { SETTINGS: methodSettings(both), ...secret, __TENANT_D1: true };
          mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
            new Error('core read failed')
          );
          const existing = await publicShape(
            await post('/send', { email: 'user@example.com' }, bindings)
          );
          expect(mocks.provisionTenantD1EmailAccount).not.toHaveBeenCalled();

          mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
            new Error('account_data_route_not_found')
          );
          const unknown = await publicShape(
            await post('/send', { email: 'new@example.com' }, bindings)
          );
          expect(unknown).toEqual(existing);
          expect(existing.status).toBe(200);
        });

        it('does not take a failed lookup for an unknown address: no account is created, nothing is sent', async () => {
          mocks.findByEmail.mockRejectedValueOnce(new Error('lookup failed'));
          const response = await post(
            '/send',
            { email: 'maybe-known@example.com' },
            { SETTINGS: methodSettings(both), ...secret }
          );
          expect(response.status).toBe(200);
          expect(mocks.syncUser).not.toHaveBeenCalled();
          expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
          expect(mocks.notifierSend).not.toHaveBeenCalled();

          mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
            new Error('core read failed')
          );
          const d1 = await post(
            '/send',
            { email: 'maybe-known@example.com' },
            { SETTINGS: methodSettings(both), ...secret, __TENANT_D1: true }
          );
          expect(d1.status).toBe(200);
          expect(mocks.provisionTenantD1EmailAccount).not.toHaveBeenCalled();
          expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
        });

        it('is audited, with a hash and no address', async () => {
          mocks.findByEmail.mockRejectedValueOnce(new Error('core read failed'));
          await post(
            '/send',
            { email: 'person@example.com' },
            { SETTINGS: methodSettings(both), ...secret }
          );
          expect(mocks.createAuditLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              action: 'auth.email_code.send_failed',
              resourceId: 'email-hash',
            })
          );
          expect(JSON.stringify(mocks.createAuditLog.mock.calls)).not.toContain(
            'person@example.com'
          );
        });
      });

      describe('what is kept for operators', () => {
        const auditedReasons = () =>
          mocks.createAuditLog.mock.calls.map(([, entry]) => ({
            action: entry.action,
            reason: JSON.parse(entry.metadata).reason,
            serialized: JSON.stringify(entry),
          }));

        it.each([
          [
            'the OTP secret is not configured',
            'otp_secret_missing',
            () => {},
            { SETTINGS: methodSettings(both) },
          ],
          [
            'the new account cannot be created',
            'account_create_failed',
            () => {
              mocks.findByEmail.mockResolvedValueOnce(null);
              mocks.syncUser.mockRejectedValue(new Error('database down'));
            },
            { SETTINGS: methodSettings(both), ...secret },
          ],
          [
            'the mail cannot be sent',
            'delivery_failed',
            () => mocks.notifierSend.mockResolvedValue({ success: false, error: 'rejected' }),
            { SETTINGS: methodSettings(both), ...secret },
          ],
          [
            'the code cannot be saved',
            'send_failed',
            () => mocks.storeChallengeRpc.mockRejectedValue(new Error('store down')),
            { SETTINGS: methodSettings(both), ...secret },
          ],
        ])(
          'writes an audit entry when %s, without the address or the code',
          async (_n, reason, arrange, bindings) => {
            arrange();
            const response = await post('/send', { email: 'person@example.com' }, bindings);

            expect(response.status).toBe(200);
            const entries = auditedReasons();
            expect(entries).toEqual([
              expect.objectContaining({ action: 'auth.email_code.send_failed', reason }),
            ]);
            expect(entries[0].serialized).not.toContain('person@example.com');
            expect(entries[0].serialized).not.toContain('123456');
            expect(mocks.createAuditLog).toHaveBeenCalledWith(
              expect.anything(),
              expect.objectContaining({ tenantId: 'tenant-1', resourceId: 'email-hash' })
            );
          }
        );

        it('writes nothing when the send worked', async () => {
          await post(
            '/send',
            { email: 'user@example.com' },
            { SETTINGS: methodSettings(both), ...secret }
          );
          expect(mocks.createAuditLog).not.toHaveBeenCalled();
        });
      });

      it('is the same as the usual reply when login is not allowed', async () => {
        const sent = await publicShape(
          await post(
            '/send',
            { email: 'user@example.com' },
            { SETTINGS: methodSettings(both), ...secret }
          )
        );
        const suppressed = await publicShape(
          await post(
            '/send',
            { email: 'user@example.com' },
            { SETTINGS: methodSettings({}), ...secret }
          )
        );
        expect(suppressed).toEqual(sent);
      });

      it('is the usual reply for a recently deleted address, with nothing created, sent or audited', async () => {
        mocks.findByEmail.mockResolvedValue(null);
        const sent = await publicShape(
          await post(
            '/send',
            { email: 'new@example.com' },
            { SETTINGS: methodSettings(both), ...secret }
          )
        );
        vi.clearAllMocks();
        mocks.findByEmail.mockResolvedValue(null);
        for (const outcome of ['blocked', 'unavailable'] as const) {
          registrationCheck.override = outcome;
          try {
            const refused = await publicShape(
              await post(
                '/send',
                { email: 'deleted@example.com' },
                { SETTINGS: methodSettings(both), ...secret }
              )
            );
            expect(refused).toEqual(sent);
          } finally {
            registrationCheck.override = null;
          }
        }
        expect(mocks.syncUser).not.toHaveBeenCalled();
        expect(mocks.notifierSend).not.toHaveBeenCalled();
        // No audit entry links the address, or its hash, to the deleted account.
        expect(mocks.createAuditLog).not.toHaveBeenCalled();
      });

      it('does not hold the reply back for a slow mail provider', async () => {
        let release: (value: unknown) => void = () => {};
        mocks.notifierSend.mockReturnValue(new Promise((resolve) => (release = resolve)));

        const response = await post(
          '/send',
          { email: 'user@example.com' },
          { SETTINGS: methodSettings(both), ...secret },
          undefined,
          { awaitBackground: false }
        );

        // The reply is out while the provider has not answered yet.
        expect(response.status).toBe(200);
        expect(mocks.notifierSend).toHaveBeenCalledTimes(1);
        release({ success: true });
      });
    });

    it('rate limits on normalized email without issuing a challenge', async () => {
      mocks.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 120 });

      const response = await post('/send', { email: 'User@Example.com' });

      expect(response.status).toBe(429);
      expect(mocks.incrementRpc).toHaveBeenCalledWith('email_code:user@example.com', {
        windowSeconds: 900,
        maxRequests: 3,
      });
      expect(mocks.generateCode).not.toHaveBeenCalled();
    });

    it.each([
      [
        'the tenant setting',
        { 'rate_limit.email_max_requests': 6, 'rate_limit.email_window': 1800 },
        6,
        1800,
      ],
      ['its default for a value out of range', { 'rate_limit.email_max_requests': 50 }, 3, 900],
    ])('limits sends by %s', async (_label, saved, maxRequests, windowSeconds) => {
      mocks.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 120 });

      const response = await post(
        '/send',
        { email: 'user@example.com' },
        {
          SETTINGS: {
            get: vi.fn(async (key: string) =>
              key === 'settings:tenant:tenant-1:rate-limit' ? JSON.stringify(saved) : null
            ),
          },
        }
      );

      expect(response.status).toBe(429);
      expect(mocks.incrementRpc).toHaveBeenCalledWith('email_code:user@example.com', {
        windowSeconds,
        maxRequests,
      });
    });

    it('rejects missing registration fields before creating a new user', async () => {
      mocks.findByEmail.mockResolvedValueOnce(null);
      mocks.validateRegistration.mockResolvedValueOnce({
        ok: false,
        error: 'required',
        missingRequiredFields: [{ fieldKey: 'department', label: 'Department', fieldType: 'text' }],
      });

      const response = await post(
        '/send',
        { email: 'new@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      expect(response.status).toBe(400);
      expect(mocks.syncUser).not.toHaveBeenCalled();
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('does not leak PII when canonical user creation fails', async () => {
      mocks.findByEmail.mockResolvedValueOnce(null);
      mocks.syncUser.mockRejectedValueOnce(new Error('sensitive database detail'));

      const response = await post(
        '/send',
        { email: 'new@example.com', name: 'New User' },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      // The reply is the usual one, so it does not tell a new address from an existing one.
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain('sensitive database detail');
      expect(mocks.error).toHaveBeenCalledWith(
        'Failed to create canonical runtime user',
        { action: 'runtime_user_create' },
        expect.any(Error)
      );
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('fails closed before challenge storage when OTP secret is absent, with the usual reply', async () => {
      const response = await post('/send', { email: 'user@example.com' });

      expect(response.status).toBe(200);
      expect(mocks.hashCode).not.toHaveBeenCalled();
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
      expect(mocks.notifierSend).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith(
        'OTP_HMAC_SECRET must be configured for email-code auth',
        { action: 'email_code_send' }
      );
    });

    it("uses the tenant's email code lifetime for the code and its cookie", async () => {
      const response = await post(
        '/send',
        { email: 'user@example.com' },
        {
          OTP_HMAC_SECRET: 'private-secret',
          EMAIL_FROM: 'login@example.com',
          SETTINGS: {
            get: vi.fn(async (key: string) =>
              key === 'settings:tenant:tenant-1:credentials'
                ? JSON.stringify({ 'credentials.email_code_ttl': 90 })
                : key === 'settings:tenant:tenant-1:authentication-methods'
                  ? JSON.stringify(EMAIL_OTP_ENABLED)
                  : null
            ),
          },
        }
      );

      expect(response.status).toBe(200);
      expect(mocks.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'email_code', ttl: 90 })
      );
      expect(response.headers.get('set-cookie')).toContain('Max-Age=90');
    });

    it('stores only the hashed OTP and sends the plaintext through the notifier', async () => {
      const response = await post(
        '/send',
        { email: 'User@Example.com' },
        { OTP_HMAC_SECRET: 'private-secret', EMAIL_FROM: 'login@example.com' }
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        messageId: 'email-code:00000000-0000-4000-8000-000000000000',
      });
      expect(mocks.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          type: 'email_code',
          userId: 'user-1',
          challenge: 'hashed-code',
          ttl: 300,
          email: 'user@example.com',
        })
      );
      expect(JSON.stringify(mocks.storeChallengeRpc.mock.calls)).not.toContain('123456');
      expect(mocks.notifierSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'User@Example.com',
          from: 'login@example.com',
          body: expect.stringContaining('123456'),
        })
      );
      expect(response.headers.get('set-cookie')).toContain(
        'authrim_otp_session=00000000-0000-4000-8000-000000000000'
      );
    });

    it('creates a new canonical user with validated custom fields', async () => {
      mocks.findByEmail.mockResolvedValueOnce(null);
      mocks.validateRegistration.mockResolvedValueOnce({
        ok: true,
        values: { department: 'Security' },
      });

      const response = await post(
        '/send',
        {
          email: 'New@Example.com',
          name: 'New User',
          custom_fields: { department: 'Security' },
        },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      expect(response.status).toBe(200);
      expect(mocks.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'new-user-1',
          email: 'new@example.com',
          name: 'New User',
          emailVerified: false,
          userType: 'end_user',
        })
      );
      expect(mocks.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ custom_fields: { department: 'Security' } }),
        })
      );
    });

    it('returns 202 and does not create an OTP while tenant-D1 publication is pending', async () => {
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
        new Error('account_data_route_not_found')
      );
      mocks.provisionTenantD1EmailAccount.mockResolvedValueOnce({
        status: 'pending',
        response: Response.json(
          {
            status: 'provisioning',
            provisioning_token: 'A'.repeat(43),
            status_endpoint: '/api/v1/auth/account-provisioning/status',
            retry_after_ms: 500,
          },
          { status: 202 }
        ),
      });

      const response = await post(
        '/send',
        { email: 'new@example.com', name: 'New User' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true }
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ status: 'provisioning' });
      expect(mocks.provisionTenantD1EmailAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'tenant-1',
          flow: 'email_code',
          email: 'new@example.com',
          runtimeUser: expect.objectContaining({
            sourceRef: 'auth:email_code',
            sensitiveValues: expect.objectContaining({
              email: 'new@example.com',
              name: 'New User',
            }),
          }),
        })
      );
      expect(mocks.syncUser).not.toHaveBeenCalled();
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
      expect(mocks.notifierSend).not.toHaveBeenCalled();
    });

    it('uses the routed account and the Core-only OTP projection for an existing tenant-D1 user', async () => {
      const response = await post(
        '/send',
        { email: 'User@Example.com' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true }
      );

      expect(response.status).toBe(200);
      expect(mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono).toHaveBeenCalledWith(
        expect.anything(),
        {
          indexKind: 'email_exact',
          identifier: 'user@example.com',
          trustedEmail: 'user@example.com',
        }
      );
      expect(mocks.findForOtpLogin).not.toHaveBeenCalled();
      expect(mocks.findByEmail).not.toHaveBeenCalled();
    });

    it('answers as usual when no notifier is configured', async () => {
      mocks.getNotifier.mockReturnValueOnce(null);

      const response = await post(
        '/send',
        { email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      // Not told to the caller; kept for the logs, and the code is taken back.
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('123456');
      expect(mocks.error).toHaveBeenCalledWith(
        'Failed to send email code',
        expect.objectContaining({ action: 'email_send' })
      );
      expect(mocks.deleteChallengeRpc).toHaveBeenCalledWith(
        'email_code:00000000-0000-4000-8000-000000000000'
      );
    });

    it('answers as usual when delivery fails', async () => {
      mocks.notifierSend.mockResolvedValueOnce({ success: false, error: 'provider rejected' });

      const response = await post(
        '/send',
        { email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('provider rejected');
      expect(mocks.error).toHaveBeenCalledWith(
        'Failed to send email code',
        expect.objectContaining({ action: 'email_send' })
      );
      expect(mocks.deleteChallengeRpc).toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    const cookie = 'authrim_otp_session=otp-session-1';

    it.each([
      [{ email: 'user@example.com' }, cookie, 400],
      [{ code: '123456' }, cookie, 400],
      [{ code: '12345', email: 'user@example.com' }, cookie, 400],
      [{ code: 'abcdef', email: 'user@example.com' }, cookie, 400],
      [{ code: '123456', email: 'user@example.com' }, undefined, 401],
    ])('rejects invalid or unbound verification input', async (body, requestCookie, status) => {
      const response = await post('/verify', body, {}, requestCookie);
      expect(response.status).toBe(status);
      expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
    });

    it('maps missing, expired, and replayed challenges to the same error', async () => {
      mocks.consumeChallengeRpc.mockRejectedValueOnce(new Error('already consumed'));

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        {},
        cookie
      );

      expect(response.status).toBe(400);
      expect(mocks.verifyCode).not.toHaveBeenCalled();
      expect(mocks.publishEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ data: expect.objectContaining({ errorCode: 'challenge_error' }) })
      );
    });

    it.each([
      [
        { ...validChallenge, metadata: { ...validChallenge.metadata, otp_session_id: 'other' } },
        400,
      ],
      [{ ...validChallenge, email: 'other@example.com' }, 400],
    ])('rejects challenge binding mismatch', async (challenge, status) => {
      mocks.consumeChallengeRpc.mockResolvedValueOnce(challenge);

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        {},
        cookie
      );

      expect(response.status).toBe(status);
      expect(mocks.verifyCode).not.toHaveBeenCalled();
    });

    it('fails closed after consumption when the OTP secret is absent', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        {},
        cookie
      );

      expect(response.status).toBe(500);
      expect(mocks.verifyCode).not.toHaveBeenCalled();
    });

    it('rejects an invalid code without creating a session', async () => {
      mocks.verifyCode.mockResolvedValueOnce(false);

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(400);
      expect(mocks.createSessionRpc).not.toHaveBeenCalled();
    });

    it.each([null, { ...validChallenge, active: 0 }])(
      'rejects a missing or inactive canonical user',
      async (runtimeUser) => {
        mocks.findForOtpLogin.mockResolvedValueOnce(runtimeUser);

        const response = await post(
          '/verify',
          { code: '123456', email: 'user@example.com' },
          { OTP_HMAC_SECRET: 'private-secret' },
          cookie
        );

        expect(response.status).toBe(400);
        expect(mocks.createSessionRpc).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledWith(
          'Canonical runtime user unavailable after account route resolution',
          expect.objectContaining({
            action: 'email_code_verify_user_read',
            runtimeUserState: runtimeUser ? 'inactive' : 'missing',
          })
        );
      }
    );

    it.each(['account_authentication_not_allowed', 'database_unavailable'])(
      'does not create a session when the guest credential fence fails (%s)',
      async (reason) => {
        mocks.guestCredentialFence.mockRejectedValueOnce(new Error(reason));
        const response = await post(
          '/verify',
          { code: '123456', email: 'user@example.com' },
          { OTP_HMAC_SECRET: 'private-secret' },
          cookie
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(mocks.guestCredentialFence).toHaveBeenCalledWith(
          expect.anything(),
          'tenant-1',
          'user-1'
        );
        expect(mocks.createSessionRpc).not.toHaveBeenCalled();
      }
    );
    describe('when the tenant has not allowed email code for login', () => {
      // This endpoint is for signing in. Signing up with an email code is the Direct Auth API's
      // (/api/v1/auth/direct/email-code/*), so allowing signup alone does not open this one.
      it.each([
        ['login_enabled is false', { 'authentication-methods.email_otp.login_enabled': false }],
        ['the method was never configured', {}],
        [
          'only signup is allowed',
          {
            'authentication-methods.email_otp.login_enabled': false,
            'authentication-methods.email_otp.signup_enabled': true,
          },
        ],
      ])('creates no session when %s', async (_name, settings) => {
        const response = await post(
          '/verify',
          { code: '123456', email: 'user@example.com' },
          { SETTINGS: methodSettings(settings), OTP_HMAC_SECRET: 'private-secret' },
          cookie
        );

        expect(response.status).toBe(403);
        expect(mocks.createSessionRpc).not.toHaveBeenCalled();
        expect(response.headers.get('set-cookie') ?? '').not.toContain('authrim_session=');
      });
    });

    it('creates a session, clears the OTP cookie, and records observable side effects', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'USER@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        sessionId: 'session-1',
        userId: 'user-1',
      });
      expect(mocks.createSessionRpc).toHaveBeenCalledWith(
        'session-1',
        'user-1',
        86_400,
        expect.objectContaining({ email: 'user@example.com', amr: ['otp'] }),
        'tenant-1'
      );
      expect(response.headers.get('set-cookie')).toContain('authrim_otp_session=;');
      expect(response.headers.get('set-cookie')).toContain('authrim_session=session-1');
      expect(mocks.markEmailVerifiedAndTouchLastLogin).toHaveBeenCalledWith(
        'user-1',
        expect.any(Number)
      );
      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          resourceId: 'session-1',
          ipAddress: '192.0.2.20',
        })
      );
    });

    it('resolves the challenge account route before tenant-D1 user reads', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true },
        cookie
      );

      expect(response.status).toBe(200);
      expect(mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono).toHaveBeenCalledWith(
        expect.anything(),
        {
          indexKind: 'account_id',
          identifier: 'account:user-1',
          expectedAccountId: 'account:user-1',
          expectedLegacyUserId: 'user-1',
          trustedEmail: 'user@example.com',
        }
      );
      expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
      expect(mocks.createAccountAuthContextFromHono).not.toHaveBeenCalled();
      expect(mocks.findForOtpLogin).not.toHaveBeenCalled();
      expect(mocks.markOtpLoginEmailVerified).toHaveBeenCalledWith(
        { adapter: 'tenant-core' },
        'tenant-1',
        'user-1',
        expect.any(Number)
      );
      expect(mocks.markEmailVerifiedForOtpLogin).not.toHaveBeenCalled();
      expect(mocks.markEmailVerifiedAndTouchLastLogin).not.toHaveBeenCalled();
    });

    it('skips the tenant-D1 Core update when the routed email is already verified', async () => {
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValueOnce({
        tenantId: 'tenant-1',
        accountId: 'account:user-1',
        legacyUserId: 'user-1',
        storageProfileId: 'builtin:storage:tenant-d1',
        coreDb: { adapter: 'tenant-core' },
        coreBindingRef: 'TDB_USERS',
        coreResidencyPartition: 'default',
        accountRouteGeneration: 1,
        membership: {},
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'User',
          active: 1,
          email_verified: 1,
          account_type: 'end_user',
          created_at: '2023-11-14T22:13:20.000Z',
        },
      });

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true },
        cookie
      );

      expect(response.status).toBe(200);
      expect(mocks.markOtpLoginEmailVerified).not.toHaveBeenCalled();
      expect(mocks.markEmailVerifiedForOtpLogin).not.toHaveBeenCalled();
      expect(mocks.markEmailVerifiedAndTouchLastLogin).not.toHaveBeenCalled();
    });

    it('fails closed when the consumed challenge cannot resolve a tenant-D1 account route', async () => {
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
        new Error('account_data_route_not_found')
      );

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true },
        cookie
      );

      expect(response.status).toBe(500);
      expect(mocks.findForOtpLogin).not.toHaveBeenCalled();
      expect(mocks.createSessionRpc).not.toHaveBeenCalled();
    });

    it('returns retryable 503 when tenant-D1 is overloaded', async () => {
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
        new Error('D1 DB is overloaded')
      );

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true },
        cookie
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('1');
      await expect(response.json()).resolves.toMatchObject({
        error: 'temporarily_unavailable',
        extensions: { reason: 'data_store_overloaded', retryable: true },
      });
    });

    it('does not add account routing to the standard storage verification path', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(200);
      expect(mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono).not.toHaveBeenCalled();
      expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
    });

    it('continues login when optional custom-field persistence fails', async () => {
      mocks.consumeChallengeRpc.mockResolvedValueOnce({
        ...validChallenge,
        metadata: { ...validChallenge.metadata, custom_fields: { department: 'Security' } },
      });
      mocks.persistRegistrationFields.mockRejectedValueOnce(new Error('storage unavailable'));

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(200);
      expect(mocks.warn).toHaveBeenCalledWith(
        'Failed to settle registration attributes',
        { action: 'registration_fields_persist' },
        expect.any(Error)
      );
    });

    it('does not mutate a guest session through the regular email login endpoint', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        `${cookie}; authrim_session=anonymous-session-1`
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sessionId: 'session-1' });
      expect(mocks.createSessionRpc).toHaveBeenCalledWith(
        'session-1',
        'user-1',
        expect.any(Number),
        expect.objectContaining({ email: 'user@example.com', amr: ['otp'] }),
        'tenant-1'
      );
    });

    it('does not attach an already verified account to an anonymous session', async () => {
      mocks.findForOtpLogin.mockResolvedValueOnce({
        id: 'user-1',
        email: 'user@example.com',
        name: 'User',
        active: 1,
        email_verified: 1,
      });
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        `${cookie}; authrim_session=anonymous-session-1`
      );

      expect(response.status).toBe(200);
      expect(mocks.createSessionRpc).toHaveBeenCalled();
    });

    it('returns a stable session-store error when session creation fails', async () => {
      mocks.createSessionRpc.mockRejectedValueOnce(new Error('DO unavailable'));

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(500);
      expect(mocks.publishEvent).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ data: expect.objectContaining({ sessionId: 'session-1' }) })
      );
    });
  });
});

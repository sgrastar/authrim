import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/services/log-iceberg-emitter')>()),
  emitLogIcebergRow: vi.fn(async () => ({})),
}));
vi.mock('@authrim/ar-lib-core', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).coreMock(o as never)
);
vi.mock('../sign-in-attempt-recording', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().signInAttempt(o as never)
);
vi.mock('../flow-session-profile', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().flowSession(o as never)
);
vi.mock('../direct-auth', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().directAuth(o as never)
);
vi.mock('../human-verification', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().humanVerification(o as never)
);
vi.mock('../registration-policy-gate', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().registrationGate(o as never)
);
vi.mock('../account-provisioning', async (o) =>
  (await import('./helpers/mut-directory-login-harness'))
    .localMocks()
    .accountProvisioning(o as never)
);

vi.mock('../directory-email-code-gate', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().emailCodeGate(o as never)
);

import {
  directoryMigrationEmailCodeSendHandler,
  directoryMigrationEmailCodeVerifyHandler,
  directoryMigrationPasskeyOptionsHandler,
  directoryMigrationPasskeyVerifyHandler,
} from '../directory-password-login';
import { createContext, m, read, resetHarness } from './helpers/mut-directory-login-harness';

type Handler = (c: never) => Promise<Response>;
const REQUIRED = { status: 400, code: 'AR130001' };
const EXPIRED = { status: 401, code: 'AR000001' };

async function call(
  handler: Handler,
  body: unknown,
  options: Parameters<typeof createContext>[1] = {}
) {
  const { status, body: json } = await read(await handler(createContext(body, options) as never));
  return { status, code: json.error_code, body: json };
}

const tx = { transaction_id: ' tx_1 ', transaction_token: ' tok ' };
const transaction = { id: 'tx_1', user_id: 'user_1', scope: 'passkey_enrollment', created_at: 1 };

beforeEach(() => resetHarness());

describe('migration passkey options', () => {
  it.each([
    [{}],
    [{ transaction_id: '  ', transaction_token: 'tok' }],
    [{ transaction_id: 'tx', transaction_token: 5 }],
  ])('requires transaction id and token: %j', async (body) => {
    expect(await call(directoryMigrationPasskeyOptionsHandler, body)).toMatchObject(REQUIRED);
    expect(m.activeTransaction).not.toHaveBeenCalled();
  });

  it('answers session expired for an unknown transaction, looked up by trimmed id and token hash', async () => {
    expect(await call(directoryMigrationPasskeyOptionsHandler, tx)).toMatchObject(EXPIRED);
    expect(m.activeTransaction).toHaveBeenCalledWith(m.coreAdapter, {
      tenantId: 'tenant-a',
      transactionId: 'tx_1',
      tokenHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
      scope: 'passkey_enrollment',
    });
  });

  it.each([
    ['no origin header', {}, undefined],
    ['foreign origin', { origin: 'https://evil.example' }, undefined],
    [
      'http origin on a non-loopback host',
      { origin: 'http://auth.example.com', host: 'auth.example.com' },
      'https://other.example/x',
    ],
  ])('refuses a request with %s', async (_l, headers, url) => {
    m.activeTransaction.mockResolvedValue(transaction);
    expect(await call(directoryMigrationPasskeyOptionsHandler, tx, { headers, url })).toMatchObject(
      {
        status: 403,
        code: 'AR050006',
      }
    );
    expect(m.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['the request origin', { origin: 'https://auth.example.com/' }, undefined],
    [
      'the host header',
      { origin: 'https://login.example.com', host: 'LOGIN.example.com' },
      'https://internal.example/x',
    ],
    [
      'an http loopback host',
      { origin: 'http://localhost:8787', host: 'localhost:8787' },
      'https://internal.example/x',
    ],
    [
      'an http 127.0.0.1 host',
      { origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' },
      'https://internal.example/x',
    ],
  ])('accepts %s and then refuses an inactive user', async (_l, headers, url) => {
    m.activeTransaction.mockResolvedValue(transaction);
    m.findById.mockResolvedValue({ id: 'user_1', active: 0 });
    expect(await call(directoryMigrationPasskeyOptionsHandler, tx, { headers, url })).toMatchObject(
      {
        status: 400,
        code: 'AR030001',
      }
    );
    expect(m.findById).toHaveBeenCalledWith('user_1', { includeInactive: true });
  });

  it('returns the write-fence response for a fenced tenant', async () => {
    m.activeTransaction.mockRejectedValue(new Error('write_fenced'));
    expect(await call(directoryMigrationPasskeyOptionsHandler, tx)).toMatchObject({
      status: 503,
      body: { error: 'tenant_write_fenced' },
    });
  });

  it('returns an internal error for other failures', async () => {
    m.activeTransaction.mockRejectedValue(new Error('db'));
    expect((await call(directoryMigrationPasskeyOptionsHandler, tx)).status).toBe(500);
  });
});

describe('migration passkey verify', () => {
  const full = { ...tx, challenge_id: ' ch ', credential: { id: 'c' } };
  it.each([
    [{ ...full, credential: undefined }],
    [{ ...full, challenge_id: ' ' }],
    [{ ...full, transaction_token: '' }],
    [{ ...full, transaction_id: undefined }],
  ])('requires all fields: %j', async (body) => {
    expect(await call(directoryMigrationPasskeyVerifyHandler, body)).toMatchObject(REQUIRED);
  });

  it('answers session expired for an unknown transaction', async () => {
    expect(await call(directoryMigrationPasskeyVerifyHandler, full)).toMatchObject(EXPIRED);
    expect(m.activeTransaction).toHaveBeenCalledWith(
      m.coreAdapter,
      expect.objectContaining({ transactionId: 'tx_1', scope: 'passkey_enrollment' })
    );
  });

  it('returns the write-fence response for a fenced tenant', async () => {
    m.activeTransaction.mockRejectedValue(new Error('write_fenced'));
    expect((await call(directoryMigrationPasskeyVerifyHandler, full)).body).toEqual({
      error: 'tenant_write_fenced',
    });
  });
});

describe('migration email code send', () => {
  it('returns the email-code gate refusal before reading the body', async () => {
    m.emailGate.mockResolvedValue(Response.json({ error: 'off' }, { status: 403 }));
    const result = await call(directoryMigrationEmailCodeSendHandler, tx);
    expect(result).toMatchObject({ status: 403, body: { error: 'off' } });
    expect(m.activeTransaction).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ transaction_id: 'tx', transaction_token: '  ' }]])(
    'requires fields: %j',
    async (body) => {
      expect(await call(directoryMigrationEmailCodeSendHandler, body)).toMatchObject(REQUIRED);
    }
  );

  it('looks up email-code then recovery transactions and expires when neither exists', async () => {
    expect(await call(directoryMigrationEmailCodeSendHandler, tx)).toMatchObject(EXPIRED);
    expect(m.activeTransaction.mock.calls.map((c) => (c[1] as { scope: string }).scope)).toEqual([
      'email_code_fallback',
      'recovery',
    ]);
  });

  it.each([
    ['missing user', null],
    ['inactive user', { id: 'user_1', active: 0, email: 'a@x' }],
    ['user without email', { id: 'user_1', active: 1, email: null }],
  ])('expires for a %s', async (_l, user) => {
    m.activeTransaction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...transaction, scope: 'recovery' });
    m.findById.mockResolvedValue(user);
    expect(await call(directoryMigrationEmailCodeSendHandler, tx)).toMatchObject(EXPIRED);
    expect(m.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('applies the per-transaction email send limit', async () => {
    m.activeTransaction.mockResolvedValue({ ...transaction, scope: 'email_code_fallback' });
    m.rateLimiter.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 30 });
    const options = {};
    const ctx = createContext(tx, options);
    const response = await directoryMigrationEmailCodeSendHandler(ctx as never);
    expect(response.status).toBe(429);
    expect(m.rateLimiter.incrementRpc).toHaveBeenCalledWith('transaction:tx_1', {
      windowSeconds: 600,
      maxRequests: 3,
    });
    expect(ctx.env.RATE_LIMITER.idFromName).toHaveBeenCalledWith(
      expect.stringContaining('directory-migration-email-code')
    );
  });

  it('refuses to send without an OTP HMAC secret', async () => {
    m.activeTransaction.mockResolvedValue({ ...transaction, scope: 'email_code_fallback' });
    const result = await call(directoryMigrationEmailCodeSendHandler, tx);
    expect(result.status).toBe(500);
  });

  it('returns the write-fence response for a fenced tenant', async () => {
    m.activeTransaction.mockRejectedValue(new Error('write_fenced'));
    expect((await call(directoryMigrationEmailCodeSendHandler, tx)).body).toEqual({
      error: 'tenant_write_fenced',
    });
  });
});

describe('migration email code verify', () => {
  const full = { ...tx, challenge_id: ' ch ', code: ' 123456 ' };
  it.each([
    [{ ...full, code: '12345' }],
    [{ ...full, code: '1234567' }],
    [{ ...full, code: '12a456' }],
    [{ ...full, code: 123456 }],
    [{ ...full, challenge_id: '' }],
    [{ ...full, transaction_token: ' ' }],
    [{ ...full, transaction_id: '' }],
  ])('rejects %j as a missing or malformed field', async (body) => {
    expect(await call(directoryMigrationEmailCodeVerifyHandler, body)).toMatchObject(REQUIRED);
    expect(m.activeTransaction).not.toHaveBeenCalled();
  });

  it('accepts a trimmed six-digit code and expires for an unknown transaction', async () => {
    expect(await call(directoryMigrationEmailCodeVerifyHandler, full)).toMatchObject(EXPIRED);
    expect(m.activeTransaction).toHaveBeenCalledWith(
      m.coreAdapter,
      expect.objectContaining({ transactionId: 'tx_1' })
    );
  });

  it('returns the email-code gate refusal first', async () => {
    m.emailGate.mockResolvedValue(Response.json({ error: 'off' }, { status: 403 }));
    expect((await call(directoryMigrationEmailCodeVerifyHandler, full)).status).toBe(403);
    expect(m.activeTransaction).not.toHaveBeenCalled();
  });

  it('returns the write-fence response for a fenced tenant', async () => {
    m.activeTransaction.mockRejectedValue(new Error('write_fenced'));
    expect((await call(directoryMigrationEmailCodeVerifyHandler, full)).body).toEqual({
      error: 'tenant_write_fenced',
    });
  });
});

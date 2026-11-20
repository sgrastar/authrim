import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isSetupDisabled: vi.fn(),
  validateSetupToken: vi.fn(),
  completeSetup: vi.fn(),
  createSetupSession: vi.fn(),
  validateSetupSession: vi.fn(),
  deleteSetupSession: vi.fn(),
  isSystemInitialized: vi.fn(),
  assignSystemAdminRole: vi.fn(),
  getTenantSettingsDocument: vi.fn(),
  createAdminUser: vi.fn(),
  setEmailVerified: vi.fn(),
  adminExecute: vi.fn(),
  adminDeletePasskeys: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    isSetupDisabled: mocks.isSetupDisabled,
    validateSetupToken: mocks.validateSetupToken,
    completeSetup: mocks.completeSetup,
    createSetupSession: mocks.createSetupSession,
    validateSetupSession: mocks.validateSetupSession,
    deleteSetupSession: mocks.deleteSetupSession,
    isSystemInitialized: mocks.isSystemInitialized,
    assignSystemAdminRole: mocks.assignSystemAdminRole,
    generateId: vi.fn(() => 'setup-token-1'),
    generateUserIdFromSettings: vi.fn(async () => 'admin-user-1'),
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    getTenantSettingsDocument: mocks.getTenantSettingsDocument,
    AdminUserRepository: class {
      createAdminUser = mocks.createAdminUser;
      setEmailVerified = mocks.setEmailVerified;
    },
    AdminPasskeyRepository: class {
      deleteAllByUser = mocks.adminDeletePasskeys;
    },
    requireDedicatedAdminDatabaseAdapter: mocks.requireAdmin,
  };
});

import { setupApp } from '../setup';

function createKv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string): Promise<string | null> => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}
type Kv = ReturnType<typeof createKv>;

function bindings(kv: Kv | undefined = createKv({ 'csrf:csrf-1': 'true' }), overrides = {}) {
  return {
    AUTHRIM_CONFIG: kv,
    ISSUER_URL: 'https://auth.example.com',
    DB_ADMIN: {},
    ADMIN_UI_URL: 'https://admin.example.com',
    ...overrides,
  } as Record<string, unknown>;
}

async function call(path: string, init: RequestInit | undefined, env: Record<string, unknown>) {
  const pending = setupApp.request(path, init, env);
  await vi.runAllTimersAsync();
  const response = await pending;
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    body: (type.includes('json') ? await response.json() : await response.text()) as never,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.isSetupDisabled.mockResolvedValue(false);
  mocks.validateSetupToken.mockResolvedValue({ valid: true });
  mocks.createSetupSession.mockResolvedValue('temporary-session-1');
  mocks.isSystemInitialized.mockResolvedValue(false);
  mocks.getTenantSettingsDocument.mockResolvedValue(null);
  mocks.adminExecute.mockResolvedValue({ success: true });
  mocks.requireAdmin.mockImplementation(() => ({ execute: mocks.adminExecute }));
});
afterEach(() => vi.useRealTimers());

describe('setup completion', () => {
  const complete = (headers: Record<string, string>, env = bindings()) =>
    call('/api/admin-init-setup/complete', { method: 'POST', headers }, env);

  beforeEach(() => {
    mocks.validateSetupSession.mockResolvedValue({
      valid: true,
      data: { userId: 'admin-user-1', email: 'admin@example.com', setupTokenId: 'setup-token-1' },
    });
  });

  it('requires the setup session header', async () => {
    expect(await complete({})).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'X-Setup-Session header is required' },
    });
    expect(mocks.validateSetupSession).not.toHaveBeenCalled();
  });

  it.each([[{ valid: false }], [{ valid: true }]])(
    'rejects an invalid session %j',
    async (validation) => {
      mocks.validateSetupSession.mockResolvedValue(validation);
      expect(await complete({ 'X-Setup-Session': 'temp-1' })).toEqual({
        status: 401,
        body: {
          error: 'invalid_session',
          error_description: 'Setup session is invalid or expired',
        },
      });
      expect(mocks.completeSetup).not.toHaveBeenCalled();
    }
  );

  it('disables setup, removes the session and both CSRF records', async () => {
    const kv = createKv({ 'setup:csrf:temp-1': 'csrf-9', 'csrf:csrf-9': 'true' });
    const result = await complete({ 'X-Setup-Session': 'temp-1' }, bindings(kv));
    expect(result).toEqual({
      status: 200,
      body: {
        success: true,
        user: {
          id: 'admin-user-1',
          email: 'admin@example.com',
          name: null,
          role: 'ar_super_admin',
        },
        message: 'Administrator account created. Please complete passkey registration on Admin UI.',
        admin_ui_url: 'https://admin.example.com',
        admin_ui_setup_url: 'https://admin.example.com/setup/complete?token=setup-token-1',
        setup_token: 'setup-token-1',
        cli_fallback:
          'If the Admin UI setup URL does not work, run: npx @authrim/setup admin-passkey --env <env>',
      },
    });
    expect(mocks.validateSetupSession).toHaveBeenCalledWith(expect.anything(), 'temp-1');
    expect(mocks.completeSetup).toHaveBeenCalledTimes(1);
    expect(mocks.deleteSetupSession).toHaveBeenCalledWith(expect.anything(), 'temp-1');
    expect(kv.delete).toHaveBeenCalledWith('csrf:csrf-9');
    expect(kv.delete).toHaveBeenCalledWith('setup:csrf:temp-1');
  });

  it('omits the Admin UI link without a setup token id and keeps a given name', async () => {
    mocks.validateSetupSession.mockResolvedValue({
      valid: true,
      data: { userId: 'admin-user-1', email: 'a@example.com', name: 'Ada' },
    });
    const kv = createKv();
    const result = await complete({ 'X-Setup-Session': 'temp-1' }, bindings(kv));
    expect(result.body).toMatchObject({
      user: { name: 'Ada' },
      admin_ui_url: 'https://admin.example.com',
      admin_ui_setup_url: null,
    });
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('returns null links without ADMIN_UI_URL and no KV', async () => {
    const result = await complete(
      { 'X-Setup-Session': 'temp-1' },
      bindings(undefined, { ADMIN_UI_URL: '' })
    );
    expect(result.body).toMatchObject({ admin_ui_url: null, admin_ui_setup_url: null });
  });

  it('answers a sanitized server_error when completion fails', async () => {
    mocks.completeSetup.mockRejectedValue(new Error('kv'));
    expect(await complete({ 'X-Setup-Session': 'temp-1' })).toEqual({
      status: 500,
      body: {
        error: 'server_error',
        error_description: 'An error occurred during setup completion',
      },
    });
  });
});

describe('setup page', () => {
  const page = (query: string, env = bindings()) =>
    call(`/admin-init-setup${query}`, undefined, env);

  it.each([
    ['no_token', 'The setup token has expired. Please generate a new token.'],
    ['invalid_token', 'Invalid setup token. Please check the URL.'],
    ['setup_completed', 'Setup has already been completed.'],
    [undefined, 'Invalid setup token. Please check the URL.'],
  ])('explains token reason %s', async (reason, message) => {
    mocks.validateSetupToken.mockResolvedValue({ valid: false, reason });
    const result = await page('?token=abc');
    expect(String(result.body)).toContain(message);
  });

  it('asks for a token when none is given', async () => {
    expect(String((await page('')).body)).toContain('No setup token provided');
    expect(mocks.validateSetupToken).not.toHaveBeenCalled();
  });

  it('stores a fresh one-hour CSRF token for the form', async () => {
    const kv = createKv();
    const result = await page('?token=abc', bindings(kv));
    const [key, value, options] = kv.put.mock.calls[0];
    expect(key).toMatch(/^csrf:[A-Za-z0-9_-]{43}$/);
    expect(value).toBe('true');
    expect(options).toEqual({ expirationTtl: 3600 });
    expect(String(result.body)).toContain(key.slice('csrf:'.length));
  });

  it('renders the form without KV', async () => {
    expect(String((await page('?token=abc', bindings(undefined))).body)).toContain('<form');
  });
});

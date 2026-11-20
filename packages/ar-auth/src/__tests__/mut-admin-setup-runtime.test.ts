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

function initialize(
  body: Record<string, unknown> = {},
  env = bindings(),
  headers: Record<string, string> = { Origin: 'https://auth.example.com' }
) {
  return call(
    '/api/admin-init-setup/initialize',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        setup_token: 'valid-setup-token',
        email: 'Admin@Example.com',
        name: 'Admin User',
        csrf_token: 'csrf-1',
        ...body,
      }),
    },
    env
  );
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

describe('setup middleware', () => {
  it('reports a completed setup with its exact description', async () => {
    mocks.isSetupDisabled.mockResolvedValue(true);
    const result = await initialize();
    expect(result).toEqual({
      status: 403,
      body: {
        error: 'setup_completed',
        error_description: 'Initial setup has already been completed',
      },
    });
  });

  it('counts attempts per forwarded IP with a one-hour window', async () => {
    const kv = createKv({ 'csrf:csrf-1': 'true', 'ratelimit:setup:198.51.100.2': '3' });
    await initialize({}, bindings(kv), {
      Origin: 'https://auth.example.com',
      'x-forwarded-for': '198.51.100.2',
    });
    expect(kv.put).toHaveBeenCalledWith('ratelimit:setup:198.51.100.2', '4', {
      expirationTtl: 3600,
    });
  });

  it('uses an "unknown" bucket and treats a garbage counter as zero', async () => {
    const kv = createKv({ 'csrf:csrf-1': 'true', 'ratelimit:setup:unknown': 'garbage' });
    await initialize({}, bindings(kv));
    expect(kv.put).toHaveBeenCalledWith('ratelimit:setup:unknown', '1', { expirationTtl: 3600 });
  });

  it.each([['10'], ['99999999999999999999']])(
    'blocks once the counter reaches the cap (%s)',
    async (count) => {
      const kv = createKv({ 'ratelimit:setup:unknown': count });
      const result = await initialize({}, bindings(kv));
      expect(result).toEqual({
        status: 429,
        body: {
          error: 'too_many_requests',
          error_description: 'Too many setup attempts. Please try again later.',
        },
      });
    }
  );

  it('allows the tenth attempt', async () => {
    const kv = createKv({ 'csrf:csrf-1': 'true', 'ratelimit:setup:unknown': '9' });
    const result = await initialize({}, bindings(kv));
    expect(result.status).toBe(200);
  });

  it('continues when the rate-limit store fails', async () => {
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    kv.get.mockRejectedValueOnce(new Error('kv down'));
    const result = await initialize({}, bindings(kv));
    expect(result.status).toBe(200);
  });
});

describe('setup status', () => {
  it('does not reveal a token once setup is disabled for the status route', async () => {
    mocks.isSetupDisabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.isSystemInitialized.mockResolvedValue(true);
    const kv = createKv({ 'setup:token': 'x' });
    const result = await call('/api/admin-init-setup/status', undefined, bindings(kv));
    expect(result.body).toEqual({
      initialized: true,
      setup_disabled: true,
      setup_token_valid: false,
    });
  });

  it('reports no token without a KV binding', async () => {
    const result = await call('/api/admin-init-setup/status', undefined, bindings(undefined));
    expect(result.body).toEqual({
      initialized: false,
      setup_disabled: false,
      setup_token_valid: false,
    });
  });
});

describe('initialize', () => {
  it.each([
    [{ setup_token: '' }, 400, 'invalid_request', 'setup_token is required'],
    [{ email: '' }, 400, 'invalid_request', 'email is required'],
    [{ csrf_token: '' }, 403, 'invalid_csrf', 'CSRF token is required'],
    [{ csrf_token: 'unknown' }, 403, 'invalid_csrf', 'Invalid or expired CSRF token'],
    [
      { email: `${'a'.repeat(243)}@example.com` },
      400,
      'invalid_request',
      'Email address is too long',
    ],
    [{ email: 'a`b@example.com' }, 400, 'invalid_request', 'Email contains invalid characters'],
    [{ email: 'a\\b@example.com' }, 400, 'invalid_request', 'Email contains invalid characters'],
    [{ email: 'a"b@example.com' }, 400, 'invalid_request', 'Email contains invalid characters'],
    [{ email: "a'b@example.com" }, 400, 'invalid_request', 'Email contains invalid characters'],
    [{ email: 'a>b@example.com' }, 400, 'invalid_request', 'Email contains invalid characters'],
    [
      { email: 'a\u0000b@example.com' },
      400,
      'invalid_request',
      'Email contains invalid characters',
    ],
    [{ email: 'admin@-bad.example' }, 400, 'invalid_request', 'Invalid email format'],
    [
      { email: `${'a'.repeat(65)}@example.com` },
      400,
      'invalid_request',
      'Email local part is too long',
    ],
    [{ name: 'n'.repeat(201) }, 400, 'invalid_request', 'Name is too long (max 200 characters)'],
  ])('rejects %j', async (body, status, error, description) => {
    const result = await initialize(body);
    expect(result).toEqual({ status, body: { error, error_description: description } });
    expect(mocks.createAdminUser).not.toHaveBeenCalled();
  });

  it('accepts boundary-length email parts and name', async () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(60)}.example.com`;
    const result = await initialize({ email, name: 'n'.repeat(200) });
    expect(result.status).toBe(200);
  });

  it('skips CSRF storage checks without a KV binding and takes no lock', async () => {
    const result = await initialize({}, bindings(undefined));
    expect(result.status).toBe(200);
  });

  it.each([
    ['held', (kv: Kv) => kv.values.set('setup:lock', 'other')],
    [
      'taken between checks',
      (kv: Kv) => {
        let reads = 0;
        const original = kv.get.getMockImplementation()!;
        kv.get.mockImplementation(async (key) => {
          if (key === 'setup:lock' && ++reads === 2) return 'other';
          return original(key);
        });
      },
    ],
    [
      'overwritten after write',
      (kv: Kv) => {
        const original = kv.put.getMockImplementation()!;
        kv.put.mockImplementation(async (key, value, opts) =>
          original(key, key === 'setup:lock' ? 'other' : value, opts)
        );
      },
    ],
    [
      'overwritten before final read',
      (kv: Kv) => {
        let reads = 0;
        const original = kv.get.getMockImplementation()!;
        kv.get.mockImplementation(async (key) => {
          if (key === 'setup:lock' && kv.values.has('setup:lock') && ++reads === 2) return 'other';
          return original(key);
        });
      },
    ],
    [
      'broken',
      (kv: Kv) => {
        const original = kv.get.getMockImplementation()!;
        kv.get.mockImplementation(async (key) => {
          if (key === 'setup:lock') throw new Error('kv');
          return original(key);
        });
      },
    ],
  ])('reports setup_in_progress when the lock is %s', async (_label, arrange) => {
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    arrange(kv);
    const result = await initialize({}, bindings(kv));
    expect(result).toEqual({
      status: 409,
      body: {
        error: 'setup_in_progress',
        error_description: 'Another setup is currently in progress. Please try again.',
      },
    });
    expect(mocks.validateSetupToken).not.toHaveBeenCalled();
  });

  it('acquires the lock with a one-minute TTL and releases it after an initialized check', async () => {
    mocks.isSystemInitialized.mockResolvedValue(true);
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    const result = await initialize({}, bindings(kv));
    expect(result).toEqual({
      status: 409,
      body: {
        error: 'already_initialized',
        error_description: 'System already has an administrator',
      },
    });
    const lockPut = kv.put.mock.calls.find(([key]) => key === 'setup:lock')!;
    expect(lockPut[1]).toMatch(/^\d+-[A-Za-z0-9_-]{22}$/);
    expect(lockPut[2]).toEqual({ expirationTtl: 60 });
    expect(kv.delete).toHaveBeenCalledWith('setup:lock');
  });

  it.each([
    ['no_token', 'No valid setup token found. Please generate a new token.'],
    ['invalid_token', 'Invalid setup token'],
    ['setup_completed', 'Setup has already been completed'],
    [undefined, 'Invalid setup token'],
  ])('maps token reason %s to its description', async (reason, description) => {
    mocks.validateSetupToken.mockResolvedValue({ valid: false, reason });
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    const result = await initialize({}, bindings(kv));
    expect(result).toEqual({
      status: 401,
      body: { error: 'invalid_token', error_description: description },
    });
    expect(mocks.validateSetupToken).toHaveBeenCalledWith(expect.anything(), 'valid-setup-token');
    expect(kv.values.has('setup:lock')).toBe(false);
  });

  it('requires an Origin header and releases the lock', async () => {
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    const result = await initialize({}, bindings(kv), {});
    expect(result).toEqual({
      status: 403,
      body: {
        error: 'invalid_origin',
        error_description: 'Origin header is required for WebAuthn operations',
      },
    });
    expect(kv.values.has('setup:lock')).toBe(false);
  });

  it('uses the tenant allowed origins when ALLOWED_ORIGINS is not set', async () => {
    mocks.getTenantSettingsDocument.mockResolvedValue({
      'tenant.allowed_origins': 'https://console.example.com',
    });
    const ok = await initialize({}, bindings(), { Origin: 'https://console.example.com' });
    expect(ok.status).toBe(200);
    expect(mocks.getTenantSettingsDocument).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'tenant',
      {
        onUnreadable: 'empty',
      }
    );
    const refused = await initialize({}, bindings(), { Origin: 'https://auth.example.com' });
    expect(refused).toEqual({
      status: 403,
      body: {
        error: 'invalid_origin',
        error_description: 'Origin not allowed for WebAuthn operations',
      },
    });
  });

  it('prefers ALLOWED_ORIGINS and ignores a non-string tenant setting', async () => {
    mocks.getTenantSettingsDocument.mockResolvedValue({ 'tenant.allowed_origins': 42 });
    const env = bindings(undefined, { ALLOWED_ORIGINS: 'https://ops.example.com' });
    expect((await initialize({}, env, { Origin: 'https://ops.example.com' })).status).toBe(200);
    expect((await initialize({}, env, { Origin: 'https://auth.example.com' })).status).toBe(403);
  });

  it('allows any origin when none is configured, and the request host itself', async () => {
    const open = bindings(undefined, { ISSUER_URL: undefined });
    expect((await initialize({}, open, { Origin: 'https://random.example.org' })).status).toBe(200);
    const self = await initialize({}, bindings(undefined), {
      Origin: 'https://setup.internal.example',
      host: 'setup.internal.example',
    });
    expect(self.status).toBe(200);
  });

  it('creates the admin, a 24-hour Admin UI token and the CSRF reference', async () => {
    const before = Date.now();
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    const result = await initialize({ name: '' }, bindings(kv));
    expect(result).toEqual({
      status: 200,
      body: {
        success: true,
        user_id: 'admin-user-1',
        temp_session_token: 'temporary-session-1',
        setup_token: 'setup-token-1',
        admin_ui_url: 'https://admin.example.com',
        admin_ui_setup_url: 'https://admin.example.com/setup/complete?token=setup-token-1',
      },
    });
    expect(mocks.createAdminUser).toHaveBeenCalledWith({
      id: 'admin-user-1',
      tenant_id: 'tenant-1',
      email: 'admin@example.com',
      name: undefined,
    });
    expect(mocks.setEmailVerified).toHaveBeenCalledWith('admin-user-1');
    expect(mocks.assignSystemAdminRole).toHaveBeenCalledWith(
      expect.anything(),
      'admin-user-1',
      'tenant-1'
    );
    const params = mocks.adminExecute.mock.calls[0][1] as unknown[];
    expect(params.slice(0, 3)).toEqual(['setup-token-1', 'tenant-1', 'admin-user-1']);
    expect(Number(params[3]) - Number(params[4])).toBe(86_400_000);
    expect(params[4]).toBeGreaterThanOrEqual(before);
    expect(mocks.createSetupSession).toHaveBeenCalledWith(expect.anything(), {
      userId: 'admin-user-1',
      email: 'Admin@Example.com',
      name: '',
      setupTokenId: 'setup-token-1',
    });
    expect(kv.put).toHaveBeenCalledWith('setup:csrf:temporary-session-1', 'csrf-1', {
      expirationTtl: 3600,
    });
    expect(kv.values.has('setup:lock')).toBe(false);
  });

  it('returns null Admin UI links when ADMIN_UI_URL is not configured', async () => {
    const result = await initialize({}, bindings(undefined, { ADMIN_UI_URL: '' }));
    expect(result.body).toMatchObject({ admin_ui_url: null, admin_ui_setup_url: null });
  });

  it('rolls back the admin and its passkeys and releases the lock on a late failure', async () => {
    mocks.assignSystemAdminRole.mockRejectedValue(new Error('role'));
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    const result = await initialize({}, bindings(kv));
    expect(result).toEqual({
      status: 500,
      body: {
        error: 'server_error',
        error_description: 'An error occurred during setup initialization',
      },
    });
    expect(mocks.adminDeletePasskeys).toHaveBeenCalledWith('admin-user-1');
    expect(mocks.adminExecute).toHaveBeenCalledWith('DELETE FROM admin_users WHERE id = ?', [
      'admin-user-1',
    ]);
    expect(kv.values.has('setup:lock')).toBe(false);
  });

  it('still answers server_error when the rollback itself fails', async () => {
    mocks.assignSystemAdminRole.mockRejectedValue(new Error('role'));
    mocks.adminDeletePasskeys.mockRejectedValue(new Error('rollback'));
    const kv = createKv({ 'csrf:csrf-1': 'true' });
    kv.delete.mockRejectedValue(new Error('kv'));
    const result = await initialize({}, bindings(kv));
    expect(result.status).toBe(500);
  });

  it('does not roll back when the failure precedes admin creation', async () => {
    mocks.requireAdmin.mockImplementation(() => {
      throw new Error('admin_database_binding_missing');
    });
    const result = await initialize({}, bindings(undefined));
    expect(result.status).toBe(500);
    expect(mocks.adminDeletePasskeys).not.toHaveBeenCalled();
  });
});

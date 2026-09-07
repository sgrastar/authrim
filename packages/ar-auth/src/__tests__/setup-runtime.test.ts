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
  getTenantSettings: vi.fn(),
  isAllowedOrigin: vi.fn(),
  createAdminUser: vi.fn(),
  setEmailVerified: vi.fn(),
  createRuntimeUser: vi.fn(),
  adminExecute: vi.fn(),
  adminDeletePasskeys: vi.fn(),
  requireAdmin: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
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
    getTenantSettings: mocks.getTenantSettings,
    parseAllowedOrigins: vi.fn((value?: string) =>
      value ? value.split(',').map((item) => item.trim()) : []
    ),
    isAllowedOrigin: mocks.isAllowedOrigin,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalIdentityRepository: class {},
    CanonicalRuntimeUserWriter: class {
      createFromRuntimeUser = mocks.createRuntimeUser;
      deleteRuntimeUser = vi.fn(async () => undefined);
    },
    AdminUserRepository: class {
      createAdminUser = mocks.createAdminUser;
      setEmailVerified = mocks.setEmailVerified;
    },
    AdminPasskeyRepository: class {
      deleteAllByUser = mocks.adminDeletePasskeys;
    },
    requireDedicatedAdminDatabaseAdapter: mocks.requireAdmin,
    createLogger: vi.fn(() => ({
      module: () => ({
        info: mocks.loggerInfo,
        warn: mocks.loggerWarn,
        error: mocks.loggerError,
      }),
    })),
  };
});

import { setupApp } from '../setup';

function createKv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function bindings(kv = createKv(), overrides: Record<string, unknown> = {}) {
  return {
    AUTHRIM_CONFIG: kv,
    ISSUER_URL: 'https://auth.example.com',
    ALLOWED_ORIGINS: 'https://auth.example.com',
    DB_ADMIN: {},
    ADMIN_UI_URL: 'https://admin.example.com',
    ...overrides,
  };
}

async function request(path: string, init: RequestInit | undefined, env: Record<string, unknown>) {
  const responsePromise = setupApp.request(path, init, env);
  await vi.runAllTimersAsync();
  return responsePromise;
}

function initializeBody(overrides: Record<string, unknown> = {}) {
  return {
    setup_token: 'valid-setup-token',
    email: 'Admin@Example.com',
    name: 'Admin User',
    csrf_token: 'csrf-1',
    ...overrides,
  };
}

function postJson(path: string, body: unknown, env: Record<string, unknown>, headers = {}) {
  return request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('initial setup runtime routes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isSetupDisabled.mockResolvedValue(false);
    mocks.validateSetupToken.mockResolvedValue({ valid: true });
    mocks.completeSetup.mockResolvedValue(undefined);
    mocks.createSetupSession.mockResolvedValue('temporary-session-1');
    mocks.validateSetupSession.mockResolvedValue({
      valid: true,
      data: {
        userId: 'admin-user-1',
        email: 'admin@example.com',
        name: 'Admin User',
        setupTokenId: 'setup-token-1',
      },
    });
    mocks.deleteSetupSession.mockResolvedValue(undefined);
    mocks.isSystemInitialized.mockResolvedValue(false);
    mocks.assignSystemAdminRole.mockResolvedValue(undefined);
    mocks.getTenantSettings.mockResolvedValue(null);
    mocks.isAllowedOrigin.mockImplementation((origin: string, allowed: string[]) =>
      allowed.includes(origin)
    );
    mocks.createAdminUser.mockResolvedValue(undefined);
    mocks.setEmailVerified.mockResolvedValue(undefined);
    mocks.createRuntimeUser.mockResolvedValue(undefined);
    mocks.adminExecute.mockResolvedValue({ success: true });
    mocks.adminDeletePasskeys.mockResolvedValue(undefined);
    mocks.requireAdmin.mockImplementation((env: { DB_ADMIN?: unknown }) => {
      if (!env.DB_ADMIN) throw new Error('admin_database_binding_missing');
      return { execute: mocks.adminExecute };
    });
  });

  afterEach(() => vi.useRealTimers());

  it('blocks every setup API after setup is disabled', async () => {
    mocks.isSetupDisabled.mockResolvedValueOnce(true);
    const response = await request('/api/admin-init-setup/status', undefined, bindings(createKv()));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'setup_completed' });
    expect(mocks.isSystemInitialized).not.toHaveBeenCalled();
  });

  it('rate limits setup attempts by connecting IP before route processing', async () => {
    const kv = createKv({ 'ratelimit:setup:192.0.2.30': '10' });
    const response = await postJson(
      '/api/admin-init-setup/initialize',
      initializeBody(),
      bindings(kv),
      { Origin: 'https://auth.example.com', 'CF-Connecting-IP': '192.0.2.30' }
    );

    expect(response.status).toBe(429);
    expect(mocks.validateSetupToken).not.toHaveBeenCalled();
  });

  it('does not increment the rate counter for status checks', async () => {
    const kv = createKv({ 'setup:token': 'token' });
    const response = await request('/api/admin-init-setup/status', undefined, bindings(kv));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      initialized: false,
      setup_disabled: false,
      setup_token_valid: true,
    });
    expect(kv.put).not.toHaveBeenCalledWith(
      expect.stringContaining('ratelimit:'),
      expect.anything(),
      expect.anything()
    );
  });

  describe('initialize validation and isolation', () => {
    it.each([
      [{ setup_token: '', email: 'admin@example.com', csrf_token: 'csrf-1' }, 400],
      [{ setup_token: 'token', email: '', csrf_token: 'csrf-1' }, 400],
      [{ setup_token: 'token', email: 'admin@example.com', csrf_token: '' }, 403],
    ])('requires setup token, email, and CSRF token', async (body, status) => {
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        body,
        bindings(createKv()),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(status);
      expect(mocks.validateSetupToken).not.toHaveBeenCalled();
    });

    it('rejects an expired CSRF token before acquiring the setup lock', async () => {
      const kv = createKv();
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody(),
        bindings(kv),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(403);
      expect(kv.put).not.toHaveBeenCalledWith('setup:lock', expect.anything(), expect.anything());
    });

    it.each([
      ['a'.repeat(245) + '@example.com', 'too long'],
      ['admin<script>@example.com', 'invalid characters'],
      ['not-an-email', 'Invalid email format'],
      [`${'a'.repeat(65)}@example.com`, 'local part is too long'],
    ])('rejects unsafe admin email input: %s', async (email, message) => {
      const kv = createKv({ 'csrf:csrf-1': 'true' });
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody({ email }),
        bindings(kv),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error_description: string };
      expect(payload.error_description).toContain(message);
      expect(mocks.createAdminUser).not.toHaveBeenCalled();
    });

    it('rejects an oversized display name', async () => {
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody({ name: 'a'.repeat(201) }),
        bindings(createKv({ 'csrf:csrf-1': 'true' })),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(400);
    });

    it('rejects a concurrent setup lock', async () => {
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody(),
        bindings(createKv({ 'csrf:csrf-1': 'true', 'setup:lock': 'other-request' })),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(409);
      expect(mocks.validateSetupToken).not.toHaveBeenCalled();
    });

    it('rechecks initialization while holding the distributed lock', async () => {
      mocks.isSystemInitialized.mockResolvedValueOnce(true);
      const kv = createKv({ 'csrf:csrf-1': 'true' });
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody(),
        bindings(kv),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'already_initialized' });
      expect(kv.delete).toHaveBeenCalledWith('setup:lock');
    });

    it.each(['no_token', 'invalid_token', 'setup_completed', undefined])(
      'returns a non-secret-bearing response for invalid setup token reason %s',
      async (reason) => {
        mocks.validateSetupToken.mockResolvedValueOnce({ valid: false, reason });
        const response = await postJson(
          '/api/admin-init-setup/initialize',
          initializeBody(),
          bindings(createKv({ 'csrf:csrf-1': 'true' })),
          { Origin: 'https://auth.example.com' }
        );

        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain('valid-setup-token');
      }
    );

    it('requires an Origin after token validation', async () => {
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody(),
        bindings(createKv({ 'csrf:csrf-1': 'true' }))
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'invalid_origin' });
    });

    it('rejects an origin outside the configured allowlist', async () => {
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody(),
        bindings(createKv({ 'csrf:csrf-1': 'true' })),
        { Origin: 'https://evil.example.com' }
      );

      expect(response.status).toBe(403);
      expect(mocks.createAdminUser).not.toHaveBeenCalled();
    });

    it('creates the dedicated admin record and one-time Admin UI token', async () => {
      const kv = createKv({ 'csrf:csrf-1': 'true' });
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody(),
        bindings(kv),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        user_id: 'admin-user-1',
        temp_session_token: 'temporary-session-1',
        setup_token: 'setup-token-1',
        admin_ui_setup_url: 'https://admin.example.com/setup/complete?token=setup-token-1',
      });
      expect(mocks.createAdminUser).toHaveBeenCalledWith({
        id: 'admin-user-1',
        tenant_id: 'tenant-1',
        email: 'admin@example.com',
        name: 'Admin User',
      });
      expect(mocks.setEmailVerified).toHaveBeenCalledWith('admin-user-1');
      expect(mocks.assignSystemAdminRole).toHaveBeenCalledWith(
        expect.anything(),
        'admin-user-1',
        'tenant-1'
      );
      expect(mocks.adminExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO admin_setup_tokens'),
        expect.arrayContaining(['setup-token-1', 'tenant-1', 'admin-user-1'])
      );
      expect(kv.delete).toHaveBeenCalledWith('setup:lock');
    });

    it('fails closed when dedicated Admin storage is absent', async () => {
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody({ name: undefined }),
        bindings(createKv({ 'csrf:csrf-1': 'true' }), { DB_ADMIN: undefined }),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(500);
      expect(mocks.createRuntimeUser).not.toHaveBeenCalled();
      expect(mocks.createAdminUser).not.toHaveBeenCalled();
      expect(mocks.adminExecute).not.toHaveBeenCalled();
    });

    it('rolls back a created dedicated admin if a later setup step fails', async () => {
      mocks.assignSystemAdminRole.mockRejectedValueOnce(new Error('role storage unavailable'));
      const response = await postJson(
        '/api/admin-init-setup/initialize',
        initializeBody(),
        bindings(createKv({ 'csrf:csrf-1': 'true' })),
        { Origin: 'https://auth.example.com' }
      );

      expect(response.status).toBe(500);
      expect(mocks.adminDeletePasskeys).toHaveBeenCalledWith('admin-user-1');
      expect(mocks.adminExecute).toHaveBeenCalledWith('DELETE FROM admin_users WHERE id = ?', [
        'admin-user-1',
      ]);
    });
  });

  describe('complete', () => {
    it('requires a setup session header', async () => {
      const response = await postJson('/api/admin-init-setup/complete', {}, bindings(createKv()));
      expect(response.status).toBe(400);
    });

    it('rejects an expired setup session', async () => {
      mocks.validateSetupSession.mockResolvedValueOnce({ valid: false });
      const response = await postJson('/api/admin-init-setup/complete', {}, bindings(createKv()), {
        'X-Setup-Session': 'expired-session',
      });

      expect(response.status).toBe(401);
      expect(mocks.completeSetup).not.toHaveBeenCalled();
    });

    it('permanently completes setup and removes temporary CSRF state', async () => {
      const kv = createKv({ 'setup:csrf:temporary-session-1': 'csrf-1', 'csrf:csrf-1': 'true' });
      const response = await postJson('/api/admin-init-setup/complete', {}, bindings(kv), {
        'X-Setup-Session': 'temporary-session-1',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        user: { id: 'admin-user-1', email: 'admin@example.com', role: 'system_admin' },
        admin_ui_setup_url: 'https://admin.example.com/setup/complete?token=setup-token-1',
      });
      expect(mocks.completeSetup).toHaveBeenCalled();
      expect(mocks.deleteSetupSession).toHaveBeenCalledWith(
        expect.anything(),
        'temporary-session-1'
      );
      expect(kv.delete).toHaveBeenCalledWith('csrf:csrf-1');
      expect(kv.delete).toHaveBeenCalledWith('setup:csrf:temporary-session-1');
    });

    it('returns a sanitized error when completion storage fails', async () => {
      mocks.completeSetup.mockRejectedValueOnce(new Error('private storage detail'));
      const response = await postJson('/api/admin-init-setup/complete', {}, bindings(createKv()), {
        'X-Setup-Session': 'temporary-session-1',
      });

      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('private storage detail');
    });
  });

  describe('setup page', () => {
    it('shows a completed page after setup is disabled', async () => {
      mocks.isSetupDisabled.mockResolvedValueOnce(true);
      const response = await request('/admin-init-setup?token=secret', undefined, bindings());
      expect(await response.text()).toContain('Setup Already Complete');
    });

    it('does not render a form without a token', async () => {
      const response = await request('/admin-init-setup', undefined, bindings());
      expect(await response.text()).toContain('No setup token provided');
    });

    it.each(['no_token', 'invalid_token', 'setup_completed', undefined])(
      'renders a safe invalid-token page for reason %s',
      async (reason) => {
        mocks.validateSetupToken.mockResolvedValueOnce({ valid: false, reason });
        const response = await request('/admin-init-setup?token=secret', undefined, bindings());
        const html = await response.text();
        expect(html).toContain('Invalid Setup Token');
        expect(html).not.toContain('value="secret"');
      }
    );

    it('escapes the token before placing it into HTML and stores the CSRF token', async () => {
      const kv = createKv();
      const response = await request(
        '/admin-init-setup?token=%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
        undefined,
        bindings(kv)
      );
      const html = await response.text();

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(kv.put).toHaveBeenCalledWith(expect.stringMatching(/^csrf:/), 'true', {
        expirationTtl: 3600,
      });
    });
  });
});

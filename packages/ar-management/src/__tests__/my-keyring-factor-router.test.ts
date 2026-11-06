import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const NOW = Date.now();
const JKT = 'J'.repeat(43);

const mocks = vi.hoisted(() => ({
  listActiveByUser: vi.fn(),
  listByUser: vi.fn(),
  getEnrollmentGraceEndsAt: vi.fn(),
  hasEverEnrolled: vi.fn(),
  isActive: vi.fn(),
  insertKeyringHolderKey: vi.fn(),
  findActiveKeyringFactor: vi.fn(),
  touch: vi.fn(),
  revokeByAdmin: vi.fn(async () => true),
  recordSecondFactorVerification: vi.fn(),
  homeTenant: vi.fn(),
  eligibility: vi.fn(),
  issuer: vi.fn(),
  requireAdminStepUp: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  credentialRow: vi.fn(),
  sessionTenants: [] as string[],
  settings: vi.fn(),
  browserOrigin: vi.fn(),
  refuseRecoveryRequest: vi.fn(),
  fileRecoveryRequest: vi.fn(),
  auth: {},
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));
vi.mock('../routes/admin-management/my-second-factor-recovery', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../routes/admin-management/my-second-factor-recovery')
  >()),
  refuseRecoveryRequest: mocks.refuseRecoveryRequest,
  fileRecoveryRequest: mocks.fileRecoveryRequest,
}));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrlAsync: (...args: unknown[]) => mocks.issuer(...args) as Promise<string>,
}));
vi.mock('../admin-step-up-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-step-up-gate')>();
  return { ...actual, requireAdminStepUp: mocks.requireAdminStepUp };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminSecondFactorRepository {
    listActiveByUser = mocks.listActiveByUser;
    listByUser = mocks.listByUser;
    getEnrollmentGraceEndsAt = mocks.getEnrollmentGraceEndsAt;
    hasEverEnrolled = mocks.hasEverEnrolled;
    isActive = mocks.isActive;
    insertKeyringHolderKey = mocks.insertKeyringHolderKey;
    findActiveKeyringFactor = mocks.findActiveKeyringFactor;
    touch = mocks.touch;
    revokeByAdmin = mocks.revokeByAdmin;
  }
  class MockAdminSessionRepository {
    constructor(_adapter: unknown, tenantId: string) {
      mocks.sessionTenants.push(tenantId);
    }
    recordSecondFactorVerification = mocks.recordSecondFactorVerification;
  }
  return {
    ...actual,
    AdminSecondFactorRepository: MockAdminSecondFactorRepository,
    AdminSessionRepository: MockAdminSessionRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({ queryOne: mocks.homeTenant })),
    evaluateAdminCredentialEligibility: mocks.eligibility,
    resolveEffectiveSettings: mocks.settings,
    resolveAdminWebAuthnBrowserOrigin: mocks.browserOrigin,
    resolveTenantMetadataContext: vi.fn(async () => ({ coreDb: 'core-db' })),
    ensureDatabaseAdapter: vi.fn(() => ({ queryOne: mocks.credentialRow })),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
  };
});

import { myKeyringFactorRouter } from '../routes/admin-management/my-keyring-factor';

const vc = {
  createAdminPresentationRequest: vi.fn(),
  getAdminPresentationStatus: vi.fn(),
  consumeAdminPresentation: vi.fn(),
  submitAdminPresentationResponse: vi.fn(),
};

function human(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    email: 'admin@example.com',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    tenantId: 'acting-tenant',
    sessionTenantId: 'acting-tenant',
    sessionId: 'sess-1',
    secondFactorId: 'sf-1',
    secondFactorVerifiedAtMs: NOW - 1000,
    mfaVerified: true,
    authenticationTimeMs: NOW - 1000,
    ...overrides,
  };
}

function keyringFactor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'kf-1',
    admin_user_id: 'admin-1',
    kind: 'keyring_holder_key',
    credential_id: null,
    holder_jkt: JKT,
    public_key: null,
    counter: 0,
    transports: null,
    aaguid: null,
    backup_eligible: null,
    backup_state: null,
    label: 'Keyring',
    created_at: NOW - 10_000,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function call(
  method: 'GET' | 'POST',
  path: string,
  env: Partial<Env> = { VC_ISSUER: vc as never },
  body?: unknown
) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/keyring', myKeyringFactorRouter);
  return app.request(
    `/api/admin/me/keyring${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    },
    env
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionTenants.length = 0;
  mocks.auth = human();
  mocks.homeTenant.mockResolvedValue({ tenant_id: 'home-tenant' });
  mocks.eligibility.mockResolvedValue({ eligible: true });
  mocks.issuer.mockResolvedValue('https://home.example.com');
  mocks.listActiveByUser.mockResolvedValue([keyringFactor()]);
  mocks.listByUser.mockResolvedValue([keyringFactor()]);
  mocks.getEnrollmentGraceEndsAt.mockResolvedValue(NOW + 86_400_000);
  mocks.hasEverEnrolled.mockResolvedValue(true);
  mocks.isActive.mockResolvedValue(true);
  mocks.requireAdminStepUp.mockResolvedValue(null);
  mocks.findActiveKeyringFactor.mockResolvedValue(keyringFactor());
  mocks.touch.mockResolvedValue(true);
  mocks.recordSecondFactorVerification.mockResolvedValue(true);
  mocks.credentialRow.mockResolvedValue({ status: 'active' });
  mocks.settings.mockResolvedValue({ 'security.admin_keyring_dc_api': false });
  mocks.browserOrigin.mockReturnValue('https://console.example.com');
  mocks.refuseRecoveryRequest.mockResolvedValue(null);
  mocks.fileRecoveryRequest.mockResolvedValue(
    Response.json({ recovery: { id: 'rec-1', kind: 'keyring_holder_key' } }, { status: 201 })
  );
  vc.submitAdminPresentationResponse.mockResolvedValue({ outcome: 'verified' });
  vc.createAdminPresentationRequest.mockResolvedValue({
    requestId: 'g1:apac:0:vp_1',
    qr: 'openid4vp://?client_id=x&request_uri=y',
    matchCode: '42',
    expiresAt: NOW + 300_000,
  });
  vc.getAdminPresentationStatus.mockResolvedValue({ status: 'verified', expiresAt: NOW });
  vc.consumeAdminPresentation.mockResolvedValue({
    purpose: 'step_up',
    context: {},
    holderJkt: JKT,
    credentialId: 'cred-1',
    verifiedAt: NOW,
  });
});

describe('POST /step-up', () => {
  it('starts a presentation in the home tenant for the registered Keyring keys', async () => {
    const response = await call('POST', '/step-up');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      request_id: 'g1:apac:0:vp_1',
      qr: 'openid4vp://?client_id=x&request_uri=y',
      match_code: '42',
      expires_at: NOW + 300_000,
    });
    expect(vc.createAdminPresentationRequest).toHaveBeenCalledWith({
      tenantId: 'home-tenant',
      adminUserId: 'admin-1',
      sessionId: 'sess-1',
      purpose: 'step_up',
      holderJkts: [JKT],
      credentialIssuer: 'https://home.example.com',
      tenantLabel: 'home.example.com',
      context: {},
      mode: 'direct_post',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 409 when no Keyring key is registered (a security key does not count)', async () => {
    mocks.listActiveByUser.mockResolvedValue([
      keyringFactor({ kind: 'webauthn_credential', holder_jkt: null, credential_id: 'c' }),
    ]);
    const response = await call('POST', '/step-up');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'keyring_not_registered' });
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('refuses a machine or bearer caller', async () => {
    mocks.auth = human({ authMethod: 'bearer' });
    expect((await call('POST', '/step-up')).status).toBe(403);
    mocks.auth = human({ actorType: 'agent' });
    expect((await call('POST', '/step-up')).status).toBe(403);
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('refuses an admin who is no longer eligible for the admin credential', async () => {
    mocks.eligibility.mockResolvedValue({ eligible: false });
    const response = await call('POST', '/step-up');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'keyring_not_eligible' });
  });

  it('answers 503 without the VC service or an https issuer', async () => {
    expect((await call('POST', '/step-up', {})).status).toBe(503);
    mocks.issuer.mockResolvedValue('http://home.example.com');
    expect((await call('POST', '/step-up')).status).toBe(503);
  });
});

describe('GET /step-up/:id', () => {
  it('records the verified Keyring factor on the session, once', async () => {
    const response = await call('GET', '/step-up/g1:apac:0:vp_1');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'verified' });
    const ref = {
      tenantId: 'home-tenant',
      adminUserId: 'admin-1',
      sessionId: 'sess-1',
      requestId: 'g1:apac:0:vp_1',
    };
    expect(vc.getAdminPresentationStatus).toHaveBeenCalledWith(ref);
    expect(vc.consumeAdminPresentation).toHaveBeenCalledWith(ref);
    expect(mocks.findActiveKeyringFactor).toHaveBeenCalledWith('admin-1', JKT);
    expect(mocks.recordSecondFactorVerification).toHaveBeenCalledWith(
      'sess-1',
      { adminUserId: 'admin-1', secondFactorId: 'kf-1' },
      expect.any(Number)
    );
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.second_factor.verified',
        metadata: { second_factor_id: 'kf-1', kind: 'keyring_holder_key' },
      })
    );
  });

  it('records nothing when the credential was revoked after the wallet answered', async () => {
    mocks.credentialRow.mockResolvedValue({ status: 'revoked' });
    const response = await call('GET', '/step-up/g1:apac:0:vp_1');
    expect(await response.json()).toEqual({ status: 'failed', error: 'credential_not_active' });
    expect(mocks.credentialRow.mock.calls[0][1]).toEqual([
      'home-tenant',
      'cred-1',
      'admin-1',
      'https://authrim.com/credentials/admin/v1',
    ]);
    expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
  });

  it('records on the session of the tenant it was created in, while acting in another', async () => {
    mocks.auth = human({ tenantId: 'other-tenant', sessionTenantId: 'session-tenant' });
    await call('GET', '/step-up/g1:apac:0:vp_1');
    expect(mocks.sessionTenants).toEqual(['session-tenant']);
  });

  it('reports a pending or failed presentation without consuming it', async () => {
    vc.getAdminPresentationStatus.mockResolvedValue({
      status: 'failed',
      expiresAt: NOW,
      errorCode: 'match_code_mismatch',
    });
    const response = await call('GET', '/step-up/g1:apac:0:vp_1');
    expect(await response.json()).toEqual({
      status: 'failed',
      expires_at: NOW,
      error: 'match_code_mismatch',
    });
    expect(vc.consumeAdminPresentation).not.toHaveBeenCalled();
    expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
  });

  it('records nothing when the key was revoked since the request started', async () => {
    mocks.findActiveKeyringFactor.mockResolvedValue(null);
    const response = await call('GET', '/step-up/g1:apac:0:vp_1');
    expect(await response.json()).toEqual({ status: 'failed', error: 'holder_key_not_registered' });
    expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
  });

  it('records nothing for an enrolment result or one consumed by another poll', async () => {
    vc.consumeAdminPresentation.mockResolvedValueOnce({
      purpose: 'enroll',
      context: {},
      holderJkt: JKT,
      credentialId: 'c',
      verifiedAt: NOW,
    });
    expect(await (await call('GET', '/step-up/g1:apac:0:vp_1')).json()).toMatchObject({
      status: 'consumed',
    });
    vc.consumeAdminPresentation.mockResolvedValueOnce(null);
    expect(await (await call('GET', '/step-up/g1:apac:0:vp_1')).json()).toMatchObject({
      status: 'consumed',
    });
    expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
  });

  it('answers 404 for another session’s request or a malformed id', async () => {
    vc.getAdminPresentationStatus.mockResolvedValue(null);
    expect((await call('GET', '/step-up/g1:apac:0:vp_1')).status).toBe(404);
    expect((await call('GET', '/step-up/bad%20id')).status).toBe(404);
  });
});

describe('POST /enroll', () => {
  it('asks for an admin.second_factor.add step-up once a factor is active', async () => {
    const response = await call('POST', '/enroll');
    expect(response.status).toBe(201);
    expect(mocks.requireAdminStepUp).toHaveBeenCalledWith(
      expect.anything(),
      {
        operation: 'admin.second_factor.add',
        targetTenantId: 'acting-tenant',
        targetIds: ['admin-1'],
        params: { kind: 'keyring_holder_key' },
      },
      expect.any(Number)
    );
    expect(vc.createAdminPresentationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'enroll',
        holderJkts: [JKT],
        context: { mode: 'step_up', approving_factor_id: 'sf-1' },
      })
    );
  });

  it('starts nothing when the step-up refuses', async () => {
    mocks.requireAdminStepUp.mockResolvedValue(
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
    );
    expect((await call('POST', '/enroll')).status).toBe(403);
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('lets a first factor be enrolled with a fresh passkey inside the window', async () => {
    mocks.listActiveByUser.mockResolvedValue([]);
    mocks.listByUser.mockResolvedValue([]);
    mocks.hasEverEnrolled.mockResolvedValue(false);
    const response = await call('POST', '/enroll');
    expect(response.status).toBe(201);
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    expect(vc.createAdminPresentationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        holderJkts: [],
        context: { mode: 'first', approving_factor_id: null },
      })
    );
  });

  it('asks for a fresh passkey for a first factor', async () => {
    mocks.listActiveByUser.mockResolvedValue([]);
    mocks.hasEverEnrolled.mockResolvedValue(false);
    mocks.auth = human({ authenticationTimeMs: NOW - 3_600_000 });
    const response = await call('POST', '/enroll');
    expect(response.status).toBe(403);
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('sends an admin without factors past the window to recovery', async () => {
    mocks.listActiveByUser.mockResolvedValue([]);
    mocks.hasEverEnrolled.mockResolvedValue(true);
    const response = await call('POST', '/enroll');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'second_factor_recovery_required' });
  });
});

describe('GET /enroll/:id', () => {
  beforeEach(() => {
    vc.consumeAdminPresentation.mockResolvedValue({
      purpose: 'enroll',
      context: { mode: 'step_up', approving_factor_id: 'sf-1' },
      holderJkt: 'N'.repeat(43),
      credentialId: 'cred-2',
      verifiedAt: NOW,
    });
    mocks.insertKeyringHolderKey.mockResolvedValue({
      inserted: true,
      factor: keyringFactor({ id: 'kf-2', holder_jkt: 'N'.repeat(43) }),
    });
  });

  it('registers the presented holder key as a second factor', async () => {
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: 'verified',
      second_factor: { id: 'kf-2', kind: 'keyring_holder_key' },
    });
    expect(mocks.insertKeyringHolderKey).toHaveBeenCalledWith(
      { admin_user_id: 'admin-1', holder_jkt: 'N'.repeat(43), label: 'Keyring' },
      { firstOnly: false, approvedBy: { factorId: 'sf-1', sessionId: 'sess-1' } }
    );
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin.second_factor.added' })
    );
  });

  it('binds the registration to the approving factor and refuses when it was revoked meanwhile', async () => {
    mocks.insertKeyringHolderKey.mockResolvedValue({ inserted: false, reason: 'approval_revoked' });
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: 'failed', error: 'step_up_required' });
    expect(mocks.insertKeyringHolderKey).toHaveBeenCalledWith(expect.anything(), {
      firstOnly: false,
      approvedBy: { factorId: 'sf-1', sessionId: 'sess-1' },
    });
  });

  it('registers nothing when the credential was revoked after the wallet answered', async () => {
    mocks.credentialRow.mockResolvedValue(null);
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(await response.json()).toEqual({ status: 'failed', error: 'credential_not_active' });
    expect(mocks.insertKeyringHolderKey).not.toHaveBeenCalled();
  });

  it('refuses when the factor that approved the enrolment is no longer active', async () => {
    mocks.isActive.mockResolvedValue(false);
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(response.status).toBe(403);
    expect(mocks.insertKeyringHolderKey).not.toHaveBeenCalled();
  });

  it('refuses when the session evidence went stale meanwhile', async () => {
    mocks.auth = human({ secondFactorVerifiedAtMs: NOW - 3_600_000 });
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: 'failed', error: 'step_up_expired' });
    expect(mocks.insertKeyringHolderKey).not.toHaveBeenCalled();
  });

  it('reports a key already registered', async () => {
    mocks.insertKeyringHolderKey.mockResolvedValue({
      inserted: false,
      reason: 'credential_in_use',
    });
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: 'failed', error: 'credential_in_use' });
  });

  it('retires the new factor when the credential was revoked while it was registered', async () => {
    mocks.credentialRow
      .mockResolvedValueOnce({ status: 'active' })
      .mockResolvedValueOnce({ status: 'revoked' });
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(await response.json()).toEqual({ status: 'failed', error: 'credential_not_active' });
    expect(mocks.revokeByAdmin).toHaveBeenCalledWith('admin-1', 'kf-2');
    expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
  });

  it('retires the new factor when the credential cannot be confirmed afterwards (fail closed)', async () => {
    mocks.credentialRow
      .mockResolvedValueOnce({ status: 'active' })
      .mockRejectedValueOnce(new Error('core db down'));
    const response = await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(await response.json()).toEqual({ status: 'failed', error: 'credential_not_active' });
    expect(mocks.revokeByAdmin).toHaveBeenCalledWith('admin-1', 'kf-2');
  });

  it('registers a first factor only as a first enrolment', async () => {
    vc.consumeAdminPresentation.mockResolvedValue({
      purpose: 'enroll',
      context: { mode: 'first', approving_factor_id: null },
      holderJkt: 'N'.repeat(43),
      credentialId: 'cred-2',
      verifiedAt: NOW,
    });
    await call('GET', '/enroll/g1:apac:0:vp_1');
    expect(mocks.insertKeyringHolderKey).toHaveBeenCalledWith(expect.anything(), {
      firstOnly: true,
    });
  });
});

describe('Digital Credentials API mode', () => {
  beforeEach(() => {
    vc.createAdminPresentationRequest.mockResolvedValue({
      requestId: 'g1:apac:0:vp_1',
      dcRequest: { protocol: 'openid4vp-v1-signed', data: { request: 'h.p.s' } },
      expiresAt: NOW + 300_000,
    });
  });

  it('is refused while the platform switch is off, before anything starts', async () => {
    const response = await call('POST', '/step-up', undefined, { mode: 'dc_api' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'keyring_dc_api_disabled' });
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('starts a request bound to the console origin when the switch is on', async () => {
    mocks.settings.mockResolvedValue({ 'security.admin_keyring_dc_api': true });
    const response = await call('POST', '/step-up', undefined, { mode: 'dc_api' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      request_id: 'g1:apac:0:vp_1',
      dc_request: { protocol: 'openid4vp-v1-signed', data: { request: 'h.p.s' } },
      expires_at: NOW + 300_000,
    });
    expect(vc.createAdminPresentationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dc_api', origin: 'https://console.example.com' })
    );
  });

  it('refuses a console origin that is not https, and an unknown mode', async () => {
    mocks.settings.mockResolvedValue({ 'security.admin_keyring_dc_api': true });
    mocks.browserOrigin.mockReturnValue(null);
    expect((await call('POST', '/step-up', undefined, { mode: 'dc_api' })).status).toBe(400);
    expect((await call('POST', '/step-up', undefined, { mode: 'carrier-pigeon' })).status).toBe(
      400
    );
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('asks for the enrolment step-up only after the transport was accepted', async () => {
    const response = await call('POST', '/enroll', undefined, { mode: 'dc_api' });
    expect(response.status).toBe(409);
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('submits the browser answer for this session and records the verified factor', async () => {
    const response = await call('POST', '/step-up/g1:apac:0:vp_1/response', undefined, {
      response: { response: 'jwe' },
    });
    expect(await response.json()).toMatchObject({ status: 'verified' });
    expect(vc.submitAdminPresentationResponse).toHaveBeenCalledWith({
      tenantId: 'home-tenant',
      adminUserId: 'admin-1',
      sessionId: 'sess-1',
      requestId: 'g1:apac:0:vp_1',
      data: { response: 'jwe' },
    });
    expect(mocks.recordSecondFactorVerification).toHaveBeenCalled();
  });

  it('reports a refused, unknown or replayed answer without recording anything', async () => {
    vc.submitAdminPresentationResponse.mockResolvedValueOnce({
      outcome: 'refused',
      error: 'invalid_vp_token',
    });
    expect(
      await (
        await call('POST', '/step-up/g1:apac:0:vp_1/response', undefined, { response: {} })
      ).json()
    ).toEqual({ status: 'failed', error: 'invalid_vp_token' });
    vc.submitAdminPresentationResponse.mockResolvedValueOnce({ outcome: 'unknown' });
    expect(
      (await call('POST', '/step-up/g1:apac:0:vp_1/response', undefined, { response: {} })).status
    ).toBe(404);
    vc.submitAdminPresentationResponse.mockResolvedValueOnce({ outcome: 'replayed' });
    expect(
      (await call('POST', '/step-up/g1:apac:0:vp_1/response', undefined, { response: {} })).status
    ).toBe(409);
    expect((await call('POST', '/step-up/g1:apac:0:vp_1/response', undefined, {})).status).toBe(
      400
    );
    expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
  });
});

describe('recovery with Keyring', () => {
  const recoveryResult = (overrides: Record<string, unknown> = {}) => ({
    purpose: 'enroll',
    context: { mode: 'recovery', approving_factor_id: null },
    holderJkt: JKT,
    credentialId: 'cred-1',
    verifiedAt: NOW,
    ...overrides,
  });

  it('starts an enrolment presentation for a recovery request after the request checks', async () => {
    mocks.listActiveByUser.mockResolvedValue([]);

    const response = await call('POST', '/enroll', undefined, { purpose: 'recovery' });

    expect(response.status).toBe(201);
    expect(mocks.refuseRecoveryRequest).toHaveBeenCalledOnce();
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    expect(vc.createAdminPresentationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'enroll',
        holderJkts: [JKT],
        context: { mode: 'recovery', approving_factor_id: null },
      })
    );
  });

  it('starts nothing when a recovery request may not be filed', async () => {
    mocks.refuseRecoveryRequest.mockResolvedValue(
      Response.json({ error: 'recovery_pending' }, { status: 409 })
    );

    const response = await call('POST', '/enroll', undefined, { purpose: 'recovery' });

    expect(response.status).toBe(409);
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('refuses an unknown purpose or a body that is not an object', async () => {
    expect((await call('POST', '/enroll', undefined, { purpose: 'other' })).status).toBe(400);
    expect((await call('POST', '/enroll', undefined, ['recovery'])).status).toBe(400);
    expect(vc.createAdminPresentationRequest).not.toHaveBeenCalled();
  });

  it('files the presented holder key as the recovery request, registering no factor', async () => {
    vc.consumeAdminPresentation.mockResolvedValue(recoveryResult());

    const response = await call('GET', '/enroll/g1:apac:0:vp_1');

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      status: 'verified',
      recovery: { id: 'rec-1', kind: 'keyring_holder_key' },
    });
    expect(mocks.fileRecoveryRequest.mock.calls[0]?.[2]).toEqual({
      kind: 'keyring_holder_key',
      holder_jkt: JKT,
      admin_credential_id: 'cred-1',
      label: 'Keyring',
    });
    expect(mocks.insertKeyringHolderKey).not.toHaveBeenCalled();
  });

  it('answers a refused filing as a failed presentation, with its status', async () => {
    vc.consumeAdminPresentation.mockResolvedValue(recoveryResult());
    mocks.fileRecoveryRequest.mockResolvedValue(
      Response.json({ error: 'recovery_notification_failed' }, { status: 503 })
    );

    const response = await call('GET', '/enroll/g1:apac:0:vp_1');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'failed',
      error: 'recovery_notification_failed',
    });
  });

  it('files nothing once the fresh passkey went stale, or the credential was revoked', async () => {
    vc.consumeAdminPresentation.mockResolvedValue(recoveryResult());
    mocks.auth = human({ authenticationTimeMs: NOW - 60 * 60_000 });
    expect((await call('GET', '/enroll/g1:apac:0:vp_1')).status).toBe(403);

    mocks.auth = human();
    mocks.credentialRow.mockResolvedValue({ status: 'revoked' });
    expect(await (await call('GET', '/enroll/g1:apac:0:vp_1')).json()).toEqual({
      status: 'failed',
      error: 'credential_not_active',
    });
    expect(mocks.fileRecoveryRequest).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = await vi.hoisted(async () => {
  const m = await import('./helpers/mut-admin-enrollment-fixture');
  return m.createEnrollmentFixture();
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => fx.adapter),
    AdminNoticeRepository: class {
      create = fx.noticeCreate;
    },
  };
});
vi.mock('@simplewebauthn/server', () => fx.webauthn);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', () => ({
  prepareLogIcebergRowWrite: fx.prepareLogIcebergRowWrite,
}));
vi.mock('../session-ttl', () => ({
  resolveSessionTtl: vi.fn(async () => ({ seconds: 3600, milliseconds: 3_600_000 })),
}));

import { adminSessionAuditDigest } from '@authrim/ar-lib-core';
import { adminInvitationEnrollmentApp } from '../admin-invitation-enrollment';
import { base64, sha256Hex, type Statement } from './helpers/mut-admin-enrollment-fixture';

const TOKEN = 'enrollment-token-0003';
const ORIGIN = 'https://admin.example.com';
const baseEnv = { DB_ADMIN: {}, ADMIN_UI_URL: ORIGIN, DEFAULT_TENANT_ID: 'tenant_123' };

const authState = {
  invitationId: 'invitation_1',
  phase: 'authentication',
  clientIp: null,
  authentication: {
    challengeId: 'challenge-9',
    challenge: 'auth-challenge',
    rpID: 'admin.example.com',
    origin: ORIGIN,
    credentialId: 'credential-id',
    publicKey: base64([1, 2, 3]),
    counter: 4,
    transports: ['internal'],
    aaguid: 'aaguid-1',
  },
};

const credential = {
  id: 'credential-id',
  rawId: 'credential-id',
  response: {},
  type: 'public-key',
};

async function activate(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  envOverrides: Record<string, unknown> = {}
) {
  const response = await adminInvitationEnrollmentApp.request(
    '/api/admin/invitations/activate',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        enrollment_token: TOKEN,
        challenge_id: 'challenge-9',
        credential,
        ...body,
      }),
    },
    { ...baseEnv, ...envOverrides }
  );
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie'),
    body: await response.json<Record<string, unknown>>(),
  };
}

function batch(): Statement[] {
  return fx.adapter.batch.mock.calls[0][0];
}
function stmt(fragment: string): Statement {
  const found = batch().find((s) => s.sql.includes(fragment));
  if (!found) throw new Error(`no statement with ${fragment}`);
  return found;
}

beforeEach(async () => {
  vi.clearAllMocks();
  fx.reset();
  await fx.seed(TOKEN, authState);
  fx.webauthn.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 5 },
  });
});

describe('activation guards', () => {
  it('rejects a malformed token', async () => {
    expect((await activate({ enrollment_token: 7 })).body).toEqual({ error: 'invalid_enrollment' });
  });

  it.each([
    ['a registration-phase enrollment', { ...authState, phase: 'registration' }],
    ['an authentication phase without state', { ...authState, authentication: undefined }],
  ])('rejects %s', async (_label, state) => {
    await fx.seed(TOKEN, state);
    expect(await activate()).toMatchObject({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it.each([
    ['stored transports that are not strings', { ...authState.authentication, transports: [1] }],
    ['a non-array transports value', { ...authState.authentication, transports: 'usb' }],
    ['a numeric aaguid', { ...authState.authentication, aaguid: 3 }],
    ['a string counter', { ...authState.authentication, counter: '4' }],
    ['a missing public key', { ...authState.authentication, publicKey: undefined }],
    ['a missing credential id', { ...authState.authentication, credentialId: undefined }],
    ['a malformed common part', { ...authState.authentication, rpID: undefined }],
  ])('treats corrupted state with %s as no enrollment', async (_label, authentication) => {
    await fx.seed(TOKEN, { ...authState, authentication });
    expect(await activate()).toMatchObject({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it.each([
    ['a missing challenge id', { challenge_id: '' }],
    ['another challenge id', { challenge_id: 'challenge-8' }],
    ['a credential without response', { credential: { id: 'credential-id' } }],
    ['a credential with an empty id', { credential: { id: '', response: {} } }],
    ['a different credential', { credential: { ...credential, id: 'other-credential' } }],
  ])('rejects %s with invalid_request', async (_label, body) => {
    expect(await activate(body)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(fx.webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('accepts a credential id given in standard base64 form', async () => {
    await fx.seed(TOKEN, {
      ...authState,
      authentication: { ...authState.authentication, credentialId: 'ab-_c' },
    });
    const result = await activate({ credential: { ...credential, id: 'ab+/c==' } });
    expect(result.status).toBe(200);
  });

  it('re-checks the invitation', async () => {
    fx.state.invitation = { ...fx.state.invitation, role_expires_at: Date.now() - 5 };
    expect(await activate()).toMatchObject({ body: { error: 'invitation_role_expired' } });
  });

  it.each([
    ['throws', () => fx.webauthn.verifyAuthenticationResponse.mockRejectedValue(new Error('x'))],
    [
      'is unverified',
      () => fx.webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: false }),
    ],
    ['uses a step-up second factor', () => fx.secondFactors.add('credential-id')],
  ])('fails passkey authentication when verification %s', async (_label, arrange) => {
    arrange();
    const result = await activate();
    expect(result).toMatchObject({ status: 401, body: { error: 'passkey_authentication_failed' } });
    expect(result.cookie).toBeNull();
    expect(fx.adapter.batch).not.toHaveBeenCalled();
  });

  it('verifies the assertion against the stored credential and challenge', async () => {
    await activate();
    const args = fx.webauthn.verifyAuthenticationResponse.mock.calls[0][0];
    expect(args).toMatchObject({
      response: credential,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: 'admin.example.com',
      requireUserVerification: true,
      credential: { id: 'credential-id', counter: 4 },
    });
    expect(Array.from(args.credential?.publicKey ?? [])).toEqual([1, 2, 3]);
  });

  it('refuses a global invitation homed outside the default tenant', async () => {
    fx.state.invitation = { ...fx.state.invitation, scope_type: 'global' };
    const result = await activate({}, {}, { DEFAULT_TENANT_ID: 'default' });
    expect(result).toMatchObject({
      status: 409,
      body: { error: 'cross_tenant_admin_requires_default_home' },
    });
    expect(fx.adapter.batch).not.toHaveBeenCalled();
  });

  it('allows a global invitation homed in the default tenant', async () => {
    fx.state.invitation = { ...fx.state.invitation, scope_type: 'global' };
    expect((await activate()).status).toBe(200);
  });

  it('reports a conflicting batch without a session cookie', async () => {
    fx.adapter.batch.mockRejectedValueOnce(new Error('constraint'));
    const result = await activate();
    expect(result).toMatchObject({
      status: 409,
      body: { error: 'invitation_activation_conflict' },
    });
    expect(result.cookie).toBeNull();
    expect(fx.auditDispatch).not.toHaveBeenCalled();
  });
});

describe('activation batch', () => {
  it('writes the admin, passkey, role, session and invitation atomically', async () => {
    const before = Date.now();
    const result = await activate({}, { 'cf-connecting-ip': '198.51.100.4', 'user-agent': 'UA/1' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      success: true,
      user: {
        id: 'admin_new',
        email: 'new-admin@example.com',
        name: 'New Admin',
        role: 'Administrator',
      },
    });
    const tokenHash = await sha256Hex(TOKEN);

    const user = stmt('INSERT INTO admin_users');
    expect(user.params![1]).toBe('198.51.100.4');
    expect(user.params![4]).toBe('invitation_1');
    expect(user.params![7]).toBe(tokenHash);
    expect(Number(user.params![0])).toBeGreaterThanOrEqual(before);

    const passkey = stmt('INSERT INTO admin_passkeys');
    expect(passkey.params!.slice(1, 8)).toEqual([
      'admin_new',
      'credential-id',
      authState.authentication.publicKey,
      5,
      'Admin invitation Passkey',
      '["internal"]',
      'aaguid-1',
    ]);

    expect(stmt('INSERT INTO admin_role_assignments').params![2]).toBe('invitation_1');
    expect(batch().some((s) => s.sql.includes('invitation-conflict'))).toBe(false);
    expect(stmt("SELECT 'invitation:'").params![1]).toBe('invitation_1');

    const session = stmt('INSERT INTO admin_sessions');
    const sessionId = String(session.params![0]);
    expect(session.params!.slice(1, 5)).toEqual([
      'tenant_123',
      'admin_new',
      '198.51.100.4',
      'UA/1',
    ]);
    expect(Number(session.params![6]) - Number(session.params![5])).toBe(3_600_000);
    expect(session.params![10]).toBe('credential-id');

    const accepted = stmt("SET status = 'accepted'");
    expect(accepted.params!.slice(1)).toEqual([
      '198.51.100.4',
      accepted.params![2],
      'invitation_1',
    ]);
    expect(batch().some((s) => s.sql === 'AUDIT_STATEMENT')).toBe(true);
    expect(stmt('DELETE FROM admin_invitation_enrollments').params![0]).toBe(tokenHash);

    expect(result.cookie).toContain(`authrim_admin_session=${sessionId}`);
    expect(result.cookie).toMatch(/Max-Age=3600/);
    expect(result.cookie).toMatch(/HttpOnly/);
    expect(result.cookie).toMatch(/Secure/);
    expect(result.cookie).toMatch(/SameSite=Lax/);
    expect(result.cookie).toMatch(/Path=\//);

    const audit = fx.auditRows[0];
    expect(audit).toMatchObject({
      tenant_id: 'tenant_123',
      admin_user_id: 'admin_new',
      admin_email: 'new-admin@example.com',
      action: 'admin_invitation.accept',
      resource_type: 'admin_user',
      resource_id: 'admin_new',
      result: 'success',
      severity: 'critical',
      ip_address: '198.51.100.4',
      user_agent: 'UA/1',
      session_id: await adminSessionAuditDigest(sessionId),
    });
    expect(JSON.parse(String(audit.metadata_json))).toEqual({
      invitation_id: 'invitation_1',
      role_id: 'role_ar_tenant_admin',
      scope_type: 'tenant',
      ip_restriction_enabled: false,
      code_delivery: 'email',
    });
    const input = fx.prepareLogIcebergRowWrite.mock.calls[0][2] as unknown as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      tenantId: 'tenant_123',
      sourceDataset: 'admin.admin_audit_log',
      logType: 'admin_audit',
      expiresAt: null,
      overview: {
        action: 'admin_invitation.accept',
        result: 'success',
        severity: 'critical',
        subject_id: 'admin_new',
        resource_id: 'admin_new',
      },
    });
    expect(fx.auditDispatch).toHaveBeenCalledTimes(1);
    expect(fx.noticeCreate).not.toHaveBeenCalled();
  });

  it('records group outcomes and guards the joined groups against later changes', async () => {
    fx.state.invitation = {
      ...fx.state.invitation,
      code_delivery: 'response',
      role_display_name: '',
    };
    fx.state.namedGroups = [
      { admin_group_id: 'g1', group_display_name: 'Ops', group_revision: 2, current_revision: 2 },
      { admin_group_id: 'g2', group_display_name: 'Sec', group_revision: 1, current_revision: 3 },
      {
        admin_group_id: 'g3',
        group_display_name: 'Old',
        group_revision: 1,
        current_revision: null,
      },
      { admin_group_id: 'g4', group_display_name: 'Str', group_revision: '5', current_revision: 5 },
    ];
    fx.state.missedGroups = [
      { admin_group_id: 'g2', display_name: 'Sec' },
      { admin_group_id: 'g3', display_name: 'Old' },
    ];
    const result = await activate();
    expect(result.body.user).toMatchObject({ role: 'admin' });
    const metadata = JSON.parse(String(fx.auditRows[0].metadata_json)) as Record<string, unknown>;
    expect(metadata.code_delivery).toBe('response');
    expect(metadata.admin_groups).toEqual([
      { admin_group_id: 'g1', name: 'Ops', outcome: 'joined' },
      { admin_group_id: 'g2', name: 'Sec', outcome: 'not_joined_changed' },
      { admin_group_id: 'g3', name: 'Old', outcome: 'not_joined_deleted' },
      { admin_group_id: 'g4', name: 'Str', outcome: 'joined' },
    ]);
    expect(stmt('invitation-conflict').params).toEqual(['invitation_1', 'g1', 'g4']);

    expect(fx.noticeCreate).toHaveBeenCalledWith({
      scope_type: 'tenant',
      tenant_id: 'tenant_123',
      severity: 'caution',
      source: 'system',
      category: 'admin_group',
      message_key: 'admin_group_invitation_not_joined',
      params: { email: 'new-admin@example.com', groups: 'Sec, Old' },
      title:
        'new-admin@example.com was not added to Sec, Old: the group changed after the invitation',
      link: '/admin/settings/team-groups',
      required_permission: 'admin:admin_users:read',
      source_ref: 'invitation_1',
      deduplication_key: 'admin-group-invitation:invitation_1',
    });
    const missedQuery = fx.adapter.query.mock.calls.find(([sql]) =>
      String(sql).includes('m.id IS NULL')
    );
    expect(missedQuery?.[1]).toEqual(['admin_new', 'invitation_1']);
  });

  it('still succeeds when audit dispatch or the notice fails', async () => {
    fx.auditDispatch.mockRejectedValueOnce(new Error('queue down'));
    fx.state.missedGroups = [{ admin_group_id: 'g2', display_name: 'Sec' }];
    fx.noticeCreate.mockRejectedValueOnce(new Error('db down'));
    const result = await activate({}, {}, { ADMIN_COOKIE_SAME_SITE: 'Strict' });
    expect(result.status).toBe(200);
    expect(result.cookie).toMatch(/SameSite=Strict/);
  });

  it('records a null user agent and client IP when absent', async () => {
    await activate();
    const session = stmt('INSERT INTO admin_sessions');
    expect(session.params![3]).toBeNull();
    expect(session.params![4]).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

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

import { adminInvitationEnrollmentApp } from '../admin-invitation-enrollment';
import { sha256Hex } from './helpers/mut-admin-enrollment-fixture';

const CODE = '2345-6789-ABCD-EFGH';
const TOKEN = 'enrollment-token-0001';
const ORIGIN = 'https://admin.example.com';

function env(overrides: Record<string, unknown> = {}): Env {
  return { DB_ADMIN: {}, ADMIN_UI_URL: ORIGIN, ...overrides } as unknown as Env;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}, e = env()) {
  const response = await adminInvitationEnrollmentApp.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    e
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const redeem = (body: unknown, headers?: Record<string, string>, e?: Env) =>
  post('/api/admin/invitations/redeem', body, headers, e);
const options = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  post('/api/admin/invitations/passkey/options', body, headers);

beforeEach(() => {
  vi.clearAllMocks();
  fx.reset();
  fx.webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' });
});

describe('redeem', () => {
  it('refuses with server_error when the admin database is not bound', async () => {
    const result = await redeem(
      { email: 'a@example.com', code: CODE },
      {},
      env({ DB_ADMIN: undefined })
    );
    expect(result).toEqual({ status: 500, body: { error: 'server_error' } });
    expect(fx.adapter.queryOne).not.toHaveBeenCalled();
  });

  it.each([
    ['missing email', { code: CODE }],
    ['non-string email', { email: 42, code: CODE }],
    ['blank email', { email: '   ', code: CODE }],
    ['overlong email', { email: `${'a'.repeat(310)}@example.com`, code: CODE }],
    ['missing code', { email: 'new-admin@example.com' }],
    ['malformed code', { email: 'new-admin@example.com', code: 'not-a-code' }],
    ['overlong code', { email: 'new-admin@example.com', code: `${CODE}${'-'.repeat(60)}` }],
  ])('rejects %s before any lookup', async (_label, body) => {
    const result = await redeem(body);
    expect(result).toEqual({ status: 401, body: { error: 'invalid_invitation' } });
    expect(fx.adapter.queryOne).not.toHaveBeenCalled();
  });

  it('looks up the invitation by normalised email and hashed code', async () => {
    await redeem({ email: '  New-Admin@Example.COM ', code: ` ${CODE.toLowerCase()} ` });
    const [sql, params] = fx.adapter.queryOne.mock.calls[0];
    expect(sql).toContain("i.status = 'pending'");
    expect(params![0]).toBe('new-admin@example.com');
    expect(params![1]).toBe(await sha256Hex(CODE.replace(/-/g, '')));
  });

  it('rejects an unknown code with invalid_invitation', async () => {
    fx.state.invitation = null;
    const result = await redeem({ email: 'new-admin@example.com', code: CODE });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_invitation' } });
    expect(fx.enrollments.size).toBe(0);
  });

  it('rejects an invitation that is no longer pending', async () => {
    fx.state.invitation = { ...fx.state.invitation, status: 'accepted' };
    const result = await redeem({ email: 'new-admin@example.com', code: CODE });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_invitation' } });
  });

  it('expires an outdated invitation and releases its pending e-mail key', async () => {
    fx.state.invitation = { ...fx.state.invitation, expires_at: Date.now() - 1 };
    const result = await redeem({ email: 'new-admin@example.com', code: CODE });
    expect(result).toEqual({ status: 401, body: { error: 'invitation_expired' } });
    const update = fx.adapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'expired'")
    );
    expect(update?.[0]).toContain('pending_email_key = NULL');
    expect(update?.[1]?.[1]).toBe('invitation_1');
    expect(fx.enrollments.size).toBe(0);
  });

  it('rejects an invitation whose role has already expired', async () => {
    fx.state.invitation = { ...fx.state.invitation, role_expires_at: Date.now() - 1 };
    const result = await redeem({ email: 'new-admin@example.com', code: CODE });
    expect(result).toEqual({ status: 401, body: { error: 'invitation_role_expired' } });
  });

  it('accepts an invitation whose role expires in the future', async () => {
    fx.state.invitation = { ...fx.state.invitation, role_expires_at: Date.now() + 60_000 };
    const result = await redeem({ email: 'new-admin@example.com', code: CODE });
    expect(result.status).toBe(200);
  });

  it('requires a client IP when the invitation is IP restricted', async () => {
    fx.state.invitation = {
      ...fx.state.invitation,
      ip_restriction_enabled: 1,
      allowed_ip_ranges_json: JSON.stringify(['203.0.113.0/24']),
    };
    const result = await redeem({ email: 'new-admin@example.com', code: CODE });
    expect(result).toEqual({ status: 403, body: { error: 'ip_not_allowed' } });
  });

  it.each([['not json'], ['{"a":1}'], ['[1, 2]']])(
    'treats unusable stored IP ranges %s as allowing nothing',
    async (raw) => {
      fx.state.invitation = {
        ...fx.state.invitation,
        ip_restriction_enabled: 1,
        allowed_ip_ranges_json: raw,
      };
      const result = await redeem(
        { email: 'new-admin@example.com', code: CODE },
        { 'cf-connecting-ip': '203.0.113.5' }
      );
      expect(result).toEqual({ status: 403, body: { error: 'ip_not_allowed' } });
    }
  );

  it('issues a ten-minute enrollment bound to the invitation and client IP', async () => {
    fx.state.invitation = {
      ...fx.state.invitation,
      ip_restriction_enabled: 1,
      allowed_ip_ranges_json: JSON.stringify([7, '203.0.113.0/24']),
      role_display_name: null,
    };
    const before = Date.now();
    const result = await redeem(
      { email: 'new-admin@example.com', code: CODE },
      { 'cf-connecting-ip': '203.0.113.5' }
    );
    expect(result.status).toBe(200);
    expect(result.body.expires_in).toBe(600);
    expect(result.body.invitation).toEqual({
      email: 'new-admin@example.com',
      name: 'New Admin',
      role: 'admin',
      ip_restriction_enabled: true,
    });
    const token = String(result.body.enrollment_token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = fx.enrollments.get(await sha256Hex(token));
    expect(stored?.invitation_id).toBe('invitation_1');
    expect(stored?.phase).toBe('redeemed');
    expect(JSON.parse(stored!.state_json)).toEqual({
      invitationId: 'invitation_1',
      phase: 'redeemed',
      clientIp: '203.0.113.5',
    });
    expect(stored!.expires_at).toBeGreaterThanOrEqual(before + 600_000);
    expect(stored!.expires_at).toBeLessThanOrEqual(Date.now() + 600_000);
    const cleanup = fx.adapter.execute.mock.calls.find(([sql]) =>
      String(sql).startsWith('DELETE FROM admin_invitation_enrollments')
    );
    expect(cleanup).toBeDefined();
  });

  it('reports the display role and no IP restriction when unrestricted', async () => {
    const result = await redeem({ email: 'new-admin@example.com', code: CODE });
    expect(result.body.invitation).toMatchObject({
      role: 'Administrator',
      ip_restriction_enabled: false,
    });
    const stored = [...fx.enrollments.values()][0];
    expect((JSON.parse(stored.state_json) as { clientIp: unknown }).clientIp).toBeNull();
  });
});

describe('passkey options', () => {
  it.each([
    ['missing token', {}],
    ['short token', { enrollment_token: 'short-token' }],
    ['token with invalid characters', { enrollment_token: 'enrollment.token.0001' }],
    ['overlong token', { enrollment_token: 'a'.repeat(129) }],
  ])('rejects %s', async (_label, body) => {
    const result = await options(body);
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
    expect(fx.adapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects an unknown enrollment token', async () => {
    const result = await options({ enrollment_token: TOKEN, rp_id: 'admin.example.com' });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it('rejects an enrollment that already reached authentication', async () => {
    await fx.seed(TOKEN, { invitationId: 'invitation_1', phase: 'authentication', clientIp: null });
    const result = await options({ enrollment_token: TOKEN, rp_id: 'admin.example.com' });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it('re-checks the invitation for a redeemed enrollment', async () => {
    await fx.seed(TOKEN, { invitationId: 'invitation_1', phase: 'redeemed', clientIp: null });
    fx.state.invitation = { ...fx.state.invitation, status: 'revoked' };
    const result = await options({ enrollment_token: TOKEN, rp_id: 'admin.example.com' });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_invitation' } });
  });

  it.each([
    ['no origin header', {}, 'admin.example.com'],
    ['a foreign origin', { origin: 'https://evil.example.net' }, 'admin.example.com'],
    ['a mismatched rp_id', { origin: ORIGIN }, 'example.org'],
    ['a missing rp_id', { origin: ORIGIN }, undefined],
    ['an overlong rp_id', { origin: ORIGIN }, `${'a'.repeat(250)}.com`],
  ])('rejects %s with invalid_origin', async (_label, headers, rpId) => {
    await fx.seed(TOKEN, { invitationId: 'invitation_1', phase: 'redeemed', clientIp: null });
    const result = await options({ enrollment_token: TOKEN, rp_id: rpId }, headers);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_origin' } });
    expect(fx.webauthn.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('builds resident registration options and stores the challenge', async () => {
    fx.state.invitation = { ...fx.state.invitation, name: null };
    await fx.seed(TOKEN, {
      invitationId: 'invitation_1',
      phase: 'redeemed',
      clientIp: '198.51.100.1',
    });
    const result = await options({ enrollment_token: TOKEN, rp_id: 'admin.example.com' });
    expect(result.status).toBe(200);
    expect(result.body.options).toEqual({ challenge: 'reg-challenge' });
    const args = fx.webauthn.generateRegistrationOptions.mock.calls[0][0];
    expect(args).toMatchObject({
      rpName: 'Authrim Admin',
      rpID: 'admin.example.com',
      userName: 'new-admin@example.com',
      userDisplayName: 'new-admin@example.com',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 60_000,
    });
    expect(new TextDecoder().decode(args.userID)).toBe('admin_new');
    const stored = fx.enrollments.get(await sha256Hex(TOKEN))!;
    expect(stored.phase).toBe('registration');
    expect(JSON.parse(stored.state_json)).toEqual({
      invitationId: 'invitation_1',
      phase: 'registration',
      clientIp: '198.51.100.1',
      registration: {
        challengeId: result.body.challenge_id,
        challenge: 'reg-challenge',
        rpID: 'admin.example.com',
        origin: ORIGIN,
      },
    });
  });

  it('uses the invitee name as display name and the forwarded origin behind the BFF', async () => {
    await fx.seed(TOKEN, { invitationId: 'invitation_1', phase: 'registration', clientIp: null });
    const result = await options(
      { enrollment_token: TOKEN, rp_id: 'admin.example.com' },
      {
        origin: 'https://bff.internal.example',
        'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
        'X-Authrim-Forwarded-Origin': ORIGIN,
      }
    );
    expect(result.status).toBe(200);
    expect(fx.webauthn.generateRegistrationOptions.mock.calls[0][0].userDisplayName).toBe(
      'New Admin'
    );
  });

  it('refuses when the enrollment moved on concurrently', async () => {
    await fx.seed(TOKEN, { invitationId: 'invitation_1', phase: 'redeemed', clientIp: null });
    fx.state.updateRowsAffected = 0;
    const result = await options({ enrollment_token: TOKEN, rp_id: 'admin.example.com' });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it.each([
    ['not json', 'not json'],
    ['an array', '[]'],
    ['a missing invitation id', JSON.stringify({ phase: 'redeemed', clientIp: null })],
    ['an unknown phase', JSON.stringify({ invitationId: 'i', phase: 'done', clientIp: null })],
    ['a numeric client IP', JSON.stringify({ invitationId: 'i', phase: 'redeemed', clientIp: 1 })],
    [
      'a malformed registration',
      JSON.stringify({ invitationId: 'i', phase: 'redeemed', clientIp: null, registration: 'x' }),
    ],
    [
      'a registration missing its origin',
      JSON.stringify({
        invitationId: 'i',
        phase: 'redeemed',
        clientIp: null,
        registration: { challengeId: 'c', challenge: 'c', rpID: 'r' },
      }),
    ],
  ])('treats stored state with %s as no enrollment', async (_label, raw) => {
    await fx.seedRaw(TOKEN, raw);
    const result = await options({ enrollment_token: TOKEN, rp_id: 'admin.example.com' });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
  });
});

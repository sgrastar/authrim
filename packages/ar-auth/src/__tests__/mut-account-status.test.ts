import { describe, expect, it, vi } from 'vitest';
import {
  accountProvisioningStatusHandler,
  resolveAccountProvisioningResume,
  resolvePasskeyProvisioningResumeUserId,
} from '../account-provisioning';
import {
  OPERATION_ID,
  TENANT_ID,
  TOKEN,
  accountContext,
  resumeChallenge,
  resumeMetadata,
  sha256HexOf,
} from './helpers/mut-account-context';

async function poll(options: Parameters<typeof accountContext>[0] = {}) {
  const ctx = accountContext({ body: { provisioning_token: TOKEN }, ...options });
  const response = await accountProvisioningStatusHandler(ctx.c);
  return { ...ctx, response, body: await response.json<Record<string, unknown>>() };
}

const withChallenge = async (overrides: Record<string, unknown> = {}) =>
  vi.fn().mockResolvedValue(await resumeChallenge(overrides));

describe('account provisioning status request validation', () => {
  it.each([
    ['a null body', null],
    ['a string body', 'token'],
    ['an empty object', {}],
    ['an extra key', { provisioning_token: TOKEN, extra: 1 }],
    ['a non-string token', { provisioning_token: 42 }],
    ['a short token', { provisioning_token: 'A'.repeat(42) }],
    ['a token with a bad character', { provisioning_token: `${'A'.repeat(42)}+` }],
  ])('answers %s with invalid_request before any lookup', async (_label, body) => {
    const { response, body: answer, challenge } = await poll({ body });
    expect(response.status).toBe(400);
    expect(answer).toEqual({ error: 'invalid_request' });
    expect(challenge.getChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers an unreadable body as unavailable', async () => {
    const { response, body } = await poll({ bodyError: new Error('bad json') });
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'account_provisioning_status_unavailable' });
  });

  it('answers a valid token without a provisioner as invalid_or_expired', async () => {
    const { response, body } = await poll({
      withoutProvisioner: true,
      getChallenge: await withChallenge(),
    });
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_or_expired_provisioning_token' });
  });
});

describe('account provisioning resume challenge binding', () => {
  it('looks the challenge up by the token hash', async () => {
    const getChallenge = await withChallenge();
    await poll({ getChallenge });
    expect(getChallenge).toHaveBeenCalledWith(`account_provisioning:${await sha256HexOf(TOKEN)}`);
  });

  it.each([
    ['a missing challenge', null],
    ['another challenge type', { type: 'email_code' }],
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another user', { userId: 'user-b' }],
    ['another token hash', { challenge: 'f'.repeat(64) }],
    ['a consumed challenge', { consumed: true }],
  ])('refuses %s', async (_label, overrides) => {
    const getChallenge =
      overrides === null ? vi.fn().mockResolvedValue(null) : await withChallenge(overrides);
    const { response, body, provisioner } = await poll({ getChallenge });
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_or_expired_provisioning_token' });
    expect(provisioner.getAuthAccountProvisioningStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['no metadata', undefined],
    ['null metadata', null],
    ['array metadata', [resumeMetadata()]],
    ['string metadata', 'metadata'],
    ['another schema version', resumeMetadata({ schema_version: 2 })],
    ['a non-string operation id', resumeMetadata({ operation_id: 7 })],
    ['an unsafe operation id', resumeMetadata({ operation_id: '-starts-with-dash' })],
    ['a non-string flow', resumeMetadata({ flow: 1 })],
    ['an unknown flow', resumeMetadata({ flow: 'magic_link' })],
    ['an account id of another user', resumeMetadata({ account_id: 'account:user-b' })],
    ['an extra field', { ...resumeMetadata(), extra: true }],
    ['a missing field', { schema_version: 1, operation_id: OPERATION_ID, flow: 'email_code' }],
  ])('refuses %s', async (_label, metadata) => {
    const { response, provisioner } = await poll({
      getChallenge: await withChallenge({ metadata }),
    });
    expect(response.status).toBe(400);
    expect(provisioner.getAuthAccountProvisioningStatus).not.toHaveBeenCalled();
  });

  it.each([
    'email_code',
    'passkey',
    'totp',
    'directory_password',
    'external_idp',
    'saml',
    'did',
    'test_stub',
    'guest',
    'guest_upgrade',
  ])('accepts the %s flow and asks the provisioner for it', async (flow) => {
    const { response, provisioner } = await poll({
      getChallenge: await withChallenge({ metadata: resumeMetadata({ flow }) }),
    });
    expect(response.status).toBe(200);
    expect(provisioner.getAuthAccountProvisioningStatus).toHaveBeenCalledWith({
      schemaVersion: 1,
      tenantId: TENANT_ID,
      operationId: OPERATION_ID,
      flow,
    });
  });
});

describe('account provisioning status answers', () => {
  it.each([
    ['operation', { operationId: 'account-create-other' }],
    ['account', { accountId: 'account:user-b' }],
    ['user', { userId: 'user-b' }],
  ])('fails closed when the provisioner reports another %s', async (_label, overrides) => {
    const status = vi.fn().mockResolvedValue({
      status: 'ready',
      operationId: OPERATION_ID,
      accountId: 'account:user-a',
      userId: 'user-a',
      ...overrides,
    });
    const { response, body } = await poll({ getChallenge: await withChallenge(), status });
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'account_provisioning_state_invalid' });
  });

  it.each([
    ['failed', 'email_code', 409, { status: 'failed' }],
    ['pending', 'email_code', 200, { status: 'pending', retry_after_ms: 500 }],
    ['pending', 'guest', 200, { status: 'pending', retry_after_ms: 500 }],
    ['ready', 'guest', 200, { status: 'ready', restart_required: true }],
    ['ready', 'passkey', 200, { status: 'ready' }],
  ])('answers a %s %s operation', async (state, flow, httpStatus, expected) => {
    const status = vi.fn().mockResolvedValue({
      status: state,
      operationId: OPERATION_ID,
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    const { response, body } = await poll({
      getChallenge: await withChallenge({ metadata: resumeMetadata({ flow }) }),
      status,
    });
    expect(response.status).toBe(httpStatus);
    expect(body).toEqual(expected);
  });

  it('answers a provisioner failure as unavailable', async () => {
    const status = vi.fn().mockRejectedValue(new Error('rpc down'));
    const { response, body } = await poll({ getChallenge: await withChallenge(), status });
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'account_provisioning_status_unavailable' });
  });
});

describe('passkey resume user id', () => {
  const resolve = async (resumeUserId: unknown, flow = 'passkey', token: unknown = TOKEN) => {
    const getChallenge = await withChallenge({ metadata: resumeMetadata({ flow }) });
    const { c } = accountContext({ getChallenge });
    return {
      result: await resolvePasskeyProvisioningResumeUserId(c, token, resumeUserId),
      getChallenge,
    };
  };

  it('returns the user of a passkey resume that names it', async () => {
    expect((await resolve('user-a')).result).toBe('user-a');
  });

  it.each([undefined, 42, '', '   '])(
    'ignores the resume user id %j without a lookup',
    async (id) => {
      const { result, getChallenge } = await resolve(id);
      expect(result).toBeNull();
      expect(getChallenge).not.toHaveBeenCalled();
    }
  );

  it('refuses another user or a non-passkey flow', async () => {
    expect((await resolve('user-b')).result).toBeNull();
    expect((await resolve('user-a', 'email_code')).result).toBeNull();
  });

  it('refuses a token that is not a resume token without a lookup', async () => {
    const { result, getChallenge } = await resolve('user-a', 'passkey', 123);
    expect(result).toBeNull();
    expect(getChallenge).not.toHaveBeenCalled();
  });

  it('returns the full metadata of a valid resume', async () => {
    const { c } = accountContext({ getChallenge: await withChallenge() });
    await expect(resolveAccountProvisioningResume(c, TOKEN)).resolves.toEqual(resumeMetadata());
  });
});

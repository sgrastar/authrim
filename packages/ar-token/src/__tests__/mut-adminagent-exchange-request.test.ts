/**
 * Mode B token exchange: request shape, actor, delegation verification, binding and one-time
 * consumption (src/admin-agent-token.ts handleAdminAgentModeBExchange).
 */
import {
  ACCESS_TYPE,
  BASE,
  callArg,
  delegationPayload,
  exchangeForm,
  expectError,
  ISSUER,
  machineActorPayload,
  mocks,
  modeBGrant,
  post,
  resetDefaults,
  routeVerifyToken,
  TOKEN_URL,
} from './helpers/mut-adminagent-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const INVALID = 'Mode B token exchange request is invalid';
const BINDING = 'Agent delegation binding is invalid';
const exchange = (form: Record<string, string> = exchangeForm()) =>
  post('token', form, { dpop: 'dpop-proof' });

describe('Mode B token exchange: request and delegation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
    mocks.getGrant.mockResolvedValue(modeBGrant());
    routeVerifyToken(machineActorPayload(), delegationPayload({ exp: NOW / 1000 + 300 }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['an unsupported parameter', exchangeForm({ code: 'x' })],
    ['no subject token', exchangeForm({ subject_token: '' })],
    ['an access token as subject', exchangeForm({ subject_token_type: ACCESS_TYPE })],
    ['no actor token', exchangeForm({ actor_token: '' })],
    ['a delegation token as actor', exchangeForm({ actor_token_type: 'urn:other' })],
    ['an unsupported requested token type', exchangeForm({ requested_token_type: 'urn:other' })],
  ])('rejects %s before authenticating the actor', async (_name, form) => {
    await expectError(await exchange(form), 400, 'invalid_request', INVALID);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it('accepts an explicit access token requested type and an omitted client_id', async () => {
    const { client_id: _omit, ...form } = exchangeForm({ requested_token_type: ACCESS_TYPE });
    expect((await exchange(form)).status).toBe(200);
  });

  it('rejects an invalid actor and a client_id that is not the actor client', async () => {
    routeVerifyToken(null, delegationPayload());
    await expectError(
      await exchange(),
      401,
      'invalid_actor_token',
      'Machine actor validation failed'
    );

    routeVerifyToken(machineActorPayload(), delegationPayload());
    await expectError(
      await exchange(exchangeForm({ client_id: 'other-client' })),
      401,
      'invalid_actor_token',
      'Machine actor validation failed'
    );
    expect(mocks.consumeModeBDelegationJti).not.toHaveBeenCalled();
  });

  it('requires this MCP resource', async () => {
    const { resource: _omit, ...form } = exchangeForm();
    await expectError(
      await exchange(form),
      400,
      'invalid_target',
      'resource must identify this MCP endpoint'
    );
    await expectError(
      await exchange(exchangeForm({ resource: 'https://other.example/mcp' })),
      400,
      'invalid_target'
    );
  });

  it('verifies the delegation token against the Admin Agent issuer and token audience', async () => {
    mocks.buildRequestIssuerUrl.mockReturnValue(`${BASE}/`);
    expect((await exchange()).status).toBe(200);
    expect(mocks.verifyToken).toHaveBeenCalledWith('delegation-token', {}, ISSUER, {
      audience: TOKEN_URL,
    });
  });

  it.each([
    [
      'a header without kid',
      () =>
        mocks.parseTokenHeader.mockImplementation((t: string) =>
          t === 'machine-token' ? { kid: 'kid-1' } : {}
        ),
    ],
    [
      'an unknown key',
      () => {
        mocks.parseTokenHeader.mockImplementation((t: string) => ({
          kid: t === 'machine-token' ? 'kid-1' : 'kid-x',
        }));
        mocks.getPublicKeyByKid.mockImplementation(async (_e: unknown, _t: string, kid: string) =>
          kid === 'kid-1' ? {} : null
        );
      },
    ],
    ['a failed verification', () => routeVerifyToken(machineActorPayload(), null)],
  ])('rejects a delegation token with %s', async (_name, arrange) => {
    arrange();
    await expectError(await exchange(), 400, 'invalid_grant', 'Agent delegation token is invalid');
    expect(mocks.consumeModeBDelegationJti).not.toHaveBeenCalled();
  });

  it.each([
    ['another token use', { token_use: 'access' }],
    ['another tenant', { tenant_id: 'tenant-2' }],
    ['another client', { client_id: 'other-client' }],
    ['another resource', { resource: 'https://other.example/mcp' }],
    ['another permitted actor', { may_act: { sub: 'machine:amp-2' } }],
    ['no may_act', { may_act: 'machine:amp-1' }],
    ['another proof key', { cnf: { jkt: 'other-jkt' } }],
    ['no confirmation', { cnf: undefined }],
    ['a non-string subject', { sub: 7 }],
    ['a non-admin subject', { sub: 'user:admin-1' }],
    ['no Grant id', { grant_id: 5 }],
    ['no jti', { jti: undefined }],
  ])('rejects a delegation with %s', async (_name, overrides) => {
    routeVerifyToken(machineActorPayload(), delegationPayload(overrides));
    await expectError(await exchange(), 400, 'invalid_grant', BINDING);
    expect(mocks.consumeModeBDelegationJti).not.toHaveBeenCalled();
  });

  it('consumes the delegation jti exactly once with its expiry', async () => {
    expect((await exchange()).status).toBe(200);
    expect(mocks.consumeModeBDelegationJti).toHaveBeenCalledWith({
      jti: 'adj-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      machinePrincipalId: 'amp-1',
      expiresAt: NOW + 300_000,
      consumedAt: NOW,
    });
  });

  it('records a zero expiry for a delegation without a numeric exp', async () => {
    routeVerifyToken(machineActorPayload(), delegationPayload({ exp: '1' }));
    await exchange();
    expect(callArg(mocks.consumeModeBDelegationJti, 0).expiresAt).toBe(0);
  });

  it('rejects a replayed delegation', async () => {
    mocks.consumeModeBDelegationJti.mockResolvedValue(false);
    await expectError(await exchange(), 400, 'invalid_grant', 'Agent delegation replay detected');
    expect(mocks.getGrant).not.toHaveBeenCalled();
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });
});

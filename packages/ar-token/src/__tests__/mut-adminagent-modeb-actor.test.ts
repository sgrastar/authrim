/**
 * Mode B machine actor authentication (src/admin-agent-token.ts authenticateModeBActor and
 * dpopAuthorization), driven through the JIT delegation endpoint.
 */
import {
  anything,
  BASE,
  expectError,
  machineActorPayload,
  machineLimit,
  mocks,
  modeBGrant,
  post,
  resetDefaults,
} from './helpers/mut-adminagent-setup';
import { beforeEach, describe, expect, it } from 'vitest';

const ACTOR_REQUIRED = 'DPoP-bound machine actor required';
const headers = (authorization = 'DPoP machine-token', dpop: string | null = 'dpop-proof') => ({
  authorization,
  ...(dpop ? { dpop } : {}),
});

async function delegate(h: Record<string, string> = headers()): Promise<Response> {
  return post('delegation', { grant_id: 'grant-1' }, h);
}

describe('Mode B machine actor authentication', () => {
  beforeEach(() => {
    resetDefaults();
    mocks.getGrant.mockResolvedValue(modeBGrant());
    mocks.verifyToken.mockResolvedValue(machineActorPayload());
  });

  it('verifies a DPoP-scheme admin API token and its proof', async () => {
    expect((await delegate(headers('dpop   machine-token'))).status).toBe(200);
    expect(mocks.parseTokenHeader).toHaveBeenCalledWith('machine-token');
    expect(mocks.getPublicKeyByKid).toHaveBeenCalledWith(anything(), 'tenant-1', 'kid-1');
    expect(mocks.verifyToken).toHaveBeenCalledWith('machine-token', {}, BASE, {
      audience: 'authrim:admin-api',
    });
    expect(mocks.isTokenRevoked).toHaveBeenCalledWith(anything(), 'machine-jti', 'tenant-1');
    expect(mocks.validateDPoPProof).toHaveBeenCalledWith(
      'dpop-proof',
      'POST',
      `${BASE}/oauth/admin-agent/delegation`,
      'machine-token',
      anything(),
      'mcp-client',
      'tenant-1'
    );
    expect(mocks.resolveTenantMachineLimit).toHaveBeenCalledWith('tenant-1', 'amp-1', 'amk-1');
  });

  it.each([
    ['a Bearer scheme', headers('Bearer machine-token')],
    ['a scheme with a prefix', headers('XDPoP machine-token')],
    ['no Authorization header', { dpop: 'dpop-proof' }],
    ['no DPoP proof', headers('DPoP machine-token', null)],
  ])('rejects %s without verifying the token', async (_name, h) => {
    await expectError(await delegate(h), 401, 'invalid_token', ACTOR_REQUIRED);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['a header without kid', () => mocks.parseTokenHeader.mockReturnValue({ alg: 'RS256' })],
    ['an unknown key', () => mocks.getPublicKeyByKid.mockResolvedValue(null)],
    ['a failed signature', () => mocks.verifyToken.mockRejectedValue(new Error('bad'))],
  ])('rejects %s', async (_name, arrange) => {
    arrange();
    await expectError(await delegate(), 401, 'invalid_token', ACTOR_REQUIRED);
    expect(mocks.validateDPoPProof).not.toHaveBeenCalled();
  });

  it.each([
    ['a human actor', { actor_type: 'user' }],
    ['a token that is not sender constrained', { sender_constrained: 'true' }],
    ['no principal', { actor_id: undefined }],
    ['no credential', { credential_id: 42 }],
    ['no client', { client_id: undefined }],
    ['no jti', { jti: undefined }],
    ['no confirmation', { cnf: undefined }],
    ['a non-string thumbprint', { cnf: { jkt: 1 } }],
  ])('rejects an actor token with %s before checking the proof', async (_name, overrides) => {
    mocks.verifyToken.mockResolvedValue(machineActorPayload(overrides));
    await expectError(await delegate(), 401, 'invalid_token', ACTOR_REQUIRED);
    expect(mocks.validateDPoPProof).not.toHaveBeenCalled();
  });

  it('rejects a revoked actor token', async () => {
    mocks.isTokenRevoked.mockResolvedValue(true);
    await expectError(await delegate(), 401, 'invalid_token', ACTOR_REQUIRED);
    expect(mocks.validateDPoPProof).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid proof', { valid: false, jkt: 'mode-b-jkt' }],
    ['a proof for another key', { valid: true, jkt: 'other-jkt' }],
  ])('rejects %s', async (_name, result) => {
    mocks.validateDPoPProof.mockResolvedValue(result);
    await expectError(await delegate(), 401, 'invalid_token', ACTOR_REQUIRED);
    expect(mocks.resolveTenantMachineLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['an inactive principal or credential', null],
    ['a principal of another client', machineLimit(['admin:users:read'], 'other-client')],
  ])('rejects %s', async (_name, limit) => {
    mocks.resolveTenantMachineLimit.mockResolvedValue(limit);
    await expectError(await delegate(), 401, 'invalid_token', ACTOR_REQUIRED);
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it('caps the delegation by the live machine permissions', async () => {
    mocks.resolveTenantMachineLimit.mockResolvedValue(machineLimit(['admin:clients:read']));
    await expectError(await delegate(), 400, 'invalid_grant', 'Mode B permission ceiling changed');
    expect(mocks.signJwtPayload).not.toHaveBeenCalled();
  });
});

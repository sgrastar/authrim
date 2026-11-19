/**
 * Admin Agent authorization_code grant: initial refresh token family creation, finalization and
 * cleanup (src/admin-agent-token.ts issueInitialRefreshToken).
 */
import {
  anyString,
  anything,
  callArg,
  codeData,
  codeForm,
  confidentialClient,
  expectError,
  ISSUER,
  MCP,
  mocks,
  modeAGrant,
  post,
  resetDefaults,
} from './helpers/mut-adminagent-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const PUBLIC_TTL = 7 * 24 * 60 * 60;
const CONFIDENTIAL_TTL = 30 * 24 * 60 * 60;
const INIT_FAILED = 'Refresh token initialization failed';

function familyId(): string {
  return callArg<{ userId: string }>(mocks.createRefreshTokenFamily, 1).userId;
}

describe('Admin Agent initial refresh token', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates, registers and finalizes a 7 day family for a public client', async () => {
    expect((await post('token', codeForm())).status).toBe(200);
    const id = familyId();
    expect(id).toMatch(/^agf_[0-9a-f-]{36}$/u);
    expect(mocks.createRefreshTokenFamily).toHaveBeenCalledWith(anything(), {
      userId: id,
      clientId: 'mcp-client',
      scope: 'agent:read',
      ttl: PUBLIC_TTL,
      tenantId: 'tenant-1',
      resourceAudience: MCP,
    });
    const pending = callArg<{ finalizationNonce: string }>(mocks.createPendingTokenFamily, 0);
    expect(pending).toEqual({
      familyId: id,
      familyJti: 'rt_1_0_initial',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      adminUserId: 'admin-1',
      clientId: 'mcp-client',
      consentVersion: 2,
      finalizationNonce: anyString(),
      expiresAt: NOW + PUBLIC_TTL * 1000,
      createdAt: NOW,
    });
    expect(pending.finalizationNonce.length).toBeGreaterThan(0);
    expect(mocks.createRefreshToken).toHaveBeenCalledWith(
      {
        iss: ISSUER,
        sub: 'admin_user:admin-1',
        aud: 'mcp-client',
        scope: 'agent:read',
        client_id: 'mcp-client',
        tenant_id: 'tenant-1',
        resource_aud: MCP,
        agent_family_id: id,
        grant_id: 'grant-1',
        grant_generation: 3,
        consent_version: 2,
        actor_mode: 'mode_a',
        actor_assurance: 'public_client_transaction',
      },
      {},
      'kid-1',
      PUBLIC_TTL,
      'rt_1_0_initial',
      1
    );
    const accessJti = callArg(mocks.consumeCodeRpc, 0).accessTokenJti;
    expect(mocks.registerIssuedTokensRpc).toHaveBeenCalledWith(
      'aac_valid-code',
      accessJti,
      'rt_1_0_initial'
    );
    expect(mocks.finalizeTokenFamily).toHaveBeenCalledWith({
      familyId: id,
      finalizationNonce: pending.finalizationNonce,
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      adminUserId: 'admin-1',
      clientId: 'mcp-client',
      consentVersion: 2,
      now: NOW,
    });
    expect(mocks.revokeFamilyRpc).not.toHaveBeenCalled();
  });

  it('gives a confidential DPoP client a 30 day bound family with authorization_details', async () => {
    const details = [{ type: 'authrim_admin_agent', max_subjects_per_call: 2 }];
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'jkt-1' });
    mocks.consumeCodeRpc.mockResolvedValue(codeData({ authorizationDetails: details }));
    const response = await post('token', codeForm({ client_secret: 's' }), { dpop: 'p' });
    expect(response.status).toBe(200);
    expect(callArg(mocks.createRefreshTokenFamily, 1).ttl).toBe(CONFIDENTIAL_TTL);
    expect(callArg(mocks.createPendingTokenFamily, 0).expiresAt).toBe(
      NOW + CONFIDENTIAL_TTL * 1000
    );
    expect(mocks.createRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_assurance: 'confidential_client',
        authorization_details: details,
        cnf: { jkt: 'jkt-1' },
      }),
      {},
      'kid-1',
      CONFIDENTIAL_TTL,
      'rt_1_0_initial',
      1
    );
  });

  it.each([
    [
      'the code store refuses registration',
      () => mocks.registerIssuedTokensRpc.mockResolvedValue(false),
    ],
    ['the DB family cannot be finalized', () => mocks.finalizeTokenFamily.mockResolvedValue(false)],
    [
      'the pending row cannot be written',
      () => mocks.createPendingTokenFamily.mockRejectedValue(new Error('db')),
    ],
  ])('revokes the rotator family when %s', async (_name, arrange) => {
    arrange();
    await expectError(await post('token', codeForm()), 503, 'temporarily_unavailable', INIT_FAILED);
    expect(mocks.getRefreshTokenRotatorStubByJti).toHaveBeenCalledWith(
      anything(),
      'mcp-client',
      'rt_1_0_initial',
      'tenant-1'
    );
    expect(mocks.revokeFamilyRpc).toHaveBeenCalledWith(familyId(), 'initialization_failed');
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('does not finalize a family whose tokens were not registered', async () => {
    mocks.registerIssuedTokensRpc.mockResolvedValue(false);
    await post('token', codeForm());
    expect(mocks.finalizeTokenFamily).not.toHaveBeenCalled();
  });

  it('skips revocation when the rotator family was never created', async () => {
    mocks.createRefreshTokenFamily.mockRejectedValue(new Error('rotator down'));
    await expectError(await post('token', codeForm()), 503, 'temporarily_unavailable', INIT_FAILED);
    expect(mocks.getRefreshTokenRotatorStubByJti).not.toHaveBeenCalled();
  });

  it('still fails closed when the cleanup revocation throws', async () => {
    mocks.finalizeTokenFamily.mockResolvedValue(false);
    mocks.revokeFamilyRpc.mockRejectedValue(new Error('down'));
    await expectError(await post('token', codeForm()), 503, 'temporarily_unavailable', INIT_FAILED);
  });

  it('uses the Grant snapshot values for the family', async () => {
    mocks.getGrant.mockResolvedValue(modeAGrant({ grantId: 'grant-1' }));
    expect((await post('token', codeForm())).status).toBe(200);
    expect(callArg<unknown>(mocks.createPendingTokenFamily, 0)).toMatchObject({
      grantId: 'grant-1',
      grantGeneration: 3,
      consentVersion: 2,
    });
  });
});

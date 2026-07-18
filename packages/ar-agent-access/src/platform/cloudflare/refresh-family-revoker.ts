import { getRefreshTokenRotatorStubByJti, type Env } from '@authrim/ar-lib-core';
import type { AgentRefreshFamilyRevocationRequest, AgentRefreshFamilyRevokerPort } from '../ports';

/**
 * Locates the Cloudflare RefreshTokenRotator shard with the captured JTI, then revokes by the
 * immutable family ID. Revoking by JTI would fail after the family rotates to a new current JTI.
 */
export class CloudflareRefreshFamilyRevoker implements AgentRefreshFamilyRevokerPort {
  constructor(private readonly env: Env) {}

  async revoke(request: AgentRefreshFamilyRevocationRequest): Promise<void> {
    const { stub } = getRefreshTokenRotatorStubByJti(
      this.env,
      request.clientId,
      request.familyJti,
      request.tenantId
    );
    await stub.revokeFamilyRpc(request.familyId, request.reason);
  }
}

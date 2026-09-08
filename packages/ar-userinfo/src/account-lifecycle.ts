import {
  GUEST_LIFECYCLE_SCOPE,
  GuestLifecycleRepository,
  getMissingRequiredCustomClaims,
  loadClientContractCached,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveGuestSettings,
  type CanonicalRuntimeUserProjection,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { Context } from 'hono';

export const ACCOUNT_LIFECYCLE_CLAIM = 'authrim_account_lifecycle';

/** Read only; UserInfo never extends retention, acquires a hold, or upgrades an account. */
export async function readAccountLifecycleClaim(input: {
  c: Context<{ Bindings: Env }>;
  adapter: DatabaseAdapter;
  tenantId: string;
  clientId: string;
  user: CanonicalRuntimeUserProjection;
  scopes: readonly string[];
}) {
  if (!input.scopes.includes(GUEST_LIFECYCLE_SCOPE)) return undefined;
  const { c, adapter, tenantId, clientId, user } = input;
  if (user.tenant_id !== tenantId) throw new Error('account_lifecycle_tenant_mismatch');
  // Machine subjects have their own lifecycle contract; never infer human retention for them.
  if (user.account_type !== 'anonymous' && user.account_type !== 'user') return undefined;
  const row = await new GuestLifecycleRepository(adapter, tenantId).get(user.id);
  if (row?.phase === 'deleting' || row?.phase === 'deleted') {
    throw new Error('account_lifecycle_deleted');
  }
  // Registration projections can be written before the durable lifecycle commit.
  const guest = row ? row.phase !== 'registered' : user.account_type === 'anonymous';
  let upgradeEligible = false;
  if (guest && row?.phase === 'active' && clientId && row.client_id === clientId) {
    const settings = await resolveGuestSettings(c.env, tenantId);
    const contract = await loadClientContractCached(
      c,
      c.env.AUTHRIM_CONFIG,
      c.env,
      tenantId,
      clientId
    );
    const candidates = settings.policy.upgradeEnabled
      ? settings.upgradeMethods.filter((method) =>
          contract?.anonymousAuth?.allowedUpgradeMethods?.includes(method)
        )
      : [];
    let emailReady = false;
    if (candidates.includes('email')) {
      if (!c.env.GUEST_UPGRADE_READINESS) throw new Error('guest_upgrade_readiness_unavailable');
      const readiness = await c.env.GUEST_UPGRADE_READINESS.read(tenantId);
      if (readiness.tenantId !== tenantId || typeof readiness.email !== 'boolean')
        throw new Error('guest_upgrade_readiness_invalid');
      emailReady = readiness.email;
    }
    upgradeEligible = candidates.includes('passkey') || emailReady;
  }
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId, {
    accountId: user.id,
  });
  if (!sources.nonPiiDb) throw new Error('account_data_route_incomplete');
  const missing = await getMissingRequiredCustomClaims({
    db: sources.nonPiiDb,
    dbPii: sources.piiDb,
    schemaDb: sources.schemaDb,
    tenantId,
    userId: user.id,
  });
  const createdAt = row?.created_at ?? Math.floor(Date.parse(user.created_at) / 1000);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new Error('account_lifecycle_creation_invalid');
  return {
    account_kind: guest ? 'guest' : 'registered',
    created_at: createdAt,
    deletion_due_at: guest ? (row?.deletion_due_at ?? null) : null,
    upgrade_eligible: upgradeEligible,
    profile_complete: missing.length === 0,
  };
}

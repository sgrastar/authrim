/**
 * JTI replay guard
 *
 * Records a token's `jti` once, in a DPoPJTIStore Durable Object. KV cannot do this: a get
 * followed by a put lets two concurrent (or cross-region) presentations both read "unused" and
 * pass. The store's check-and-store runs serially per instance, so only the first presentation
 * records the jti.
 *
 * The instance is chosen from the shard key alone, among a fixed number per tenant, within the
 * tenant's residency jurisdiction: not by the tenant's region shard layout, which can change
 * while a token is still in force and would then send its replay to an instance that never saw
 * it.
 *
 * Each caller namespaces its jtis (for example `native-sso-id-token:<jti>`), so tokens of
 * different kinds never collide in the shared store.
 */

import type { Env } from '../types/env';
import { getRegionShardConfig } from './region-sharding';
import { buildDOInstanceName } from './tenant-context';

/**
 * Replay-guard instances per tenant. Never change it: the jtis recorded would then be looked for
 * in other instances.
 */
const REPLAY_GUARD_SHARDS = 32;

async function replayGuardStore(env: Env, tenantId: string, shardKey: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shardKey))
  );
  const shard = ((digest[0] << 8) | digest[1]) % REPLAY_GUARD_SHARDS;
  // Inside the tenant's residency boundary (an EU tenant's records stay in the EU jurisdiction),
  // which the control plane owns and does not move as region shards are reconfigured.
  const jurisdiction = (await getRegionShardConfig(env, tenantId)).residency?.jurisdiction ?? null;
  const namespace = jurisdiction
    ? env.DPOP_JTI_STORE.jurisdiction(jurisdiction)
    : env.DPOP_JTI_STORE;
  return namespace.get(namespace.idFromName(buildDOInstanceName(`jti-replay:${shard}`, tenantId)));
}

export interface ReplayJtiInput {
  tenantId: string;
  /**
   * Picks the store's shard. Every presentation of one token must give the same key (the
   * token's own jti, or the issuer it is scoped to), or a replay reaches another shard.
   */
  shardKey: string;
  /** The namespaced jti. */
  jti: string;
}

/** Whether the jti was recorded already. Throws when the store cannot answer. */
export async function isReplayJtiRecorded(env: Env, input: ReplayJtiInput): Promise<boolean> {
  const stub = await replayGuardStore(env, input.tenantId, input.shardKey);
  const response = await stub.fetch('https://jti-store/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jti: input.jti }),
  });
  if (!response.ok) {
    throw new Error(`jti_replay_store_unavailable:${response.status}`);
  }
  return (await response.json<{ exists?: boolean }>()).exists === true;
}

/**
 * Records the jti unless it was recorded already ('replayed'). Throws when the store cannot
 * answer, so a caller never treats an unknown outcome as a first use.
 */
export async function recordReplayJti(
  env: Env,
  input: ReplayJtiInput & { issuedAt: number; ttlSeconds: number }
): Promise<'recorded' | 'replayed'> {
  const stub = await replayGuardStore(env, input.tenantId, input.shardKey);
  const response = await stub.fetch('https://jti-store/check-and-store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jti: input.jti,
      client_id: input.shardKey,
      iat: input.issuedAt,
      ttl: Math.max(1, Math.ceil(input.ttlSeconds)),
    }),
  });
  if (response.ok) return 'recorded';
  if (response.status === 400) {
    // The store answers a replay with 400, and a malformed request with 400 invalid_request.
    const body = await response.json<{ error?: string }>().catch((): { error?: string } => ({}));
    if (body.error !== 'invalid_request') return 'replayed';
  }
  throw new Error(`jti_replay_store_unavailable:${response.status}`);
}

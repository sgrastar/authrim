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
 *
 * Outside Cloudflare (the AWS runtime) there is no Durable Object: the runtime's `replayGuard`
 * port records the jti with one conditional write in its own store instead.
 */

import type { AuthRuntimePorts } from '../types/auth-runtime-ports';
import type { Env } from '../types/env';
import { getRegionShardConfig } from './region-sharding';
import { buildDOInstanceName } from './tenant-context';

/**
 * Replay-guard instances per tenant. Never change it: the jtis recorded would then be looked for
 * in other instances.
 */
const REPLAY_GUARD_SHARDS = 32;

/**
 * The runtime's replay store when this is not Cloudflare (undefined on Cloudflare). A runtime
 * that has ports but no replay store throws, so replay protection never silently falls away.
 */
export function runtimeReplayGuard(
  env: Pick<Env, 'AUTH_RUNTIME_PORTS'>
): NonNullable<AuthRuntimePorts['replayGuard']> | undefined {
  const ports = env.AUTH_RUNTIME_PORTS;
  if (!ports) return undefined;
  if (!ports.replayGuard) throw new Error('auth_runtime_replay_guard_unavailable');
  return ports.replayGuard;
}

/** Fixed-length key for the runtime store, so any accepted token's jti fits its limits. */
async function runtimeReplayKey(key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  );
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Records a namespaced key through the runtime's store: undefined on Cloudflare, where the
 * caller uses its Durable Object. Rejects (never resolves 'recorded') when the store fails.
 */
export async function recordRuntimeReplay(
  env: Pick<Env, 'AUTH_RUNTIME_PORTS'>,
  input: { tenantId: string; key: string; ttlSeconds: number }
): Promise<'recorded' | 'replayed' | undefined> {
  const runtime = runtimeReplayGuard(env);
  if (!runtime) return undefined;
  return runtime.record({
    tenantId: input.tenantId,
    key: await runtimeReplayKey(input.key),
    ttlSeconds: Math.max(1, Math.ceil(input.ttlSeconds)),
  });
}

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
  const runtime = runtimeReplayGuard(env);
  if (runtime) {
    return runtime.isRecorded({ tenantId: input.tenantId, key: await runtimeReplayKey(input.jti) });
  }
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
  const ttlSeconds = Math.max(1, Math.ceil(input.ttlSeconds));
  const outcome = await recordRuntimeReplay(env, {
    tenantId: input.tenantId,
    key: input.jti,
    ttlSeconds,
  });
  if (outcome) return outcome;
  const stub = await replayGuardStore(env, input.tenantId, input.shardKey);
  const response = await stub.fetch('https://jti-store/check-and-store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jti: input.jti,
      client_id: input.shardKey,
      iat: input.issuedAt,
      ttl: ttlSeconds,
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

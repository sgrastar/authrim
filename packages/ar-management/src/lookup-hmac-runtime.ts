import {
  loadVerifiedLookupHmacKeyState,
  resolveLookupHmacKeys,
  type Env,
  type ResolvedLookupHmacKeys,
} from '@authrim/ar-lib-core';

const CACHE_TTL_MS = 30_000;
const SAFE_ENVIRONMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

interface CachedState {
  loadedAt: number;
  value: ResolvedLookupHmacKeys;
}

const cache = new Map<string, CachedState>();

export async function loadLookupHmacRuntimeKeys(
  env: Env,
  options: { nowMs?: number; bypassCache?: boolean } = {}
): Promise<ResolvedLookupHmacKeys> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !environmentId ||
    !SAFE_ENVIRONMENT.test(environmentId) ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('lookup_hmac_key_state_unavailable');
  }
  const nowMs = options.nowMs ?? Date.now();
  const cached = cache.get(environmentId);
  if (!options.bypassCache && cached && nowMs - cached.loadedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  const state = await loadVerifiedLookupHmacKeyState({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    now: Math.floor(nowMs / 1000),
  });
  const resolved = await resolveLookupHmacKeys({
    state,
    slotA: env.LOOKUP_HMAC_KEY_SLOT_A,
    slotB: env.LOOKUP_HMAC_KEY_SLOT_B,
  });
  cache.set(environmentId, { loadedAt: nowMs, value: resolved });
  return resolved;
}

export function resetLookupHmacRuntimeKeyCacheForTest(): void {
  cache.clear();
}

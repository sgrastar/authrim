import { signRuntimeSmokeRequest, type RuntimeSmokeRequestInput } from '@authrim/ar-lib-core';

type RuntimeSmokePrivateJwk = Parameters<typeof signRuntimeSmokeRequest>[0]['privateJwk'];

export interface RuntimeSmokeSigningEnv {
  SMOKE_RPC_SIGNING_JWK_SLOT_A?: string;
  SMOKE_RPC_SIGNING_JWK_SLOT_B?: string;
  SMOKE_RPC_SIGNING_ACTIVE_SLOT?: string;
  SMOKE_RPC_SIGNING_ACTIVE_KID?: string;
}

const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function parsePrivateJwkForSlot(
  env: RuntimeSmokeSigningEnv,
  slot: 'A' | 'B',
  keyId: string
): {
  privateJwk: RuntimeSmokePrivateJwk;
  keyId: string;
} {
  if (typeof keyId !== 'string' || !SAFE_KEY_ID.test(keyId)) {
    throw new Error('control_smoke_active_key_id_invalid');
  }
  const serialized =
    slot === 'A' ? env.SMOKE_RPC_SIGNING_JWK_SLOT_A : env.SMOKE_RPC_SIGNING_JWK_SLOT_B;
  if (typeof serialized !== 'string' || serialized.length === 0 || serialized.length > 16 * 1024) {
    throw new Error('control_smoke_active_slot_secret_missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('control_smoke_active_slot_secret_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('control_smoke_active_slot_secret_invalid');
  }
  const privateJwk = parsed as RuntimeSmokePrivateJwk;
  if (privateJwk.kid !== keyId) {
    throw new Error('control_smoke_active_key_id_mismatch');
  }
  return { privateJwk, keyId };
}

function parseSelectedPrivateJwk(env: RuntimeSmokeSigningEnv): {
  privateJwk: RuntimeSmokePrivateJwk;
  keyId: string;
} {
  const slot = env.SMOKE_RPC_SIGNING_ACTIVE_SLOT;
  if (slot !== 'A' && slot !== 'B') {
    throw new Error('control_smoke_active_slot_invalid');
  }
  const keyId = env.SMOKE_RPC_SIGNING_ACTIVE_KID;
  if (typeof keyId !== 'string') throw new Error('control_smoke_active_key_id_invalid');
  return parsePrivateJwkForSlot(env, slot, keyId);
}

export async function signControlRuntimeSmokeRequest(input: {
  env: RuntimeSmokeSigningEnv;
  request: RuntimeSmokeRequestInput;
  now?: number;
}): Promise<string> {
  const selected = parseSelectedPrivateJwk(input.env);
  try {
    return await signRuntimeSmokeRequest({
      request: input.request,
      privateJwk: selected.privateJwk,
      keyId: selected.keyId,
      now: input.now,
    });
  } catch {
    throw new Error('control_smoke_signing_failed');
  }
}

export async function signControlRuntimeSmokeRequestWithKey(input: {
  env: RuntimeSmokeSigningEnv;
  slot: 'A' | 'B';
  keyId: string;
  request: RuntimeSmokeRequestInput;
  now?: number;
}): Promise<string> {
  const selected = parsePrivateJwkForSlot(input.env, input.slot, input.keyId);
  try {
    return await signRuntimeSmokeRequest({
      request: input.request,
      privateJwk: selected.privateJwk,
      keyId: selected.keyId,
      now: input.now,
    });
  } catch {
    throw new Error('control_smoke_signing_failed');
  }
}

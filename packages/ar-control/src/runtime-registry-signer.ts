import type {
  ControlRuntimeRegistrySignature,
  ControlRuntimeRegistrySignerMetadata,
} from '@authrim/ar-lib-core/control-plane';
import { signRuntimeRegistrySnapshotPayloadJws } from '@authrim/ar-lib-core';
import { runtimeRegistryPrivateJwk } from './lookup-registry-publisher';
import type { ControlEnv } from './types';

const MAX_SIGNING_PAYLOAD_BYTES = 256 * 1024;
type RuntimeRegistryPrivateJwk = Parameters<
  typeof signRuntimeRegistrySnapshotPayloadJws
>[0]['privateJwk'];

function privateKey(env: ControlEnv): { keyId: string; jwk: RuntimeRegistryPrivateJwk } {
  const jwk = runtimeRegistryPrivateJwk(env);
  const keyId = env.TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID;
  if (
    !keyId ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.d !== 'string'
  ) {
    throw new Error('runtime_registry_signing_key_invalid');
  }
  return { keyId, jwk: jwk as RuntimeRegistryPrivateJwk };
}

export function runtimeRegistrySignerMetadata(
  env: ControlEnv
): ControlRuntimeRegistrySignerMetadata {
  const { keyId } = privateKey(env);
  return { keyId, algorithm: 'EdDSA', type: 'authrim-runtime-registry+jws' };
}

export async function signRuntimeRegistryPayload(
  env: ControlEnv,
  input: unknown
): Promise<ControlRuntimeRegistrySignature> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('runtime_registry_signing_input_invalid');
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !(record.payload instanceof Uint8Array)) {
    throw new Error('runtime_registry_signing_input_invalid');
  }
  if (record.payload.byteLength < 1 || record.payload.byteLength > MAX_SIGNING_PAYLOAD_BYTES) {
    throw new Error('runtime_registry_signing_payload_invalid');
  }
  const { keyId, jwk } = privateKey(env);
  const compactJws = await signRuntimeRegistrySnapshotPayloadJws({
    payload: record.payload,
    privateJwk: jwk,
    keyId,
  });
  return {
    keyId,
    algorithm: 'EdDSA',
    type: 'authrim-runtime-registry+jws',
    compactJws,
  };
}

import {
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  verifyRuntimeRegistrySnapshotPayloadJws,
  type Env,
  type RuntimeRegistrySnapshotExternalSigner,
} from '@authrim/ar-lib-core';

const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export async function createControlRuntimeRegistrySigner(
  env: Env
): Promise<RuntimeRegistrySnapshotExternalSigner> {
  const control = env.CONTROL;
  if (!control?.getRuntimeRegistrySignerMetadata || !control.signRuntimeRegistryPayload) {
    throw new Error('tenant_runtime_registry_control_signer_unavailable');
  }
  const signPayload = (input: { payload: Uint8Array }) =>
    control.signRuntimeRegistryPayload!(input);
  const metadata = await control.getRuntimeRegistrySignerMetadata();
  if (
    !metadata ||
    metadata.algorithm !== 'EdDSA' ||
    metadata.type !== 'authrim-runtime-registry+jws' ||
    typeof metadata.keyId !== 'string' ||
    !SAFE_KEY_ID.test(metadata.keyId)
  ) {
    throw new Error('tenant_runtime_registry_control_signer_invalid');
  }

  return {
    keyId: metadata.keyId,
    algorithm: 'EdDSA',
    type: 'authrim-runtime-registry+jws',
    async sign(payload) {
      const result = await signPayload({ payload });
      if (
        result.keyId !== metadata.keyId ||
        result.algorithm !== 'EdDSA' ||
        result.type !== 'authrim-runtime-registry+jws' ||
        typeof result.compactJws !== 'string'
      ) {
        throw new Error('tenant_runtime_registry_control_signature_invalid');
      }
      let valid = false;
      try {
        valid = await verifyRuntimeRegistrySnapshotPayloadJws({
          token: result.compactJws,
          payload,
          keys: loadTenantRuntimeRegistryVerificationKeysFromEnv(env),
          expectedKeyId: metadata.keyId,
        });
      } catch {
        valid = false;
      }
      if (!valid) throw new Error('tenant_runtime_registry_control_signature_invalid');
      return result.compactJws;
    },
  };
}

import { describe, expect, it, vi } from 'vitest';
import {
  signRuntimeRegistrySnapshotPayloadJws,
  type ControlRuntimeRegistrySignature,
  type Env,
} from '@authrim/ar-lib-core';
import { createControlRuntimeRegistrySigner } from '../control-runtime-registry-signer';

async function envWithSigner(
  response?:
    | ControlRuntimeRegistrySignature
    | ((payload: Uint8Array, privateJwk: JsonWebKey) => Promise<ControlRuntimeRegistrySignature>)
) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('expected_crypto_key_pair');
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey & {
    kid: string;
  };
  privateJwk.kid = 'runtime-registry-a';
  privateJwk.alg = 'EdDSA';
  privateJwk.use = 'sig';
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & {
    kid: string;
  };
  publicJwk.kid = 'runtime-registry-a';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';
  const signRuntimeRegistryPayload = vi.fn(async ({ payload }: { payload: Uint8Array }) => {
    if (typeof response === 'function') return response(payload, privateJwk);
    if (response) return response;
    return {
      keyId: 'runtime-registry-a',
      algorithm: 'EdDSA' as const,
      type: 'authrim-runtime-registry+jws' as const,
      compactJws: await signRuntimeRegistrySnapshotPayloadJws({
        payload,
        privateJwk,
        keyId: 'runtime-registry-a',
      }),
    };
  });
  const env = {
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    CONTROL: {
      getRuntimeRegistrySignerMetadata: vi.fn(async () => ({
        keyId: 'runtime-registry-a',
        algorithm: 'EdDSA' as const,
        type: 'authrim-runtime-registry+jws' as const,
      })),
      signRuntimeRegistryPayload,
    },
  } as unknown as Env;
  return { env, signRuntimeRegistryPayload };
}

describe('Management Control runtime registry signer adapter', () => {
  it('delegates the exact payload and verifies the returned compact JWS', async () => {
    const { env, signRuntimeRegistryPayload } = await envWithSigner();
    const signer = await createControlRuntimeRegistrySigner(env);
    const payload = new Uint8Array([1, 2, 3]);

    expect(signer).toMatchObject({
      keyId: 'runtime-registry-a',
      algorithm: 'EdDSA',
      type: 'authrim-runtime-registry+jws',
    });
    await expect(signer.sign(payload)).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
    expect(signRuntimeRegistryPayload).toHaveBeenCalledOnce();
    expect(signRuntimeRegistryPayload).toHaveBeenCalledWith({ payload });
  });

  it('does not call Function.bind on the Service Binding RPC method', async () => {
    const { env, signRuntimeRegistryPayload } = await envWithSigner();
    const bind = vi.fn(() => {
      throw new Error('rpc_receiver_does_not_implement_bind');
    });
    Object.defineProperty(signRuntimeRegistryPayload, 'bind', { value: bind });

    const signer = await createControlRuntimeRegistrySigner(env);
    await expect(signer.sign(new Uint8Array([4, 5, 6]))).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);

    expect(bind).not.toHaveBeenCalled();
    expect(signRuntimeRegistryPayload).toHaveBeenCalledOnce();
  });

  it('fails closed when the Control signer binding is unavailable', async () => {
    await expect(createControlRuntimeRegistrySigner({} as Env)).rejects.toThrow(
      'tenant_runtime_registry_control_signer_unavailable'
    );
  });

  it.each([
    {
      keyId: 'different-key',
      algorithm: 'EdDSA' as const,
      type: 'authrim-runtime-registry+jws' as const,
      compactJws: 'invalid.compact.jws',
    },
    {
      keyId: 'runtime-registry-a',
      algorithm: 'EdDSA' as const,
      type: 'authrim-runtime-registry+jws' as const,
      compactJws: 'invalid.compact.jws',
    },
  ])('rejects an invalid Control signature response', async (response) => {
    const { env } = await envWithSigner(response);
    const signer = await createControlRuntimeRegistrySigner(env);

    await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow(
      'tenant_runtime_registry_control_signature_invalid'
    );
  });

  it('rejects a valid Control signature when the verification key is not deployed', async () => {
    const { env } = await envWithSigner();
    env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS = undefined;
    const signer = await createControlRuntimeRegistrySigner(env);

    await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow(
      'tenant_runtime_registry_control_signature_invalid'
    );
  });

  it('normalizes malformed verification JWKS to the fixed signer error', async () => {
    const { env } = await envWithSigner();
    env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS = '{private-json-fragment';
    const signer = await createControlRuntimeRegistrySigner(env);

    await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow(
      /^tenant_runtime_registry_control_signature_invalid$/u
    );
  });
});

import { CompactSign, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_ACCELERATOR_JWS_TYPE,
  signBootstrapAcceleratorProof,
  verifyBootstrapAcceleratorProof,
} from '../bootstrap-accelerator-proof';

const NOW = 1_786_406_400;
let privateJwk: JWK;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'smoke-a', alg: 'EdDSA', use: 'sig' };
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'smoke-a', alg: 'EdDSA', use: 'sig' };
});

describe('initial bootstrap accelerator proof', () => {
  it('binds a 15-second proof to the exact environment and purpose', async () => {
    const proof = await signBootstrapAcceleratorProof({
      environmentId: 'test',
      jti: 'setup-proof-1',
      privateJwk,
      keyId: 'smoke-a',
      now: NOW,
    });
    await expect(
      verifyBootstrapAcceleratorProof(proof, { environmentId: 'test', publicJwk, now: NOW })
    ).resolves.toEqual({
      iss: 'authrim-setup:test',
      aud: 'authrim-control:test',
      iat: NOW,
      exp: NOW + 15,
      jti: 'setup-proof-1',
      purpose: 'initial_bootstrap_advance',
      environmentId: 'test',
    });
    await expect(
      verifyBootstrapAcceleratorProof(proof, { environmentId: 'prod', publicJwk, now: NOW })
    ).rejects.toThrow('bootstrap_accelerator_boundary_mismatch');
  });

  it('rejects expired, private-verification-key, and cross-protocol proofs', async () => {
    const proof = await signBootstrapAcceleratorProof({
      environmentId: 'test',
      jti: 'setup-proof-2',
      privateJwk,
      keyId: 'smoke-a',
      now: NOW,
    });
    await expect(
      verifyBootstrapAcceleratorProof(proof, {
        environmentId: 'test',
        publicJwk,
        now: NOW + 21,
      })
    ).rejects.toThrow('bootstrap_accelerator_expired');
    await expect(
      verifyBootstrapAcceleratorProof(proof, {
        environmentId: 'test',
        publicJwk: privateJwk,
        now: NOW,
      })
    ).rejects.toThrow('bootstrap_accelerator_public_jwk_contains_private_material');

    const key = await importJWK(privateJwk, 'EdDSA');
    const wrongType = await new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({
          iss: 'authrim-setup:test',
          aud: 'authrim-control:test',
          iat: NOW,
          exp: NOW + 15,
          jti: 'setup-proof-3',
          purpose: 'initial_bootstrap_advance',
          environmentId: 'test',
        })
      )
    )
      .setProtectedHeader({ alg: 'EdDSA', typ: 'authrim-smoke-rpc+jws', kid: 'smoke-a' })
      .sign(key);
    expect(BOOTSTRAP_ACCELERATOR_JWS_TYPE).not.toBe('authrim-smoke-rpc+jws');
    await expect(
      verifyBootstrapAcceleratorProof(wrongType, { environmentId: 'test', publicJwk, now: NOW })
    ).rejects.toThrow('bootstrap_accelerator_header_invalid');
  });
});

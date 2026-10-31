import { describe, expect, it } from 'vitest';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';

const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const hash = async (value: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', value));

// WebAuthn transmits DER ECDSA signatures, while WebCrypto produces r || s.
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length - 1 && bytes[offset] === 0) offset++;
    const value = Array.from(bytes.slice(offset));
    if (value[0] & 0x80) value.unshift(0);
    return [2, value.length, ...value];
  };
  const values = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, values.length, ...values]);
}

async function assertion() {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  const publicKey = new Uint8Array([
    0xa5,
    1,
    2,
    3,
    0x26,
    0x20,
    1,
    0x21,
    0x58,
    32,
    ...Buffer.from(jwk.x!, 'base64url'),
    0x22,
    0x58,
    32,
    ...Buffer.from(jwk.y!, 'base64url'),
  ]);
  const rpID = 'admin.example.com';
  const challenge = b64(new Uint8Array(32).fill(7));
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin: `https://${rpID}`,
      crossOrigin: false,
    })
  );
  const authData = new Uint8Array([...(await hash(new TextEncoder().encode(rpID))), 5, 0, 0, 0, 1]);
  const signature = derSignature(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        new Uint8Array([...authData, ...(await hash(clientData))])
      )
    )
  );
  const id = b64(new Uint8Array([1, 2, 3]));
  return {
    response: {
      id,
      rawId: id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
      },
      clientExtensionResults: {},
    },
    expectedChallenge: challenge,
    expectedOrigin: `https://${rpID}`,
    expectedRPID: rpID,
    credential: { id, publicKey, counter: 0 },
    requireUserVerification: true,
  };
}

describe('Admin passkey real cryptographic verification', () => {
  it('verifies a DER ES256 assertion using the installed library dependency graph', async () => {
    const verified = await verifyAuthenticationResponse(await assertion());
    expect(verified.verified).toBe(true);
    expect(verified.authenticationInfo.newCounter).toBe(1);
  });

  it('rejects an otherwise valid assertion for a different browser origin', async () => {
    const options = await assertion();
    await expect(
      verifyAuthenticationResponse({
        ...options,
        expectedOrigin: 'https://other.example.com',
      })
    ).rejects.toThrow('origin');
  });

  it('rejects a tampered signature', async () => {
    const options = await assertion();
    const signature = Buffer.from(options.response.response.signature, 'base64url');
    signature[signature.length - 1] ^= 1;
    options.response.response.signature = b64(signature);
    const result = await verifyAuthenticationResponse(options);
    expect(result.verified).toBe(false);
  });
});

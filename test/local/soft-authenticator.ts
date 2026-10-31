/**
 * Minimal software WebAuthn authenticator (ES256, "none" attestation) so the local smoke test can
 * register and use a passkey without a browser. It follows the CTAP2/WebAuthn data layouts the
 * relying party verifies; it is a test double, not a general-purpose authenticator.
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const base64url = (value: Uint8Array): string => Buffer.from(value).toString('base64url');
const sha256 = (value: string | Uint8Array): Buffer => createHash('sha256').update(value).digest();

type CborValue = number | string | Buffer | Map<CborValue, CborValue>;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) return Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  throw new Error('cbor_item_too_large');
}

export function encodeCbor(value: CborValue): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  return Buffer.concat([
    cborHead(5, value.size),
    ...[...value].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)]),
  ]);
}

export interface RegistrationOptions {
  challenge: string;
  rp: { id: string };
}
export interface AuthenticationOptions {
  challenge: string;
  rpId: string;
}

export function createSoftAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  let counter = 0;
  const coseKey = encodeCbor(
    new Map<CborValue, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ])
  );
  // user present | user verified, plus attested credential data on registration.
  const flags = (attested: boolean): number => 0x01 | 0x04 | (attested ? 0x40 : 0);
  const counterBytes = (): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(counter);
    return bytes;
  };

  return {
    credentialId: base64url(credentialId),
    register(input: { options: RegistrationOptions; origin: string }) {
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: input.options.challenge,
          origin: input.origin,
          crossOrigin: false,
        })
      );
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(input.options.rp.id),
        Buffer.from([flags(true)]),
        counterBytes(),
        Buffer.alloc(16),
        idLength,
        credentialId,
        coseKey,
      ]);
      const attestationObject = encodeCbor(
        new Map<CborValue, CborValue>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ])
      );
      return {
        id: base64url(credentialId),
        rawId: base64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: base64url(clientData),
          attestationObject: base64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    authenticate(input: { options: AuthenticationOptions; origin: string; userHandle?: Buffer }) {
      counter += 1;
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: input.options.challenge,
          origin: input.origin,
          crossOrigin: false,
        })
      );
      const authData = Buffer.concat([
        sha256(input.options.rpId),
        Buffer.from([flags(false)]),
        counterBytes(),
      ]);
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), privateKey);
      return {
        id: base64url(credentialId),
        rawId: base64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: base64url(clientData),
          authenticatorData: base64url(authData),
          signature: base64url(signature),
          ...(input.userHandle ? { userHandle: base64url(input.userHandle) } : {}),
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}

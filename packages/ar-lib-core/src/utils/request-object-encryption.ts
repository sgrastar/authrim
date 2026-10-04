/**
 * Encrypted request objects (RFC 9101 Section 6.1, OIDC Core 6.1): an app encrypts the request
 * object to this tenant's request object encryption key, which the tenant's JWKS publishes with
 * use "enc". The KeyManager keeps those keys apart from every signing key.
 */

import { compactDecrypt, decodeProtectedHeader, importPKCS8 } from 'jose';
import type { Env } from '../types/env';
import { SUPPORTED_JWE_ENC } from './jwe';

/** The key management algorithms a request object can be encrypted with (RSA keys). */
export const REQUEST_OBJECT_ENCRYPTION_ALGS = ['RSA-OAEP-256', 'RSA-OAEP'] as const;

/** The content encryption algorithms a request object can be encrypted with. */
export const REQUEST_OBJECT_ENCRYPTION_ENCS = SUPPORTED_JWE_ENC;

export class RequestObjectDecryptionError extends Error {
  constructor(
    /** 'unsupported': an algorithm or key Authrim does not decrypt with; 'failed': otherwise. */
    readonly reason: 'unsupported' | 'unavailable' | 'failed'
  ) {
    super(`request_object_decryption_${reason}`);
    this.name = 'RequestObjectDecryptionError';
  }
}

/**
 * The plaintext of a request object encrypted to this tenant: a nested JWT, or a JSON object.
 * Throws RequestObjectDecryptionError when it cannot be decrypted.
 */
export async function decryptRequestObject(
  env: Pick<Env, 'KEY_MANAGER'>,
  tenantId: string,
  jwe: string
): Promise<string> {
  let header: { alg?: unknown; enc?: unknown; kid?: unknown };
  try {
    header = decodeProtectedHeader(jwe);
  } catch {
    throw new RequestObjectDecryptionError('failed');
  }
  const alg = header.alg;
  if (
    typeof alg !== 'string' ||
    !(REQUEST_OBJECT_ENCRYPTION_ALGS as readonly string[]).includes(alg) ||
    typeof header.enc !== 'string' ||
    !(REQUEST_OBJECT_ENCRYPTION_ENCS as readonly string[]).includes(header.enc) ||
    (header.kid !== undefined && typeof header.kid !== 'string')
  ) {
    throw new RequestObjectDecryptionError('unsupported');
  }
  if (!env.KEY_MANAGER) throw new RequestObjectDecryptionError('unavailable');

  const keyManager = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
  let key: { privatePEM?: string } | null;
  try {
    key = await keyManager.getRequestObjectDecryptionKeyRpc(header.kid);
  } catch {
    throw new RequestObjectDecryptionError('unavailable');
  }
  // A kid naming no current encryption key (or a signing key) is not one Authrim decrypts with.
  if (!key?.privatePEM) throw new RequestObjectDecryptionError('unsupported');

  try {
    const privateKey = await importPKCS8(key.privatePEM, alg);
    const { plaintext } = await compactDecrypt(jwe, privateKey, {
      keyManagementAlgorithms: [alg],
      contentEncryptionAlgorithms: [header.enc],
    });
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new RequestObjectDecryptionError('failed');
  }
}

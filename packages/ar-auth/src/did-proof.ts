/**
 * Pieces shared by DID login (did-auth.ts) and DID linking (did-link.ts): the proof algorithm
 * policy, the DID syntax check, and reading the JSON request body.
 */

import type { Context } from 'hono';
import {
  didLookupSubject,
  type DIDDocument,
  type Env,
  type VerificationMethod,
} from '@authrim/ar-lib-core';

/**
 * Allowed JWT algorithms for DID proofs.
 * - ES256/ES384/ES512: HAIP-compliant EC algorithms
 * - EdDSA: For Ed25519 keys (did:key)
 */
export const ALLOWED_DID_AUTH_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'EdDSA'];

/**
 * The algorithm to import a verification key with: the JWK's own `alg` when it has one, else the
 * proof header's. `alg` is optional in a JWK (and usually absent in did:web documents), but jose
 * will not import a key without one. Returns null when there is none, when it is outside the
 * allow-list, or when the JWK and the header name different algorithms; the caller treats that
 * like a failed signature check.
 */
export function resolveProofAlgorithm(
  jwk: { alg?: unknown },
  headerAlg: string | undefined
): string | null {
  if (jwk.alg !== undefined && typeof jwk.alg !== 'string') return null;
  if (jwk.alg !== undefined && headerAlg !== undefined && jwk.alg !== headerAlg) return null;
  const algorithm = jwk.alg ?? headerAlg;
  return algorithm !== undefined && ALLOWED_DID_AUTH_ALGORITHMS.includes(algorithm)
    ? algorithm
    : null;
}

/**
 * A DID (not a DID URL) the lookup directory can index. `didLookupSubject` is the single source of
 * truth: DID Core syntax (no path, query, fragment or whitespace), then the directory's limits.
 * DID login and DID linking must both use it, so that `did:key:zK`, `did:key:zK/a` and
 * `did:key:zK?x=1` cannot become separate identifiers for one key.
 */
export function isLinkableDid(did: unknown): did is string {
  if (typeof did !== 'string') return false;
  try {
    didLookupSubject(did);
    return true;
  } catch {
    return false;
  }
}

/** The JSON body when it is an object; null for malformed JSON or any other JSON value. */
export async function readJsonObject(
  c: Context<{ Bindings: Env }>
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The verification methods a DID document currently lists under `authentication`. An entry is
 * either a reference (the id of a method in `verificationMethod`) or an inline method. Used when
 * a challenge is issued and again when the proof is verified: a key that is only in
 * `verificationMethod`, or that was removed from `authentication` after the challenge was issued,
 * is not an authentication method.
 */
export function collectAuthenticationMethods(document: DIDDocument): VerificationMethod[] {
  const methods: VerificationMethod[] = [];
  for (const methodRef of document.authentication || []) {
    const methodId = typeof methodRef === 'string' ? methodRef : methodRef.id;
    const method = document.verificationMethod?.find((vm) => vm.id === methodId);
    if (method) {
      methods.push(method);
    } else if (typeof methodRef === 'object') {
      // Inline verification method
      methods.push(methodRef);
    }
  }
  return methods;
}

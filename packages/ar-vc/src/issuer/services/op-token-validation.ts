/**
 * Access tokens of the Authrim OP for the Credential Endpoint (HAIP issuance, design D-C, S3).
 *
 * A wallet that authenticated at the OP with a wallet attestation receives a DPoP-bound JWT
 * access token for the credential scope. This validator accepts such a token and nothing else:
 * the OP's issuer and keys, the credential issuer as the only audience, the credential scope, a
 * `cnf.jkt` binding and an `access` token use. It is separate from `validateVCIAccessToken`,
 * which accepts the pre-authorized Authorization Server's tokens only, so neither kind of token
 * can satisfy the other path.
 */

import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import type { Env } from '../../types';
import {
  buildDOInstanceName,
  createLogger,
  getRevocationStoreByJti,
  resolveIssuedTokenAccount,
  type Env as CoreEnv,
} from '@authrim/ar-lib-core';

const log = createLogger().module('VCI-OP-TOKEN');

const MAX_TOKEN_SIZE = 8 * 1024;
/** Kept small: the single-use record of a token outlives its expiry by more than this. */
const CLOCK_TOLERANCE_SECONDS = 5;
/** The OP signs access tokens with RS256 (Authrim's access and refresh tokens). */
const OP_ACCESS_TOKEN_ALGORITHMS = ['RS256'];
const JKT = /^[A-Za-z0-9_-]{43}$/u;

export interface OpTokenValidationInput {
  /** The credential issuer identifier, which is also the OP's issuer and the token's audience. */
  issuer: string;
  tenantId: string;
  /** Epoch ms; defaults to the clock. */
  now?: number;
}

export type OpTokenResult =
  | {
      valid: true;
      userId: string;
      tenantId: string;
      /** The wallet type that obtained the token (its `client_id`). */
      clientId: string;
      jti: string;
      /** The granted scopes. */
      scopes: string[];
      /** RFC 9449 thumbprint the token is bound to. */
      jkt: string;
      /** Epoch seconds. */
      expiresAt: number;
    }
  | { valid: false; error: string };

/** Validates an OP-issued, DPoP-bound access token for the credential endpoint. */
export async function validateOpAccessToken(
  env: Env,
  accessToken: string,
  input: OpTokenValidationInput
): Promise<OpTokenResult> {
  const fail = (error: string): OpTokenResult => ({ valid: false, error });
  try {
    if (!input.tenantId.trim()) return fail('Missing tenant');
    if (accessToken.length === 0 || accessToken.length > MAX_TOKEN_SIZE) {
      return fail('Token too large');
    }
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(accessToken);
    } catch {
      return fail('Invalid token format');
    }
    if (
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.typ !== 'JWT' ||
      typeof header.alg !== 'string' ||
      !OP_ACCESS_TOKEN_ALGORITHMS.includes(header.alg) ||
      'jwk' in header ||
      'x5c' in header ||
      'jku' in header ||
      'crit' in header
    ) {
      return fail('Invalid token header');
    }

    // Keys of this tenant's OP only; the token's own claims never name a key source.
    const stub = env.KEY_MANAGER.get(
      env.KEY_MANAGER.idFromName(`${input.tenantId}-v3`)
    ) as unknown as {
      getAllOIDCPublicKeysRpc(): Promise<JWK[]>;
    };
    const keys = await stub.getAllOIDCPublicKeysRpc();
    // The OP's RS256 signing keys only: not a PS256 key or an encryption key of the same set.
    const jwk = keys.find(
      (key) =>
        key.kid === header.kid &&
        key.kty === 'RSA' &&
        !('d' in key) &&
        (key.use === undefined || key.use === 'sig') &&
        (key.alg === undefined || key.alg === 'RS256')
    );
    if (!jwk) return fail('Unknown signing key');

    const { payload } = await jwtVerify(accessToken, await importJWK(jwk, header.alg), {
      issuer: input.issuer,
      audience: input.issuer,
      algorithms: OP_ACCESS_TOKEN_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: input.now === undefined ? undefined : new Date(input.now),
    });

    // The audience is exactly the credential issuer (a token for several targets is not ours).
    if (Array.isArray(payload.aud) && payload.aud.length !== 1) return fail('Invalid audience');
    if (payload.token_use !== 'access') return fail('Not an access token');
    // Only a grant of a wallet that authenticated with its client attestation (S2).
    if (payload.attestation_authenticated !== true) return fail('Not a wallet grant');
    if (typeof payload.sub !== 'string' || !payload.sub) return fail('Missing subject');
    if (typeof payload.client_id !== 'string' || !payload.client_id) return fail('Missing client');
    // The OP may give the wallet a transformed `sub` (identity mapping) and the account in a sealed
    // reference: the administrator is the account, not the presented value.
    const account = await resolveIssuedTokenAccount(
      env as unknown as CoreEnv,
      input.tenantId,
      payload.client_id,
      payload as Record<string, unknown>,
      false
    );
    if (!account.ok) return fail('Subject unavailable');
    if (typeof payload.jti !== 'string' || !payload.jti) return fail('Missing jti');
    if (typeof payload.client_id !== 'string' || !payload.client_id) return fail('Missing client');
    if (typeof payload.exp !== 'number') return fail('Missing expiry');
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
    const cnf = payload.cnf as { jkt?: unknown } | undefined;
    if (!cnf || typeof cnf.jkt !== 'string' || !JKT.test(cnf.jkt)) {
      return fail('Token is not DPoP-bound');
    }
    return {
      valid: true,
      userId: account.userId,
      tenantId: input.tenantId,
      clientId: payload.client_id,
      jti: payload.jti,
      scopes,
      jkt: cnf.jkt,
      expiresAt: payload.exp,
    };
  } catch (error) {
    log.warn('OP access token validation failed', { reason: (error as Error).name });
    return fail('Token validation failed');
  }
}

export type OpTokenRevocation = 'active' | 'revoked' | 'unknown';

/**
 * Whether the OP has revoked the token. Unlike the OP's own helper, an answer that cannot be had
 * is `unknown` (and refused by the caller), never `active`.
 */
export async function checkOpTokenRevocation(
  env: Env,
  jti: string,
  tenantId: string
): Promise<OpTokenRevocation> {
  const core = env as unknown as CoreEnv;
  if (!core.TOKEN_REVOCATION_STORE) return 'unknown';
  try {
    const { stub, instanceName } = await getRevocationStoreByJti(core, jti, tenantId);
    const response = await stub.fetch(`http://internal/check?jti=${encodeURIComponent(jti)}`);
    if (!response.ok) return 'unknown';
    const answer = ((await response.json()) as { revoked?: unknown }).revoked;
    if (answer === true) return 'revoked';
    // Only an explicit `false` is an answer; anything else is not one.
    if (answer !== false) return 'unknown';
    // Tokens of an older shard layout were recorded in the tenant-wide instance.
    const legacyName = buildDOInstanceName('token-revocation', tenantId);
    if (legacyName !== instanceName) {
      const legacy = core.TOKEN_REVOCATION_STORE.get(
        core.TOKEN_REVOCATION_STORE.idFromName(legacyName)
      );
      const legacyResponse = await legacy.fetch(
        `http://internal/check?jti=${encodeURIComponent(jti)}`
      );
      if (!legacyResponse.ok) return 'unknown';
      const legacyAnswer = ((await legacyResponse.json()) as { revoked?: unknown }).revoked;
      if (legacyAnswer === true) return 'revoked';
      return legacyAnswer === false ? 'active' : 'unknown';
    }
    return 'active';
  } catch {
    return 'unknown';
  }
}

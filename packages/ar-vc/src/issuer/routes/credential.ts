/**
 * Credential Issuance Route
 *
 * Issues credentials to the wallet.
 */

import { ensureVcSigningCertificate, type VcCertificateKeyManager } from '../services/issuer-ca';
import { isConfiguredShard, ShardConfigUnavailableError } from '../../utils/configured-shard';
import type { Context } from 'hono';
import type { Env } from '../../types';
import {
  createSDJWTVCWithSigner,
  type SDJWTVCCreateOptions,
  IssuedCredentialRepository,
  reserveCredentialStatusSlot,
  transitionCredentialStatus,
  getLogger,
  loadFeatureConfig,
  createCustomClaimSchemaResolver,
  SchemaLoader,
  ClaimNameResolver,
  ensureDatabaseAdapter,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveTenantMetadataContext,
  getTenantIdFromContext,
  type DatabaseAdapter,
  type Env as CoreEnv,
  loadWalletAllowlist,
  recordReplayJti,
  validateDPoPProof,
  verifyKeyAttestation,
} from '@authrim/ar-lib-core';
import { sha256Base64url } from '../../utils/crypto';
import { calculateJwkThumbprint } from '../../utils/jwk-thumbprint';
import { createVCConfigManager } from '../../utils/vc-config';
import type { JWTPayload } from 'jose';
import {
  decodeVCIProofNonce,
  validateVCIAccessToken,
  validateProofOfPossession,
  type TokenValidationResult,
} from '../services/token-validation';
import {
  checkOpTokenRevocation,
  validateOpAccessToken,
  type OpTokenResult,
} from '../services/op-token-validation';
import { getRequestIssuerUrl } from '../../request-identifiers';
import {
  getCredentialConfiguration,
  type CredentialSubjectKind,
} from '../credential-configurations';
import { invalidDpopTokenError, invalidTokenError, vciError } from '../oauth-errors';
import {
  getCredentialOfferStoreById,
  getCredentialOfferStoreByProofNonce,
} from '../../utils/credential-offer-sharding';

interface CredentialRequest {
  credential_configuration_id?: unknown;
  credential_identifier?: unknown;
  proofs?: {
    jwt?: unknown;
  };
  proof?: unknown;
}

interface CredentialResponse {
  credentials?: Array<{ credential: string }>;
  transaction_id?: string;
}

/**
 * Validate credential response format per OpenID4VCI spec
 *
 * @throws Error if response format is invalid
 */
function validateCredentialResponse(response: CredentialResponse): void {
  if (!response.credentials && !response.transaction_id) {
    throw new Error('Response must contain either credentials or transaction_id');
  }

  if (response.credentials !== undefined) {
    if (!Array.isArray(response.credentials) || response.credentials.length === 0) {
      throw new Error('credentials must be a non-empty array');
    }
    for (const entry of response.credentials) {
      const credential = entry?.credential;
      if (typeof credential !== 'string' || credential.length === 0) {
        throw new Error('credentials entries must carry a non-empty credential string');
      }
      if (credential.split('~')[0].split('.').length !== 3) {
        throw new Error('Invalid JWT format in credential');
      }
    }
  }

  // Validate transaction_id format if present
  if (response.transaction_id !== undefined) {
    if (typeof response.transaction_id !== 'string' || response.transaction_id.length === 0) {
      throw new Error('transaction_id must be a non-empty string');
    }
  }
}

/**
 * POST /vci/credential
 *
 * Issues a credential to the wallet.
 */
export async function credentialRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-ISSUER');
  // The Credential Issuer identifier: credential `iss`, proof `aud` and token `aud`.
  const requestIssuerUrl = getRequestIssuerUrl(c);
  let nonceReservation:
    | { stub: DurableObjectStub; nonceId: string; tenantId: string; reservationId: string }
    | undefined;
  // Set once the offer's single issuance is claimed (D4 step 1) and cleared when it completes.
  let issuance:
    | { stub: DurableObjectStub; offerId: string; tenantId: string; accessTokenJti: string }
    | undefined;
  // The `issued_credentials` row recorded before signing; cleared once the credential is delivered.
  let pendingCredential: { adapter: DatabaseAdapter; tenantId: string; id: string } | undefined;

  /**
   * Ends a request that will not deliver a credential: releases the proof nonce, fails the
   * issuance (never back to claimable) and revokes a recorded credential. Best effort, in order of
   * importance for the offer: the issuance stays `issuing` only until its lease expires.
   */
  const abandon = async (): Promise<boolean> => {
    let compensated = true;
    if (nonceReservation) {
      const reservation = nonceReservation;
      nonceReservation = undefined;
      await reservation.stub
        .fetch(
          new Request('https://internal/nonce/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: reservation.nonceId,
              tenantId: reservation.tenantId,
              reservationId: reservation.reservationId,
            }),
          })
        )
        .then((released) => {
          if (!released.ok) compensated = false;
        })
        .catch(() => {
          compensated = false;
        });
    }
    if (pendingCredential) {
      const credential = pendingCredential;
      pendingCredential = undefined;
      // Through the one status write path, so the list entry is set together with the row.
      await transitionCredentialStatus(credential.adapter, {
        tenantId: credential.tenantId,
        credentialId: credential.id,
        from: ['pending', 'active'],
        to: 'revoked',
      })
        .then((result) => {
          // A concurrent writer won the row: it may still be pending.
          if (result?.outcome === 'conflict') compensated = false;
        })
        .catch(() => {
          compensated = false;
        });
    }
    if (issuance) {
      const claimed = issuance;
      issuance = undefined;
      await callOfferStore(claimed.stub, '/issuance/fail', {
        id: claimed.offerId,
        tenantId: claimed.tenantId,
        accessTokenJti: claimed.accessTokenJti,
        now: Date.now(),
      }).catch(() => {
        compensated = false;
      });
    }
    return compensated;
  };

  /**
   * A client-visible refusal after the request touched state. If a compensation did not complete,
   * the outcome is unknown and is answered 503 (the replication writer keeps its permit).
   */
  const refuse = async (respond: () => Response): Promise<Response> =>
    (await abandon()) ? respond() : vciError(c, 503, 'temporarily_unavailable');

  try {
    // Verify access token: a Bearer token of the pre-authorized Authorization Server, or a
    // DPoP-bound token of the Authrim OP (HAIP). The two never satisfy each other's path.
    const authHeader = c.req.header('Authorization');
    const isOpPath = authHeader?.startsWith('DPoP ') === true;
    if (!authHeader?.startsWith('Bearer ') && !isOpPath) {
      return invalidTokenError(c);
    }

    const accessToken = authHeader.substring(isOpPath ? 5 : 7);

    let opToken: Extract<OpTokenResult, { valid: true }> | undefined;
    let tokenResult: TokenValidationResult;
    if (isOpPath) {
      const validated = await validateOpAccessToken(c.env, accessToken, {
        issuer: requestIssuerUrl,
        tenantId: getTenantIdFromContext(c),
      });
      if (!validated.valid) return invalidDpopTokenError(c, 'invalid_token');
      const revocation = await checkOpTokenRevocation(c.env, validated.jti, validated.tenantId);
      if (revocation === 'revoked') return invalidDpopTokenError(c, 'invalid_token');
      // No state was written yet; the wallet retries. Below 500 so the outer writer settles.
      if (revocation === 'unknown') return vciError(c, 424, 'temporarily_unavailable');
      opToken = validated;
      // The proof is for this request and this token, made with the key the token is bound to.
      const proof = c.req.header('DPoP');
      const dpop = proof
        ? await validateDPoPProof(
            proof,
            'POST',
            // The URL the wallet called, without query or fragment (RFC 9449 §4.3).
            c.req.url.split(/[?#]/u)[0],
            accessToken,
            c.env as unknown as CoreEnv,
            validated.clientId,
            validated.tenantId
          )
        : null;
      // The replay store failing is not a bad proof: the outcome of its write is unknown.
      if (dpop && !dpop.valid && dpop.error === 'server_error') {
        return vciError(c, 503, 'temporarily_unavailable');
      }
      if (!dpop?.valid || !dpop.jkt || dpop.jkt !== validated.jkt) {
        return invalidDpopTokenError(c, 'invalid_dpop_proof');
      }
      tokenResult = {
        valid: true,
        userId: validated.userId,
        tenantId: validated.tenantId,
        jti: validated.jti,
      };
    } else {
      // Validate access token and extract user/credential info
      tokenResult = await validateVCIAccessToken(
        c.env,
        accessToken,
        requestIssuerUrl,
        getTenantIdFromContext(c)
      );
      if (!tokenResult.valid) {
        return invalidTokenError(c);
      }
    }

    // SECURITY: tenantId comes from the signed access token, which was validated above.
    if (!tokenResult.userId || !tokenResult.tenantId || !tokenResult.jti) {
      return invalidTokenError(c);
    }
    const tenantId = tokenResult.tenantId;

    let body: CredentialRequest;
    try {
      body = await c.req.json<CredentialRequest>();
    } catch {
      return vciError(c, 400, 'invalid_credential_request', 'Request body must be JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return vciError(c, 400, 'invalid_credential_request', 'Request body must be a JSON object');
    }

    // No credential_identifiers are issued (the token response carries no authorization_details).
    if (body.credential_identifier !== undefined) {
      return vciError(
        c,
        400,
        'invalid_credential_request',
        'credential_identifier is not supported; use credential_configuration_id'
      );
    }
    if (typeof body.credential_configuration_id !== 'string') {
      return vciError(
        c,
        400,
        'invalid_credential_request',
        'credential_configuration_id is required'
      );
    }
    const configuration = getCredentialConfiguration(body.credential_configuration_id);
    if (!configuration) {
      return vciError(c, 400, 'unknown_credential_configuration');
    }
    if (opToken) {
      // The OP flow issues the configurations that declare a HAIP key attestation, to the scope
      // the token was granted.
      if (!configuration.haipKeyAttestation || !opToken.scopes.includes(configuration.scope)) {
        return vciError(
          c,
          400,
          'invalid_credential_request',
          'credential_configuration_id is not authorized by the access token'
        );
      }
    } else if (configuration.id !== tokenResult.credentialConfigurationId) {
      return vciError(
        c,
        400,
        'invalid_credential_request',
        'credential_configuration_id is not authorized by the access token'
      );
    }
    // The pre-Final single `proof` parameter is not accepted next to `proofs`.
    if (body.proof !== undefined) {
      return vciError(c, 400, 'invalid_credential_request', 'Use proofs instead of proof');
    }
    const proofJwts = body.proofs?.jwt;
    if (!Array.isArray(proofJwts) || proofJwts.length !== 1 || typeof proofJwts[0] !== 'string') {
      return vciError(c, 400, 'invalid_proof', 'Exactly one jwt proof is required');
    }
    const proofJwt = proofJwts[0];
    const expectedNonce = decodeVCIProofNonce(proofJwt);
    if (!expectedNonce) {
      return vciError(c, 400, 'invalid_nonce');
    }
    const expectedAudience = requestIssuerUrl;

    let holderBinding = tokenResult.holderBinding;
    const proofResult = await validateProofOfPossession(
      c.env,
      { proof_type: 'jwt', jwt: proofJwt },
      expectedNonce,
      expectedAudience
    );
    if (!proofResult.valid) {
      return vciError(c, 400, 'invalid_proof');
    }
    if (proofResult.holderPublicKey && !holderBinding) holderBinding = proofResult.holderPublicKey;

    // A proof that names a client names the wallet that obtained the token.
    if (opToken) {
      const proofIssuer = decodeProofIssuer(proofJwt);
      if (proofIssuer !== undefined && proofIssuer !== opToken.clientId) {
        return vciError(c, 400, 'invalid_proof');
      }
    }

    // HAIP: the holder key must be attested by a provider the wallet type's allowlist entry trusts,
    // bound to this request's nonce and strong enough for the configuration.
    if (opToken && configuration.haipKeyAttestation) {
      const attestation = decodeKeyAttestationHeader(proofJwt);
      let anchors: Awaited<
        ReturnType<typeof loadWalletAllowlist>
      >['entries'][number]['keyAttestationRoots'] = [];
      try {
        // Read now, not copied into the token: a wallet type removed since the token was issued
        // can no longer obtain a credential.
        const entry = (
          await loadWalletAllowlist(c.env as unknown as CoreEnv, tenantId)
        ).entries.find((candidate) => candidate.enabled && candidate.clientId === opToken.clientId);
        anchors = entry?.keyAttestationRoots ?? [];
      } catch {
        return vciError(c, 424, 'temporarily_unavailable');
      }
      const attested =
        attestation && proofResult.holderPublicKey
          ? await verifyKeyAttestation({
              jwt: attestation,
              anchors,
              now: Math.floor(Date.now() / 1000),
              expectedNonce,
              expectedAudience: requestIssuerUrl,
              proofKey: proofResult.holderPublicKey,
              requiredKeyStorage: configuration.haipKeyAttestation.requiredKeyStorage,
            })
          : null;
      if (!attested?.ok) {
        log.warn('Key attestation refused', { reason: attested?.error ?? 'missing' });
        return vciError(c, 400, 'invalid_proof');
      }
    }

    let nonceStore: ReturnType<typeof getCredentialOfferStoreByProofNonce>;
    try {
      nonceStore = getCredentialOfferStoreByProofNonce(c.env, expectedNonce, tokenResult.tenantId);
    } catch {
      return vciError(c, 400, 'invalid_nonce');
    }
    if (!(await isConfiguredShard(c.env, tokenResult.tenantId, nonceStore.resolution))) {
      return vciError(c, 400, 'invalid_nonce');
    }
    const reserveResponse = await nonceStore.stub.fetch(
      new Request('https://internal/nonce/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: nonceStore.nonceId,
          tenantId: tokenResult.tenantId,
          nonceHash: await sha256Base64url(expectedNonce),
          proofFingerprint: await sha256Base64url(proofJwt),
          accessTokenJti: tokenResult.jti,
          now: Date.now(),
        }),
      })
    );
    // A store that did not answer is an unknown outcome; only an explicit refusal is a bad nonce.
    if (!reserveResponse.ok) return vciError(c, 503, 'temporarily_unavailable');
    const reserveResult = (await reserveResponse.json()) as {
      reserved: boolean;
      reservationId?: string;
    };
    if (!reserveResult?.reserved || !reserveResult.reservationId) {
      return vciError(c, 400, 'invalid_nonce');
    }
    nonceReservation = {
      stub: nonceStore.stub,
      nonceId: nonceStore.nonceId,
      tenantId: tokenResult.tenantId,
      reservationId: reserveResult.reservationId,
    };

    const isAdminCredential = configuration.subjectKind === 'admin';
    const vcConfig = createVCConfigManager(c.env);
    // An admin credential is always holder-bound (design D3), whatever the tenant configures.
    if ((isAdminCredential || (await vcConfig.isHolderBindingRequired())) && !holderBinding) {
      return refuse(() => vciError(c, 400, 'invalid_proof'));
    }

    // The grant behind the issuance. A pre-authorized token names an offer, which is claimed in the
    // offer store; an OP token has no offer, and its single issuance is the first use of its jti.
    let offerStore: DurableObjectStub | undefined;
    let offerId: string | undefined;
    let offer: { claims: Record<string, unknown>; subjectKind: CredentialSubjectKind };
    if (opToken) {
      offer = { claims: {}, subjectKind: 'admin' };
    } else {
      if (!tokenResult.offerId) throw new Error('vci_access_token_missing_offer_id');
      offerId = tokenResult.offerId;
      const offerShard = getCredentialOfferStoreById(c.env, offerId, tenantId);
      // The offer ID is signed, but its shard may no longer be configured (a jurisdiction change
      // refuses earlier offers): the token is no longer usable.
      if (!(await isConfiguredShard(c.env, tenantId, offerShard.resolution))) {
        return refuse(() => invalidTokenError(c));
      }
      offerStore = offerShard.stub;
      offer = await loadOffer(offerStore, {
        offerId,
        tenantId,
        userId: tokenResult.userId,
        credentialConfigurationId: configuration.id,
      });
    }
    // An end-user offer can never yield an admin credential, nor an admin offer an end-user one.
    if (offer.subjectKind !== configuration.subjectKind) {
      return refuse(() => vciError(c, 400, 'invalid_credential_request'));
    }

    // D4 step 1: exactly one issuance per grant. A concurrent, repeated or later request —
    // including one with the same access token — loses here and gets no credential.
    if (offerStore && offerId) {
      const claimResult = await callOfferStore<{ claimed: boolean }>(
        offerStore,
        '/issuance/claim',
        { id: offerId, tenantId, accessTokenJti: tokenResult.jti, now: Date.now() }
      );
      if (!claimResult.claimed) {
        return refuse(() => vciError(c, 400, 'invalid_credential_request'));
      }
      issuance = { stub: offerStore, offerId, tenantId, accessTokenJti: tokenResult.jti };
    } else if (opToken) {
      // Kept until the token expires; a failed issuance burns the token, and the wallet signs in
      // again for a new one.
      const outcome = await recordReplayJti(c.env as unknown as CoreEnv, {
        tenantId,
        shardKey: opToken.jti,
        jti: `vci-op-token:${opToken.jti}`,
        issuedAt: Math.floor(Date.now() / 1000),
        // Past the last moment the token is accepted (its expiry plus the validator's tolerance).
        ttlSeconds: Math.max(120, opToken.expiresAt - Math.floor(Date.now() / 1000) + 120),
      });
      if (outcome !== 'recorded') {
        return refuse(() => vciError(c, 400, 'invalid_credential_request'));
      }
    }

    // D4 step 2: admin credentials never resolve end-user custom claims; theirs are built below
    // from the eligibility result.
    let claims: Record<string, unknown> = isAdminCredential ? {} : { ...offer.claims };

    // Custom Claim Schema: merge is_vc_claim=1 claims + collect PII names for SD-JWT
    let vcPiiClaimNames: string[] = [];
    if (!isAdminCredential) {
      try {
        const ccFeatureConfig = await loadFeatureConfig(
          c.env as unknown as CoreEnv,
          tokenResult.tenantId
        );
        if (ccFeatureConfig.enabled && tokenResult.userId) {
          const runtimeSources = await resolveCustomClaimRuntimeSourcesFromEnv(
            c.env as unknown as CoreEnv,
            tokenResult.tenantId,
            { accountId: `account:${tokenResult.userId}` }
          );
          const ccResolver = createCustomClaimSchemaResolver(
            runtimeSources.schemaDb,
            runtimeSources.piiDb,
            c.env.AUTHRIM_CONFIG || null,
            ccFeatureConfig
          );
          const vcResult = await ccResolver.resolveClaimsForTarget(
            tokenResult.tenantId,
            tokenResult.userId,
            [],
            'vc'
          );
          Object.assign(claims, vcResult.claims);

          // Collect PII claim names for SD-JWT selective disclosure
          if (vcResult.pii_accessed) {
            const schemaLoader = new SchemaLoader(
              runtimeSources.schemaDb,
              c.env.AUTHRIM_CONFIG || null
            );
            const allSchemas = await schemaLoader.loadActiveSchemas(tokenResult.tenantId);
            const nameResolver = new ClaimNameResolver();
            vcPiiClaimNames = allSchemas
              .filter((s) => s.is_vc_claim === 1 && s.is_pii === 1)
              .map((s) => nameResolver.resolve(s))
              .filter((name) => name in vcResult.claims);
          }
        }
      } catch (ccError) {
        log.error('Failed to resolve VC custom claims', {}, ccError as Error);
      }
    }

    const vct = configuration.vct;

    // Initialize repositories
    const tenantMetadata = await resolveTenantMetadataContext(
      c.env as unknown as CoreEnv,
      tokenResult.tenantId
    );
    const adapter = ensureDatabaseAdapter(tenantMetadata.coreDb, 'vc-issuer-core');
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);
    const holderJkt = holderBinding ? await calculateJwkThumbprint(holderBinding) : null;

    // The signed `exp`, recorded with the credential so a list entry's lifetime is known.
    const expiresAt = Math.floor(Date.now() / 1000) + configuration.validitySeconds;

    // OP path: a subject that is not an eligible administrator is refused before a status list
    // slot is spent (the check below stays: eligibility may change while the credential is made).
    if (opToken && isAdminCredential) {
      const early = await c.env.ADMIN_CREDENTIAL_ELIGIBILITY?.checkAdminCredentialEligibility({
        tenantId,
        adminUserId: tokenResult.userId,
      });
      if (!early?.eligible) {
        return refuse(() => vciError(c, 400, 'invalid_credential_request'));
      }
    }

    // D4 step 3: reserve an unpredictable status list slot and record the credential as `pending`
    // before anything is signed, so a revocation can always find it.
    const reserved = await reserveCredentialStatusSlot(adapter, {
      tenantId,
      userId: tokenResult.userId,
      credentialType: vct,
      format: 'dc+sd-jwt',
      holderBinding,
      expiresAt,
    });
    pendingCredential = { adapter, tenantId, id: reserved.credentialId };

    // D4 step 4 (admin): the administrator must still be eligible right now. A missing binding
    // counts as ineligible, so admin credentials are never issued without the check.
    if (isAdminCredential) {
      const eligibility = await c.env.ADMIN_CREDENTIAL_ELIGIBILITY?.checkAdminCredentialEligibility(
        {
          tenantId,
          adminUserId: tokenResult.userId,
        }
      );
      if (!eligibility?.eligible) {
        return refuse(() => vciError(c, 400, 'invalid_credential_request'));
      }
      claims = {
        sub: tokenResult.userId,
        tenant_id: tenantId,
        ...(typeof eligibility.email === 'string' && eligibility.email
          ? { email: eligibility.email }
          : {}),
        ...(typeof eligibility.name === 'string' && eligibility.name
          ? { name: eligibility.name }
          : {}),
      };
    }

    // Token Status List reference (SD-JWT VC `status.status_list`)
    const status = {
      status_list: {
        idx: reserved.index,
        uri: `${requestIssuerUrl}/vci/status-lists/${reserved.listId}`,
      },
    };

    // Create SD-JWT VC with the status reference
    const options: SDJWTVCCreateOptions = {
      vct,
      selectiveDisclosureClaims: [
        ...new Set([...configuration.selectivelyDisclosableClaims, ...vcPiiClaimNames]),
      ],
      holderBinding,
      expiresAt,
      status,
    };

    // D4 step 5: sign.
    const sdjwtvc = await createSDJWTVCWithSigner(
      claims,
      requestIssuerUrl,
      (payload) =>
        signSDJWTIssuer(c.env, tenantId, payload, opToken ? { requireX5c: true } : undefined),
      options
    );

    const response: CredentialResponse = {
      credentials: [{ credential: sdjwtvc.combined }],
    };

    // Validate response format before returning
    validateCredentialResponse(response);

    // D4 step 6: `pending → active` only if the row is still `pending`. A revocation that
    // happened while signing leaves no credential behind.
    const activated = await issuedCredentialRepo.updateStatusIfCurrent(
      tenantId,
      reserved.credentialId,
      'pending',
      'active'
    );
    if (!activated) {
      return refuse(() => vciError(c, 400, 'invalid_credential_request'));
    }

    const completeResponse = await nonceReservation.stub.fetch(
      new Request('https://internal/nonce/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: nonceReservation.nonceId,
          tenantId: nonceReservation.tenantId,
          reservationId: nonceReservation.reservationId,
        }),
      })
    );
    const completion = completeResponse.ok
      ? ((await completeResponse.json()) as { completed: boolean })
      : null;
    if (!completion?.completed) throw new Error('vci_nonce_completion_failed');
    nonceReservation = undefined;

    // D4 step 7: `issuing → issued`, remembering the holder key for the console's confirmation.
    if (offerStore && offerId) {
      const issued = await callOfferStore<{ completed: boolean }>(
        offerStore,
        '/issuance/complete',
        {
          id: offerId,
          tenantId,
          accessTokenJti: tokenResult.jti,
          holderJkt,
          now: Date.now(),
        }
      );
      if (!issued.completed) throw new Error('vci_issuance_completion_failed');
    }
    issuance = undefined;
    pendingCredential = undefined;
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(response);
  } catch (error) {
    const compensated = await abandon();
    log.error('Credential issuance failed', {}, error as Error);
    // Refusals known before anything was signed. When every compensation completed they are
    // answered below 500, so the replication writer settles its permit; otherwise the outcome is
    // unknown and stays 5xx.
    const known =
      error instanceof ShardConfigUnavailableError ||
      (error instanceof Error &&
        (error.message.includes('x5c_required') ||
          error.message.includes('vc_issuer_key_retention_cap_reached')));
    if (known) {
      return compensated
        ? vciError(c, 424, 'temporarily_unavailable')
        : vciError(c, 503, 'temporarily_unavailable');
    }
    return vciError(c, 500, 'server_error');
  }
}

/** The `iss` of a proof JWT (not verified here): undefined when absent, null when unreadable. */
function decodeProofIssuer(proofJwt: string): string | undefined | null {
  try {
    const part = proofJwt.split('.')[1] ?? '';
    const padded = part.replace(/-/gu, '+').replace(/_/gu, '/');
    const payload = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
      iss?: unknown;
    };
    if (payload.iss === undefined) return undefined;
    return typeof payload.iss === 'string' ? payload.iss : null;
  } catch {
    return null;
  }
}

/** The `key_attestation` header of a proof JWT (not verified here). */
function decodeKeyAttestationHeader(proofJwt: string): string | null {
  try {
    const part = proofJwt.split('.')[0] ?? '';
    const padded = part.replace(/-/gu, '+').replace(/_/gu, '/');
    const header = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
      key_attestation?: unknown;
    };
    return typeof header.key_attestation === 'string' ? header.key_attestation : null;
  } catch {
    return null;
  }
}

async function callOfferStore<T>(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await stub.fetch(
    new Request(`https://internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  if (!response.ok) throw new Error(`vci_offer_store_${path.replace(/\W+/g, '_')}_failed`);
  return (await response.json()) as T;
}

async function loadOffer(
  stub: DurableObjectStub,
  input: {
    offerId: string;
    tenantId: string;
    userId: string;
    credentialConfigurationId: string;
  }
): Promise<{ claims: Record<string, unknown>; subjectKind: CredentialSubjectKind }> {
  const response = await stub.fetch(
    new Request(
      `https://internal/get?id=${encodeURIComponent(input.offerId)}&tenant_id=${encodeURIComponent(input.tenantId)}`
    )
  );
  if (!response.ok) throw new Error('vci_offer_not_found');
  const offer = (await response.json()) as {
    userId: string;
    credentialConfigurationId: string;
    claims: Record<string, unknown>;
    // Absent only on a store that predates the issuance upgrade: those offers are end-user.
    subjectKind?: CredentialSubjectKind;
    status: string;
    expiresAt: number;
  };
  if (
    offer.status !== 'consumed' ||
    offer.expiresAt <= Date.now() ||
    offer.userId !== input.userId ||
    offer.credentialConfigurationId !== input.credentialConfigurationId
  ) {
    throw new Error('vci_offer_binding_mismatch');
  }
  return { claims: { ...offer.claims }, subjectKind: offer.subjectKind ?? 'end_user' };
}

/**
 * Sign within KeyManager so private key material never crosses the DO boundary.
 */
async function signSDJWTIssuer(
  env: Env,
  tenantId: string,
  payload: JWTPayload,
  options?: { requireX5c: boolean }
): Promise<string> {
  const doId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const stub = env.KEY_MANAGER.get(doId) as unknown as VcCertificateKeyManager & {
    signSDJWTIssuerRpc(
      input: JWTPayload,
      options?: { requireX5c: boolean }
    ): Promise<{ token: string }>;
  };
  // HAIP `x5c`: give the signing key its issuer certificate first. Never blocks the issuance.
  if (typeof payload.iss === 'string') {
    await ensureVcSigningCertificate(
      env,
      stub,
      payload.iss,
      tenantId,
      Date.now(),
      typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
    );
  }
  // A fresh stub: if the certificate calls broke the first one, the signing must not share its fate.
  const signer = env.KEY_MANAGER.get(doId) as unknown as typeof stub;
  return (
    await (options
      ? signer.signSDJWTIssuerRpc(payload, options)
      : signer.signSDJWTIssuerRpc(payload))
  ).token;
}

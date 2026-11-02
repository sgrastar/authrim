/**
 * Credential Issuance Route
 *
 * Issues credentials to the wallet.
 */

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
} from '@authrim/ar-lib-core';
import { sha256Base64url } from '../../utils/crypto';
import { calculateJwkThumbprint } from '../../utils/jwk-thumbprint';
import { createVCConfigManager } from '../../utils/vc-config';
import type { JWTPayload } from 'jose';
import {
  decodeVCIProofNonce,
  validateVCIAccessToken,
  validateProofOfPossession,
} from '../services/token-validation';
import { getRequestIssuerUrl } from '../../request-identifiers';
import {
  getCredentialConfiguration,
  type CredentialSubjectKind,
} from '../credential-configurations';
import { invalidTokenError, vciError } from '../oauth-errors';
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
  const abandon = async (): Promise<void> => {
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
        .catch(() => undefined);
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
      }).catch(() => undefined);
    }
    if (issuance) {
      const claimed = issuance;
      issuance = undefined;
      await callOfferStore(claimed.stub, '/issuance/fail', {
        id: claimed.offerId,
        tenantId: claimed.tenantId,
        accessTokenJti: claimed.accessTokenJti,
        now: Date.now(),
      }).catch(() => undefined);
    }
  };

  try {
    // Verify access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return invalidTokenError(c);
    }

    const accessToken = authHeader.substring(7);

    // Validate access token and extract user/credential info
    const tokenResult = await validateVCIAccessToken(
      c.env,
      accessToken,
      requestIssuerUrl,
      getTenantIdFromContext(c)
    );

    if (!tokenResult.valid) {
      return invalidTokenError(c);
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
    if (configuration.id !== tokenResult.credentialConfigurationId) {
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

    let nonceStore: ReturnType<typeof getCredentialOfferStoreByProofNonce>;
    try {
      nonceStore = getCredentialOfferStoreByProofNonce(c.env, expectedNonce, tokenResult.tenantId);
    } catch {
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
    const reserveResult = reserveResponse.ok
      ? ((await reserveResponse.json()) as { reserved: boolean; reservationId?: string })
      : null;
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
      await abandon();
      return vciError(c, 400, 'invalid_proof');
    }

    if (!tokenResult.offerId) throw new Error('vci_access_token_missing_offer_id');
    const offerId = tokenResult.offerId;
    const offerStore = getCredentialOfferStoreById(c.env, offerId, tenantId).stub;
    const offer = await loadOffer(offerStore, {
      offerId,
      tenantId,
      userId: tokenResult.userId,
      credentialConfigurationId: configuration.id,
    });
    // An end-user offer can never yield an admin credential, nor an admin offer an end-user one.
    if (offer.subjectKind !== configuration.subjectKind) {
      await abandon();
      return vciError(c, 400, 'invalid_credential_request');
    }

    // D4 step 1: exactly one issuance per offer. A concurrent, repeated or later request —
    // including one with the same access token — loses here and gets no credential.
    const claimResult = await callOfferStore<{ claimed: boolean }>(offerStore, '/issuance/claim', {
      id: offerId,
      tenantId,
      accessTokenJti: tokenResult.jti,
      now: Date.now(),
    });
    if (!claimResult.claimed) {
      await abandon();
      return vciError(c, 400, 'invalid_credential_request');
    }
    issuance = { stub: offerStore, offerId, tenantId, accessTokenJti: tokenResult.jti };

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
        await abandon();
        return vciError(c, 400, 'invalid_credential_request');
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
      (payload) => signSDJWTIssuer(c.env, tenantId, payload),
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
      await abandon();
      return vciError(c, 400, 'invalid_credential_request');
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
    const issued = await callOfferStore<{ completed: boolean }>(offerStore, '/issuance/complete', {
      id: offerId,
      tenantId,
      accessTokenJti: tokenResult.jti,
      holderJkt,
      now: Date.now(),
    });
    if (!issued.completed) throw new Error('vci_issuance_completion_failed');
    issuance = undefined;
    pendingCredential = undefined;
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(response);
  } catch (error) {
    await abandon();
    log.error('Credential issuance failed', {}, error as Error);
    return vciError(c, 500, 'server_error');
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
async function signSDJWTIssuer(env: Env, tenantId: string, payload: JWTPayload): Promise<string> {
  const doId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const stub = env.KEY_MANAGER.get(doId) as unknown as {
    signSDJWTIssuerRpc(input: JWTPayload): Promise<{ token: string }>;
  };
  return (await stub.signSDJWTIssuerRpc(payload)).token;
}

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
  D1StatusListRepository,
  StatusListManager,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  loadFeatureConfig,
  createCustomClaimSchemaResolver,
  SchemaLoader,
  ClaimNameResolver,
  ensureDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveUserStoreRuntimeSourcesFromEnv,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import { sha256Base64url } from '../../utils/crypto';
import { createVCConfigManager } from '../../utils/vc-config';
import type { JWTPayload } from 'jose';
import {
  decodeVCIProofNonce,
  validateVCIAccessToken,
  validateProofOfPossession,
} from '../services/token-validation';
import { getRequestIssuerIdentifier, getRequestIssuerUrl } from '../../request-identifiers';
import { getCredentialOfferStoreByProofNonce } from '../../utils/credential-offer-sharding';
import { getCredentialOfferStoreById } from '../../utils/credential-offer-sharding';

interface CredentialRequest {
  credential_configuration_id: string;
  proofs: {
    jwt?: string[];
  };
}

interface CredentialResponse {
  credentials?: string[];
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
    for (const credential of response.credentials) {
      if (typeof credential !== 'string' || credential.length === 0) {
        throw new Error('credentials entries must be non-empty strings');
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
  const requestIssuerIdentifier = getRequestIssuerIdentifier(c);
  const requestIssuerUrl = getRequestIssuerUrl(c);
  let nonceReservation:
    | { stub: DurableObjectStub; nonceId: string; tenantId: string; reservationId: string }
    | undefined;
  try {
    // Verify access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
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
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    // Ensure required fields are present
    // SECURITY: tenantId comes from the signed access token, which was validated above.
    // The token signature verification ensures these claims cannot be tampered with.
    // This is the standard OAuth 2.0 / OpenID4VCI security model.
    if (!tokenResult.userId || !tokenResult.tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }
    const tenantId = tokenResult.tenantId;

    const body = await c.req.json<CredentialRequest>();

    if (
      !body.credential_configuration_id ||
      body.credential_configuration_id !== tokenResult.credentialConfigurationId
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VC_UNSUPPORTED_FORMAT);
    }
    const proofJwts = body.proofs?.jwt;
    if (!Array.isArray(proofJwts) || proofJwts.length !== 1 || typeof proofJwts[0] !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VC_INVALID_PROOF);
    }
    const proofJwt = proofJwts[0];
    const expectedNonce = decodeVCIProofNonce(proofJwt);
    if (!expectedNonce || !tokenResult.jti) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'invalid_nonce' }, 400);
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
      return createErrorResponse(c, AR_ERROR_CODES.VC_INVALID_PROOF);
    }
    if (proofResult.holderPublicKey && !holderBinding) holderBinding = proofResult.holderPublicKey;

    let nonceStore: ReturnType<typeof getCredentialOfferStoreByProofNonce>;
    try {
      nonceStore = getCredentialOfferStoreByProofNonce(c.env, expectedNonce, tokenResult.tenantId);
    } catch {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'invalid_nonce' }, 400);
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
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'invalid_nonce' }, 400);
    }
    nonceReservation = {
      stub: nonceStore.stub,
      nonceId: nonceStore.nonceId,
      tenantId: tokenResult.tenantId,
      reservationId: reserveResult.reservationId,
    };

    const vcConfig = createVCConfigManager(c.env);
    if ((await vcConfig.isHolderBindingRequired()) && !holderBinding) {
      return createErrorResponse(c, AR_ERROR_CODES.VC_INVALID_PROOF);
    }

    // Get user claims from token result
    const claims = await loadOfferClaims(c.env, {
      offerId: tokenResult.offerId,
      tenantId: tokenResult.tenantId,
      userId: tokenResult.userId,
      credentialConfigurationId: body.credential_configuration_id,
    });

    // Custom Claim Schema: merge is_vc_claim=1 claims + collect PII names for SD-JWT
    let vcPiiClaimNames: string[] = [];
    try {
      const ccFeatureConfig = await loadFeatureConfig(c.env.AUTHRIM_CONFIG || null);
      if (ccFeatureConfig.enabled && tokenResult.userId) {
        const authAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
          c.env,
          'vc-issuer-core',
          { tenantId: tokenResult.tenantId }
        );
        const runtimeSources = await resolveUserStoreRuntimeSourcesFromEnv(
          c.env,
          tokenResult.tenantId
        );
        const piiAdapter = ensureDatabaseAdapter(
          runtimeSources.piiDb ?? runtimeSources.coreDb,
          'vc-issuer-pii'
        );
        const ccResolver = createCustomClaimSchemaResolver(
          authAdapter,
          piiAdapter,
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
          const schemaLoader = new SchemaLoader(authAdapter, c.env.AUTHRIM_CONFIG || null);
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

    // Get issuer key from KeyManager
    const vct = resolveVct(body.credential_configuration_id);

    // Initialize repositories
    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(c.env, 'vc-issuer-core', {
      tenantId: tokenResult.tenantId,
    });
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);

    // Allocate status list index for revocation tracking
    const { listId, listInternalId, index } = await statusListManager.allocateIndex(
      tokenResult.tenantId,
      'revocation'
    );

    // Add credentialStatus claim (W3C VC compatible format)
    const credentialStatus = {
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: index,
      statusListCredential: `${requestIssuerUrl}/vci/status-lists/${listId}`,
    };

    // Create SD-JWT VC with credentialStatus
    const options: SDJWTVCCreateOptions = {
      vct,
      selectiveDisclosureClaims: getSDClaims(vct, vcPiiClaimNames),
      holderBinding,
    };

    const sdjwtvc = await createSDJWTVCWithSigner(
      { ...claims, credentialStatus },
      requestIssuerIdentifier,
      (payload) => signSDJWTIssuer(c.env, tenantId, payload),
      options
    );

    const response: CredentialResponse = {
      credentials: [sdjwtvc.combined],
    };

    // Validate response format before returning
    validateCredentialResponse(response);

    // Store issued credential record with status list info
    await issuedCredentialRepo.createCredential({
      tenant_id: tokenResult.tenantId,
      user_id: tokenResult.userId,
      credential_type: vct,
      format: 'dc+sd-jwt',
      claims: {}, // Don't store actual claims
      status: 'active',
      status_list_id: listId,
      status_list_internal_id: listInternalId,
      status_list_index: index,
      holder_binding: holderBinding ? holderBinding : null,
    });

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
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(response);
  } catch (error) {
    if (nonceReservation) {
      await nonceReservation.stub
        .fetch(
          new Request('https://internal/nonce/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: nonceReservation.nonceId,
              tenantId: nonceReservation.tenantId,
              reservationId: nonceReservation.reservationId,
            }),
          })
        )
        .catch(() => undefined);
    }
    log.error('Credential issuance failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

async function loadOfferClaims(
  env: Env,
  input: {
    offerId?: string;
    tenantId: string;
    userId: string;
    credentialConfigurationId: string;
  }
): Promise<Record<string, unknown>> {
  if (!input.offerId) throw new Error('vci_access_token_missing_offer_id');
  const { stub } = getCredentialOfferStoreById(env, input.offerId, input.tenantId);
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
  return { ...offer.claims };
}

function resolveVct(configurationId: string): string {
  const configurations: Record<string, string> = {
    AuthrimIdentityCredential: 'https://authrim.com/credentials/identity/v1',
    AuthrimAgeVerification: 'https://authrim.com/credentials/age-verification/v1',
  };
  const vct = configurations[configurationId];
  if (!vct) throw new Error('vci_unsupported_credential_configuration');
  return vct;
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

/**
 * Get selective disclosure claims for a VCT
 */
function getSDClaims(vct: string, additionalPiiClaimNames: string[] = []): string[] {
  const sdClaimsMap: Record<string, string[]> = {
    'https://authrim.com/credentials/identity/v1': [
      'given_name',
      'family_name',
      'email',
      'birthdate',
    ],
    'https://authrim.com/credentials/age-verification/v1': ['age_over_18', 'age_over_21'],
  };

  const baseClaims = sdClaimsMap[vct] || [];
  if (additionalPiiClaimNames.length === 0) return baseClaims;

  // Deduplicate
  const combined = new Set([...baseClaims, ...additionalPiiClaimNames]);
  return Array.from(combined);
}

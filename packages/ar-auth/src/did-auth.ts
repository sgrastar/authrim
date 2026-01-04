/**
 * DID Authentication Handler
 *
 * Implements DID-based authentication using challenge-response pattern.
 * Supports did:web and did:key methods.
 *
 * Flow:
 * 1. Client requests challenge with their DID
 * 2. Server resolves DID, returns challenge with allowed verification methods
 * 3. Client signs challenge with their private key
 * 4. Server verifies signature using public key from DID document
 *
 * Endpoints:
 * - POST /auth/did/challenge - Generate authentication challenge
 * - POST /auth/did/verify - Verify signed challenge
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getChallengeStoreByDID,
  getSessionStoreForNewSession,
  LinkedIdentityRepository,
  D1Adapter,
  resolveDID,
  type DIDDocument,
  type VerificationMethod,
  type ConsumeChallengeResponse,
  createErrorResponse,
  AR_ERROR_CODES,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  // Logger
  getLogger,
} from '@authrim/ar-lib-core';
import { jwtVerify, importJWK, decodeProtectedHeader } from 'jose';

/**
 * Allowed JWT algorithms for DID authentication proofs.
 * - ES256/ES384/ES512: HAIP-compliant EC algorithms
 * - EdDSA: For Ed25519 keys (did:key)
 */
const ALLOWED_DID_AUTH_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'EdDSA'];

/** Default session TTL in seconds (24 hours) */
const DEFAULT_SESSION_TTL = 86400;

/**
 * POST /auth/did/challenge
 *
 * Generate a challenge for DID authentication.
 * Returns the challenge and allowed verification methods from the DID document.
 */
export async function didAuthChallengeHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DID-AUTH');

  try {
    const body = await c.req.json<{ did: string }>();
    const { did } = body;

    // SECURITY: Check for both null/undefined and empty/whitespace-only string
    if (!did || (typeof did === 'string' && did.trim() === '')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'did' },
      });
    }

    // Validate DID format
    if (!did.startsWith('did:')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Resolve DID document
    let didDocument: DIDDocument;
    try {
      didDocument = await resolveDID(did);
    } catch (error) {
      // SECURITY: Do not expose DID value in error message to prevent DID enumeration
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Get all authentication verification methods
    const authMethods = didDocument.authentication || [];
    const verificationMethods: VerificationMethod[] = [];

    for (const methodRef of authMethods) {
      const methodId = typeof methodRef === 'string' ? methodRef : methodRef.id;
      const method = didDocument.verificationMethod?.find((vm) => vm.id === methodId);
      if (method) {
        verificationMethods.push(method);
      } else if (typeof methodRef === 'object') {
        // Inline verification method
        verificationMethods.push(methodRef);
      }
    }

    if (verificationMethods.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Generate challenge
    const challenge = crypto.randomUUID();
    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomUUID();

    // Store challenge in ChallengeStore
    const challengeStore = getChallengeStoreByDID(c.env, did);
    await challengeStore.storeChallengeRpc({
      id: `did_auth:${challengeId}`,
      type: 'did_authentication',
      userId: '', // Will be resolved after verification
      challenge,
      ttl: 300, // 5 minutes
      metadata: {
        did,
        allowedVerificationMethods: verificationMethods.map((vm) => vm.id),
        nonce,
      },
    });

    // Return challenge with verification methods (without private key info)
    const safeVerificationMethods = verificationMethods.map((vm) => ({
      id: vm.id,
      type: vm.type,
      controller: vm.controller,
      // Include public key info for client to identify which key to use
      publicKeyJwk: vm.publicKeyJwk ? { ...vm.publicKeyJwk, d: undefined } : undefined,
    }));

    return c.json({
      challenge_id: challengeId,
      challenge,
      nonce,
      allowed_verification_methods: safeVerificationMethods,
      expires_in: 300,
    });
  } catch (error) {
    log.error('DID challenge generation error', { action: 'challenge' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /auth/did/verify
 *
 * Verify a signed challenge for DID authentication.
 * Creates a session on success.
 */
export async function didAuthVerifyHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DID-AUTH');

  try {
    const body = await c.req.json<{
      challenge_id: string;
      proof: string; // JWS containing the signed challenge
    }>();

    const { challenge_id, proof } = body;

    // SECURITY: Check for both null/undefined and empty/whitespace-only strings
    const isEmptyString = (val: unknown): boolean => typeof val === 'string' && val.trim() === '';

    if (!challenge_id || !proof || isEmptyString(challenge_id) || isEmptyString(proof)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id and proof' },
      });
    }

    // Decode proof header to get kid (verification method ID)
    let protectedHeader;
    try {
      protectedHeader = decodeProtectedHeader(proof);
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const kid = protectedHeader.kid;
    if (!kid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'kid header' },
      });
    }

    // Extract DID from kid (kid format: did:method:identifier#key-id)
    const didMatch = kid.match(/^(did:[^#]+)/);
    if (!didMatch) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const did = didMatch[1];

    // Get challenge store and consume challenge
    const challengeStore = getChallengeStoreByDID(c.env, did);
    let challengeData: ConsumeChallengeResponse;
    try {
      challengeData = await challengeStore.consumeChallengeRpc({
        id: `did_auth:${challenge_id}`,
        type: 'did_authentication',
      });
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Verify kid is in allowed methods
    const metadata = challengeData.metadata as
      | { allowedVerificationMethods?: string[]; nonce?: string; did?: string }
      | undefined;
    const allowedMethods = metadata?.allowedVerificationMethods || [];
    if (!allowedMethods.includes(kid)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Resolve DID document
    let didDocument: DIDDocument;
    try {
      didDocument = await resolveDID(did);
    } catch {
      // SECURITY: Do not expose DID value in error message to prevent DID enumeration
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Find verification method
    const verificationMethod = didDocument.verificationMethod?.find((vm) => vm.id === kid);
    if (!verificationMethod || !verificationMethod.publicKeyJwk) {
      // SECURITY: Use generic message to prevent DID key enumeration
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Import public key
    let publicKey;
    try {
      publicKey = await importJWK(verificationMethod.publicKeyJwk);
    } catch {
      // SECURITY: Use generic message to prevent information leakage
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Verify JWT signature
    // SECURITY: ISSUER_URL must be configured, never trust Host header for audience
    const issuerUrl = c.env.ISSUER_URL;
    if (!issuerUrl) {
      // Log internally but return generic error to avoid revealing server configuration
      log.error('ISSUER_URL is not configured', { action: 'verify' });
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    let payload;
    try {
      const result = await jwtVerify(proof, publicKey, {
        audience: issuerUrl,
        algorithms: ALLOWED_DID_AUTH_ALGORITHMS,
      });
      payload = result.payload;
    } catch {
      // Publish DID authentication failure event (non-blocking)
      publishEvent(c, {
        type: AUTH_EVENTS.DID_FAILED,
        tenantId: 'default',
        data: {
          method: 'did',
          clientId: 'did-auth',
          errorCode: 'signature_verification_failed',
        } satisfies AuthEventData,
      }).catch((err: unknown) => {
        log.warn('Failed to publish auth.did.failed event', { action: 'event_publish' });
      });

      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Verify required claims
    const expectedNonce = metadata?.nonce;
    if (payload.iss !== did) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    if (payload.nonce !== expectedNonce) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Find linked user (use DB_PII for linked identities)
    const adapter = new D1Adapter({ db: c.env.DB_PII });
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const linkedIdentity = await linkedIdentityRepo.findByProviderUser('did', did);

    if (!linkedIdentity) {
      // Publish DID authentication failure event (non-blocking)
      publishEvent(c, {
        type: AUTH_EVENTS.DID_FAILED,
        tenantId: 'default',
        data: {
          method: 'did',
          clientId: 'did-auth',
          errorCode: 'identity_not_linked',
        } satisfies AuthEventData,
      }).catch((err: unknown) => {
        log.warn('Failed to publish auth.did.failed event', { action: 'event_publish' });
      });

      return createErrorResponse(c, AR_ERROR_CODES.BRIDGE_LINK_REQUIRED);
    }

    // Create session
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env);
    const sessionTtl = DEFAULT_SESSION_TTL;

    await sessionStore.createSessionRpc(sessionId, linkedIdentity.user_id, sessionTtl, {
      amr: ['did'],
      acr: 'urn:authrim:acr:did',
      auth_time: Math.floor(Date.now() / 1000),
      did,
      verification_method: kid,
    });

    // Publish DID authentication success event (non-blocking)
    publishEvent(c, {
      type: AUTH_EVENTS.DID_SUCCEEDED,
      tenantId: 'default',
      data: {
        userId: linkedIdentity.user_id,
        method: 'did',
        clientId: 'did-auth', // DID auth is direct, no client involved
        sessionId,
      } satisfies AuthEventData,
    }).catch((err: unknown) => {
      log.warn('Failed to publish auth.did.succeeded event', { action: 'event_publish' });
    });

    // Publish session created event (non-blocking)
    publishEvent(c, {
      type: SESSION_EVENTS.USER_CREATED,
      tenantId: 'default',
      data: {
        sessionId,
        userId: linkedIdentity.user_id,
        ttlSeconds: sessionTtl,
      } satisfies SessionEventData,
    }).catch((err: unknown) => {
      log.warn('Failed to publish session.user.created event', { action: 'event_publish' });
    });

    return c.json({
      session_id: sessionId,
      user_id: linkedIdentity.user_id,
      expires_in: sessionTtl,
    });
  } catch (error) {
    log.error('DID verification error', { action: 'verify' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

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
import type { Env } from '@authrim/shared';
import {
  getChallengeStoreByDID,
  getSessionStoreForNewSession,
  LinkedIdentityRepository,
  D1Adapter,
  resolveDID,
  type DIDDocument,
  type VerificationMethod,
  type ConsumeChallengeResponse,
} from '@authrim/shared';
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
  try {
    const body = await c.req.json<{ did: string }>();
    const { did } = body;

    // SECURITY: Check for both null/undefined and empty/whitespace-only string
    if (!did || (typeof did === 'string' && did.trim() === '')) {
      return c.json({ error: 'invalid_request', error_description: 'DID is required' }, 400);
    }

    // Validate DID format
    if (!did.startsWith('did:')) {
      return c.json({ error: 'invalid_request', error_description: 'Invalid DID format' }, 400);
    }

    // Resolve DID document
    let didDocument: DIDDocument;
    try {
      didDocument = await resolveDID(did);
    } catch (error) {
      return c.json(
        { error: 'invalid_did', error_description: `Failed to resolve DID: ${did}` },
        400
      );
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
      return c.json(
        {
          error: 'invalid_did',
          error_description: 'No authentication methods found in DID document',
        },
        400
      );
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
    console.error('[did-auth] Challenge error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

/**
 * POST /auth/did/verify
 *
 * Verify a signed challenge for DID authentication.
 * Creates a session on success.
 */
export async function didAuthVerifyHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await c.req.json<{
      challenge_id: string;
      proof: string; // JWS containing the signed challenge
    }>();

    const { challenge_id, proof } = body;

    // SECURITY: Check for both null/undefined and empty/whitespace-only strings
    const isEmptyString = (val: unknown): boolean => typeof val === 'string' && val.trim() === '';

    if (!challenge_id || !proof || isEmptyString(challenge_id) || isEmptyString(proof)) {
      return c.json(
        { error: 'invalid_request', error_description: 'challenge_id and proof are required' },
        400
      );
    }

    // Decode proof header to get kid (verification method ID)
    let protectedHeader;
    try {
      protectedHeader = decodeProtectedHeader(proof);
    } catch {
      return c.json({ error: 'invalid_proof', error_description: 'Invalid JWS format' }, 400);
    }

    const kid = protectedHeader.kid;
    if (!kid) {
      return c.json(
        { error: 'invalid_proof', error_description: 'Proof must include kid header' },
        400
      );
    }

    // Extract DID from kid (kid format: did:method:identifier#key-id)
    const didMatch = kid.match(/^(did:[^#]+)/);
    if (!didMatch) {
      return c.json({ error: 'invalid_proof', error_description: 'kid must be a DID URL' }, 400);
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
      return c.json(
        { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
        400
      );
    }

    // Verify kid is in allowed methods
    const metadata = challengeData.metadata as
      | { allowedVerificationMethods?: string[]; nonce?: string; did?: string }
      | undefined;
    const allowedMethods = metadata?.allowedVerificationMethods || [];
    if (!allowedMethods.includes(kid)) {
      return c.json(
        { error: 'invalid_proof', error_description: 'Verification method not allowed' },
        400
      );
    }

    // Resolve DID document
    let didDocument: DIDDocument;
    try {
      didDocument = await resolveDID(did);
    } catch {
      return c.json(
        { error: 'invalid_did', error_description: `Failed to resolve DID: ${did}` },
        400
      );
    }

    // Find verification method
    const verificationMethod = didDocument.verificationMethod?.find((vm) => vm.id === kid);
    if (!verificationMethod || !verificationMethod.publicKeyJwk) {
      return c.json(
        {
          error: 'invalid_proof',
          error_description: 'Verification method not found or no public key',
        },
        400
      );
    }

    // Import public key
    let publicKey;
    try {
      publicKey = await importJWK(verificationMethod.publicKeyJwk);
    } catch {
      return c.json(
        { error: 'invalid_proof', error_description: 'Failed to import public key' },
        400
      );
    }

    // Verify JWT signature
    // SECURITY: ISSUER_URL must be configured, never trust Host header for audience
    const issuerUrl = c.env.ISSUER_URL;
    if (!issuerUrl) {
      // Log internally but return generic error to avoid revealing server configuration
      console.error('[did-auth] ISSUER_URL is not configured');
      return c.json(
        { error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable' },
        503
      );
    }

    let payload;
    try {
      const result = await jwtVerify(proof, publicKey, {
        audience: issuerUrl,
        algorithms: ALLOWED_DID_AUTH_ALGORITHMS,
      });
      payload = result.payload;
    } catch {
      return c.json(
        { error: 'invalid_proof', error_description: 'Signature verification failed' },
        400
      );
    }

    // Verify required claims
    const expectedNonce = metadata?.nonce;
    if (payload.iss !== did) {
      return c.json({ error: 'invalid_proof', error_description: 'Issuer must match DID' }, 400);
    }
    if (payload.nonce !== expectedNonce) {
      return c.json({ error: 'invalid_proof', error_description: 'Nonce mismatch' }, 400);
    }

    // Find linked user (use DB_PII for linked identities)
    const adapter = new D1Adapter({ db: c.env.DB_PII });
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const linkedIdentity = await linkedIdentityRepo.findByProviderUser('did', did);

    if (!linkedIdentity) {
      return c.json(
        { error: 'did_not_linked', error_description: 'DID is not linked to any account' },
        400
      );
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

    return c.json({
      session_id: sessionId,
      user_id: linkedIdentity.user_id,
      expires_in: sessionTtl,
    });
  } catch (error) {
    console.error('[did-auth] Verify error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

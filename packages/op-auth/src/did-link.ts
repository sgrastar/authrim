/**
 * DID Link Management
 *
 * Manages DID linking/unlinking for existing user accounts.
 * Separate from DID authentication (did-auth.ts) which handles login with linked DIDs.
 *
 * Flow:
 * 1. Authenticated user requests to link a DID
 * 2. Server verifies DID ownership via challenge-response
 * 3. DID is linked to user account
 *
 * Endpoints:
 * - POST /auth/did/register/challenge - Generate challenge for DID registration
 * - POST /auth/did/register/verify - Verify proof and create link
 * - GET /auth/did/list - List linked DIDs for current user
 * - DELETE /auth/did/unlink/:did - Unlink a DID from current user
 */

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/shared';
import {
  getChallengeStoreByDID,
  getSessionStoreBySessionId,
  LinkedIdentityRepository,
  D1Adapter,
  resolveDID,
  type DIDDocument,
  type VerificationMethod,
  type ConsumeChallengeResponse,
} from '@authrim/shared';
import { jwtVerify, importJWK, decodeProtectedHeader } from 'jose';

/**
 * Allowed JWT algorithms for DID registration proofs.
 * - ES256/ES384/ES512: HAIP-compliant EC algorithms
 * - EdDSA: For Ed25519 keys (did:key)
 */
const ALLOWED_DID_AUTH_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'EdDSA'];

/**
 * Extract session from request cookie or Authorization header
 */
async function getAuthenticatedUserId(c: Context<{ Bindings: Env }>): Promise<string | null> {
  // Try to get session from cookie
  const sessionId = getCookie(c, 'authrim_session');
  if (!sessionId) {
    // Try Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }
    // For simplicity, we'll extract session from a specific format
    // In production, this would validate the session token properly
    return null;
  }

  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
    if (!session || !session.userId) {
      return null;
    }
    return session.userId;
  } catch {
    return null;
  }
}

/**
 * POST /auth/did/register/challenge
 *
 * Generate a challenge for DID registration (linking to account).
 * Requires authenticated session.
 */
export async function didRegisterChallengeHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    // Verify user is authenticated
    const userId = await getAuthenticatedUserId(c);
    if (!userId) {
      return c.json(
        { error: 'unauthorized', error_description: 'Authentication required to register DID' },
        401
      );
    }

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

    // Check if DID is already linked to another account
    const adapter = new D1Adapter({ db: c.env.DB_PII });
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const existingLink = await linkedIdentityRepo.findByProviderUser('did', did);

    if (existingLink) {
      if (existingLink.user_id === userId) {
        return c.json(
          {
            error: 'already_linked',
            error_description: 'This DID is already linked to your account',
          },
          400
        );
      }
      return c.json(
        { error: 'did_already_linked', error_description: 'This DID is linked to another account' },
        400
      );
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
      id: `did_reg:${challengeId}`,
      type: 'did_registration',
      userId, // Store user ID for linking after verification
      challenge,
      ttl: 300, // 5 minutes
      metadata: {
        did,
        allowedVerificationMethods: verificationMethods.map((vm) => vm.id),
        nonce,
      },
    });

    // Return challenge with verification methods
    const safeVerificationMethods = verificationMethods.map((vm) => ({
      id: vm.id,
      type: vm.type,
      controller: vm.controller,
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
    console.error('[did-link] Register challenge error:', error);
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
 * POST /auth/did/register/verify
 *
 * Verify the DID registration proof and create the link.
 */
export async function didRegisterVerifyHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await c.req.json<{
      challenge_id: string;
      proof: string;
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

    // Decode proof header to get kid
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

    // Extract DID from kid
    const didMatch = kid.match(/^(did:[^#]+)/);
    if (!didMatch) {
      return c.json({ error: 'invalid_proof', error_description: 'kid must be a DID URL' }, 400);
    }
    const did = didMatch[1];

    // SECURITY: Early check if DID is already linked (before expensive operations)
    // This prevents DoS via repeated verification attempts for already-linked DIDs
    const adapter = new D1Adapter({ db: c.env.DB_PII });
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const existingLinkEarly = await linkedIdentityRepo.findByProviderUser('did', did);
    if (existingLinkEarly) {
      return c.json(
        {
          error: 'did_already_linked',
          error_description: 'This DID is already linked to an account',
        },
        400
      );
    }

    // Get challenge store and consume challenge
    const challengeStore = getChallengeStoreByDID(c.env, did);
    let challengeData: ConsumeChallengeResponse;
    try {
      challengeData = await challengeStore.consumeChallengeRpc({
        id: `did_reg:${challenge_id}`,
        type: 'did_registration',
      });
    } catch {
      return c.json(
        { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
        400
      );
    }

    // Extract metadata
    const metadata = challengeData.metadata as
      | { allowedVerificationMethods?: string[]; nonce?: string; did?: string }
      | undefined;
    const allowedMethods = metadata?.allowedVerificationMethods || [];

    // Verify kid is in allowed methods
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
      console.error('[did-link] ISSUER_URL is not configured');
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

    // Create the link with race condition protection
    // Note: adapter and linkedIdentityRepo were already created earlier for early check

    // Attempt to create linked identity with proper error handling for race conditions
    // The database should have a UNIQUE constraint on (provider_id, provider_user_id)
    try {
      await linkedIdentityRepo.createLinkedIdentity({
        user_id: challengeData.userId,
        provider_id: 'did',
        provider_user_id: did,
        raw_attributes: {
          did,
          verificationMethod: kid,
          linkedAt: Date.now(),
        },
      });
    } catch (error) {
      // Check if error is due to duplicate key (race condition)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes('UNIQUE') ||
        errorMessage.includes('constraint') ||
        errorMessage.includes('duplicate')
      ) {
        // Race condition: another process linked this DID
        // Check if it was linked to the same user (idempotent success)
        const existingLink = await linkedIdentityRepo.findByProviderUser('did', did);
        if (existingLink && existingLink.user_id === challengeData.userId) {
          // Same user, treat as success (idempotent)
          return c.json({
            success: true,
            did,
            message: 'DID is already linked to your account',
          });
        }
        return c.json(
          {
            error: 'did_already_linked',
            error_description: 'This DID is already linked to another account',
          },
          400
        );
      }
      // Re-throw other errors
      throw error;
    }

    return c.json({
      success: true,
      did,
      message: 'DID successfully linked to your account',
    });
  } catch (error) {
    console.error('[did-link] Register verify error:', error);
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
 * GET /auth/did/list
 *
 * List all DIDs linked to the current user's account.
 */
export async function didListHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const userId = await getAuthenticatedUserId(c);
    if (!userId) {
      return c.json({ error: 'unauthorized', error_description: 'Authentication required' }, 401);
    }

    const adapter = new D1Adapter({ db: c.env.DB_PII });
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const identities = await linkedIdentityRepo.findByUserId(userId);

    // Filter to only DID links
    const didLinks = identities
      .filter((i) => i.provider_id === 'did')
      .map((i) => ({
        did: i.provider_user_id,
        linked_at: i.linked_at,
        last_used_at: i.last_used_at,
        raw_attributes: i.raw_attributes ? JSON.parse(i.raw_attributes) : null,
      }));

    return c.json({
      dids: didLinks,
      count: didLinks.length,
    });
  } catch (error) {
    console.error('[did-link] List error:', error);
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
 * DELETE /auth/did/unlink/:did
 *
 * Unlink a DID from the current user's account.
 */
export async function didUnlinkHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const userId = await getAuthenticatedUserId(c);
    if (!userId) {
      return c.json({ error: 'unauthorized', error_description: 'Authentication required' }, 401);
    }

    // Get DID from URL - URL encoded
    const didEncoded = c.req.param('did');
    if (!didEncoded) {
      return c.json({ error: 'invalid_request', error_description: 'DID is required' }, 400);
    }

    const did = decodeURIComponent(didEncoded);

    // Validate DID format
    if (!did.startsWith('did:')) {
      return c.json({ error: 'invalid_request', error_description: 'Invalid DID format' }, 400);
    }

    const adapter = new D1Adapter({ db: c.env.DB_PII });
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);

    // Find the link
    const link = await linkedIdentityRepo.findByProviderUser('did', did);
    if (!link) {
      return c.json({ error: 'not_found', error_description: 'DID link not found' }, 404);
    }

    // Verify ownership
    if (link.user_id !== userId) {
      return c.json(
        { error: 'forbidden', error_description: 'Cannot unlink DID belonging to another user' },
        403
      );
    }

    // Delete the link
    const deleted = await linkedIdentityRepo.unlink(userId, 'did');

    return c.json({
      success: deleted,
      did,
      message: deleted ? 'DID unlinked successfully' : 'Failed to unlink DID',
    });
  } catch (error) {
    console.error('[did-link] Unlink error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

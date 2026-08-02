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
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  getChallengeStoreByDID,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  LinkedIdentityRepository,
  createPIIContextFromHono,
  createAuthContextFromHono,
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
  resolveDID,
  type DIDDocument,
  type VerificationMethod,
  type ConsumeChallengeResponse,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';
import { jwtVerify, importJWK, decodeProtectedHeader } from 'jose';

/**
 * Allowed JWT algorithms for DID registration proofs.
 * - ES256/ES384/ES512: HAIP-compliant EC algorithms
 * - EdDSA: For Ed25519 keys (did:key)
 */
const ALLOWED_DID_AUTH_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'EdDSA'];

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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
    const { stub: sessionStore } = getSessionStoreBySessionId(
      c.env,
      sessionId,
      getTenantIdFromContext(c)
    );
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
  const log = getLogger(c).module('DID-LINK');

  try {
    // Verify user is authenticated
    const userId = await getAuthenticatedUserId(c);
    if (!userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    const tenantId = getTenantIdFromContext(c);

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

    // Check if DID is already linked to another account
    const adapter = createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const existingLink = await linkedIdentityRepo.findByProviderUser(tenantId, 'did', did);

    if (existingLink) {
      if (existingLink.user_id === userId) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Resolve DID document
    let didDocument: DIDDocument;
    try {
      didDocument = await resolveDID(did);
    } catch (error) {
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
    const challengeStore = getChallengeStoreByDID(c.env, did, getTenantIdFromContext(c));
    await challengeStore.storeChallengeRpc({
      id: `did_reg:${challengeId}`,
      tenantId: getTenantIdFromContext(c),
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
    log.error('DID register challenge error', { action: 'register_challenge' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /auth/did/register/verify
 *
 * Verify the DID registration proof and create the link.
 */
export async function didRegisterVerifyHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DID-LINK');

  try {
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<{
      challenge_id: string;
      proof: string;
    }>();

    const { challenge_id, proof } = body;

    // SECURITY: Check for both null/undefined and empty/whitespace-only strings
    const isEmptyString = (val: unknown): boolean => typeof val === 'string' && val.trim() === '';

    if (!challenge_id || !proof || isEmptyString(challenge_id) || isEmptyString(proof)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id and proof' },
      });
    }

    // Decode proof header to get kid
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

    // Extract DID from kid
    const didMatch = kid.match(/^(did:[^#]+)/);
    if (!didMatch) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const did = didMatch[1];

    // SECURITY: Early check if DID is already linked (before expensive operations)
    // This prevents DoS via repeated verification attempts for already-linked DIDs
    const adapter = createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const existingLinkEarly = await linkedIdentityRepo.findByProviderUser(tenantId, 'did', did);
    if (existingLinkEarly) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Get challenge store and consume challenge
    const challengeStore = getChallengeStoreByDID(c.env, did, getTenantIdFromContext(c));
    let challengeData: ConsumeChallengeResponse;
    try {
      challengeData = await challengeStore.consumeChallengeRpc({
        id: `did_reg:${challenge_id}`,
        tenantId: getTenantIdFromContext(c),
        type: 'did_registration',
      });
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Extract metadata
    const metadata = challengeData.metadata as
      | { allowedVerificationMethods?: string[]; nonce?: string; did?: string }
      | undefined;
    const allowedMethods = metadata?.allowedVerificationMethods || [];

    // Verify kid is in allowed methods
    if (!allowedMethods.includes(kid)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Resolve DID document
    let didDocument: DIDDocument;
    try {
      didDocument = await resolveDID(did);
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Find verification method
    const verificationMethod = didDocument.verificationMethod?.find((vm) => vm.id === kid);
    if (!verificationMethod || !verificationMethod.publicKeyJwk) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Import public key
    let publicKey;
    try {
      publicKey = await importJWK(verificationMethod.publicKeyJwk);
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Verify JWT signature against the request-resolved issuer.
    const issuerUrl = getRequestIssuer(c);
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

    // Create the link with race condition protection
    // Note: adapter and linkedIdentityRepo were already created earlier for early check

    // Attempt to create linked identity with proper error handling for race conditions
    // The database should have a UNIQUE constraint on (provider_id, provider_user_id)
    try {
      await linkedIdentityRepo.createLinkedIdentity({
        tenant_id: tenantId,
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
        const existingLink = await linkedIdentityRepo.findByProviderUser(tenantId, 'did', did);
        if (existingLink && existingLink.user_id === challengeData.userId) {
          // Same user, treat as success (idempotent)
          return c.json({
            success: true,
            did,
            message: 'DID is already linked to your account',
          });
        }
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
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
    log.error('DID register verify error', { action: 'register_verify' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /auth/did/list
 *
 * List all DIDs linked to the current user's account.
 */
export async function didListHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DID-LINK');

  try {
    const userId = await getAuthenticatedUserId(c);
    if (!userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    const tenantId = getTenantIdFromContext(c);
    const adapter = createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const identities = await linkedIdentityRepo.findByUserId(tenantId, userId);

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
    log.error('DID list error', { action: 'list' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /auth/did/unlink/:did
 *
 * Unlink a DID from the current user's account.
 */
export async function didUnlinkHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DID-LINK');

  try {
    const userId = await getAuthenticatedUserId(c);
    if (!userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    // Get DID from URL - URL encoded
    const didEncoded = c.req.param('did');
    if (!didEncoded) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'did' },
      });
    }

    const did = decodeURIComponent(didEncoded);

    // Validate DID format
    if (!did.startsWith('did:')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const tenantId = getTenantIdFromContext(c);
    const adapter = createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
    const linkedIdentityRepo = new LinkedIdentityRepository(adapter);
    const accountId = `account:${userId}`;
    const [issuerDigest, subjectDigest] = await Promise.all([sha256Hex('did'), sha256Hex(did)]);
    const operationId = `external-unlink:${(await sha256Hex(`${tenantId}\0${accountId}\0did\0${did}`)).slice(0, 32)}`;

    // Find the link
    const link = await linkedIdentityRepo.findByProviderUser(tenantId, 'did', did);
    const existing = await adapter.queryOne<{
      tenant_id: string;
      account_id: string;
      user_id: string;
      issuer_sha256: string;
      subject_sha256: string;
      state: string;
    }>(
      `SELECT tenant_id, account_id, user_id, issuer_sha256, subject_sha256, state
         FROM external_identifier_unlink_operations WHERE operation_id = ?`,
      [operationId]
    );
    if (!link && !existing) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Verify ownership
    if (link && link.user_id !== userId) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }
    if (
      existing &&
      (existing.tenant_id !== tenantId ||
        existing.account_id !== accountId ||
        existing.user_id !== userId ||
        existing.issuer_sha256 !== issuerDigest ||
        existing.subject_sha256 !== subjectDigest)
    ) {
      throw new Error('identifier_unlink_operation_conflict');
    }
    if (existing?.state === 'blocked') throw new Error('identifier_unlink_operation_blocked');

    if (!existing) {
      const routeRow = await createAuthContextFromHono(c, tenantId).coreAdapter.queryOne<{
        payload_json: string;
      }>(
        `SELECT outbox.payload_json
           FROM identity_accounts account
           JOIN account_routing_outbox outbox
             ON outbox.tenant_id = account.tenant_id AND outbox.account_id = account.id
            AND outbox.event_kind = 'account_created'
            AND outbox.route_generation = account.account_route_generation
          WHERE account.tenant_id = ? AND account.id = ?
            AND account.lifecycle_state = 'active'
            AND account.directory_publication_state = 'active'
            AND outbox.status = 'succeeded'`,
        [tenantId, accountId]
      );
      if (!routeRow) throw new Error('identifier_directory_route_unavailable');
      const route = await validateAccountDirectoryPublication(
        JSON.parse(routeRow.payload_json) as AccountDirectoryPublication
      );
      if (route.tenantId !== tenantId || route.accountId !== accountId) {
        throw new Error('identifier_directory_route_mismatch');
      }
      const now = Math.floor(Date.now() / 1000);
      const results = await adapter.batch([
        {
          sql: `INSERT INTO external_identifier_unlink_operations (
             operation_id, tenant_id, account_id, user_id, issuer_json, subject_json,
             issuer_sha256, subject_sha256, route_projection_json, state,
             attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          params: [
            operationId,
            tenantId,
            accountId,
            userId,
            JSON.stringify('did'),
            JSON.stringify(did),
            issuerDigest,
            subjectDigest,
            JSON.stringify(route.routeProjection),
            now,
            now,
          ],
        },
        {
          sql: `DELETE FROM linked_identities
            WHERE tenant_id = ? AND user_id = ? AND provider_id = 'did' AND provider_user_id = ?`,
          params: [tenantId, userId, did],
        },
      ]);
      if (results[0]?.rowsAffected !== 1 || results[1]?.rowsAffected !== 1) {
        throw new Error('identifier_unlink_delete_conflict');
      }
    }

    return c.json({
      success: true,
      did,
      cleanup_pending: existing?.state !== 'completed',
      operation_id: operationId,
      message: 'DID unlinked successfully',
    });
  } catch (error) {
    log.error('DID unlink error', { action: 'unlink' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

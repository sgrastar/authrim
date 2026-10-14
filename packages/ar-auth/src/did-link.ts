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
  ensureDatabaseAdapter,
  resolveAccountDataContextFromHono,
  type AccountDataContext,
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
import { rejectIfDidLoginDisabled } from './did-login-gate';
import { jwtVerify, importJWK, decodeProtectedHeader } from 'jose';
import {
  ALLOWED_DID_AUTH_ALGORITHMS,
  collectAuthenticationMethods,
  isLinkableDid,
  readJsonObject,
  resolveProofAlgorithm,
} from './did-proof';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The signed-in user's account and the PII database that holds their linked_identities rows.
 * The account is resolved first: with tenant-sharded databases the link row lives with the account
 * (the same database the route publication verifies it on), not on a tenant-wide default.
 */
type LinkAdapter = ReturnType<typeof createPIIContextFromHono>['defaultPiiAdapter'];

async function resolveLinkStore(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string
): Promise<{
  account: AccountDataContext;
  adapter: LinkAdapter;
  repo: LinkedIdentityRepository;
}> {
  const account = await resolveAccountDataContextFromHono(c, userId);
  if (account.legacyUserId !== userId) throw new Error('did_link_account_mismatch');
  const adapter = createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
  return { account, adapter, repo: new LinkedIdentityRepository(adapter) };
}

class DidRoutePublicationError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean
  ) {
    super(message);
  }
}

/** The link could not be completed for now; the same request can be repeated. */
function didRouteUnavailable(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The DID could not be linked right now. Please try again.',
    },
    503
  );
}

/**
 * Publishes the lookup-directory route of a DID link, so DID login finds the account again. The
 * operation id is derived from the link row, so a retry of the same link republishes the same
 * operation (idempotent) while a new link of the same DID after an unlink is a new operation.
 * Status 201 (published) and 202 (queued on the durable outbox) both mean the route will exist.
 */
async function publishDidRoute(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    accountId: string;
    userId: string;
    linkedIdentityId: string;
    did: string;
  }
): Promise<201 | 202> {
  const provisioner = c.env.ACCOUNT_PROVISIONER;
  if (!provisioner) throw new Error('account_provisioner_unavailable');
  const digest = await sha256Hex(
    [input.tenantId, input.accountId, input.userId, input.linkedIdentityId, input.did].join('\0')
  );
  const operationId = `did-route-${digest.slice(0, 32)}`;
  let result;
  try {
    result = await provisioner.publishAuthDidRoute({
      schemaVersion: 1,
      operationId,
      idempotencyKey: `auth-did-route:${digest}`,
      tenantId: input.tenantId,
      accountId: input.accountId,
      userId: input.userId,
      linkedIdentityId: input.linkedIdentityId,
      did: input.did,
    });
  } catch (error) {
    // The identifier is reserved by another account: nothing of ours was written, so retrying
    // cannot succeed either.
    throw new DidRoutePublicationError(
      error instanceof Error ? error.message : 'did_route_publication_failed',
      error instanceof Error && error.message === 'directory_identifier_reservation_conflict'
    );
  }
  if (
    !result ||
    result.operationId !== operationId ||
    result.accountId !== input.accountId ||
    (result.status !== 201 && result.status !== 202)
  ) {
    throw new DidRoutePublicationError('did_route_publication_response_invalid', false);
  }
  return result.status;
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
    // A tenant that has DID login off collects no DID either: decided before anything else.
    const loginDisabled = await rejectIfDidLoginDisabled(c, getTenantIdFromContext(c));
    if (loginDisabled) return loginDisabled;

    // Verify user is authenticated
    const userId = await getAuthenticatedUserId(c);
    if (!userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    const body = await readJsonObject(c);
    if (!body) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    const { did } = body;

    // SECURITY: Check for both null/undefined and empty/whitespace-only string
    if (!did || (typeof did === 'string' && did.trim() === '')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'did' },
      });
    }

    // Validate DID format
    if (typeof did !== 'string' || !isLinkableDid(did)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Whether the DID is already linked to someone else is NOT decided here: a challenge for a
    // resolvable DID looks the same whoever holds the DID, so an authenticated user cannot probe
    // for links without owning the key. The duplicate is refused after the proof is verified.

    // Resolve DID document
    let didDocument: DIDDocument;
    try {
      didDocument = await resolveDID(did);
    } catch (error) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Get all authentication verification methods
    const verificationMethods: VerificationMethod[] = collectAuthenticationMethods(didDocument);

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
    // Before the challenge is consumed: a settings read that failed for a moment must not burn
    // the challenge, and a tenant with DID login off links nothing.
    const loginDisabled = await rejectIfDidLoginDisabled(c, tenantId);
    if (loginDisabled) return loginDisabled;

    // Without the provisioner the route cannot be published: refuse before the challenge is
    // consumed or anything is written, rather than leave a link that cannot sign in.
    if (!c.env.ACCOUNT_PROVISIONER) {
      log.error('Account provisioner is not configured', { action: 'register_verify' });
      return didRouteUnavailable(c);
    }

    const body = await readJsonObject(c);
    if (!body) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    const { challenge_id, proof } = body as { challenge_id?: unknown; proof?: unknown };

    // SECURITY: Check for both null/undefined and empty/whitespace-only strings
    const isEmptyString = (val: unknown): boolean => typeof val === 'string' && val.trim() === '';

    if (!challenge_id || !proof || isEmptyString(challenge_id) || isEmptyString(proof)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id and proof' },
      });
    }
    // Both are strings: an array or number would be string-interpolated into the challenge id.
    if (typeof challenge_id !== 'string' || typeof proof !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
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

    // A kid that is not a string (`"kid": 123`) is as invalid as one that is not a DID URL.
    if (typeof kid !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Extract DID from kid
    const didMatch = kid.match(/^(did:[^#]+)/);
    if (!didMatch) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const did = didMatch[1];

    if (!isLinkableDid(did)) {
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

    // The challenge names the user it was issued to; the link row lives with that user's account.
    const linkUserId = challengeData.userId;
    if (typeof linkUserId !== 'string' || linkUserId === '') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const {
      account,
      adapter,
      repo: linkedIdentityRepo,
    } = await resolveLinkStore(c, tenantId, linkUserId);

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

    // Find the verification method: it must be an authentication method of the document as it is
    // now, not only of the document at the time the challenge was issued.
    const verificationMethod = collectAuthenticationMethods(didDocument).find(
      (vm) => vm.id === kid
    );
    if (!verificationMethod || !verificationMethod.publicKeyJwk) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // The key is imported under the JWK's alg, or the proof's when the JWK has none. An algorithm
    // outside the allow-list, or one the JWK and the proof disagree on, fails like a bad signature.
    const algorithm = resolveProofAlgorithm(verificationMethod.publicKeyJwk, protectedHeader.alg);
    if (!algorithm) return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);

    // Import public key
    let publicKey;
    try {
      publicKey = await importJWK(verificationMethod.publicKeyJwk, algorithm);
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

    // The link row (insert) comes first, then its route is published. A retry of the same link
    // (same user) reuses the existing row and so republishes the same operation.
    // A DID linked to ANOTHER user is refused here, after the proof: only someone who owns the
    // key can learn that it is linked elsewhere, and the answer is the generic one. A link of the
    // same user is let through: it is a retry whose route publication did not complete, and
    // publishing the route is idempotent.
    const existingLinkEarly = await linkedIdentityRepo.findByProviderUser(tenantId, 'did', did);
    if (existingLinkEarly && existingLinkEarly.user_id !== linkUserId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    let linkedIdentityId: string;
    let createdHere = false;
    let alreadyLinked = false;
    if (existingLinkEarly) {
      linkedIdentityId = existingLinkEarly.id;
      alreadyLinked = true;
    } else {
      // The database should have a UNIQUE constraint on (provider_id, provider_user_id)
      try {
        const created = await linkedIdentityRepo.createLinkedIdentity({
          tenant_id: tenantId,
          user_id: linkUserId,
          provider_id: 'did',
          provider_user_id: did,
          raw_attributes: {
            did,
            verificationMethod: kid,
            linkedAt: Date.now(),
          },
        });
        linkedIdentityId = created.id;
        createdHere = true;
      } catch (error) {
        // Check if error is due to duplicate key (race condition)
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          !(
            errorMessage.includes('UNIQUE') ||
            errorMessage.includes('constraint') ||
            errorMessage.includes('duplicate')
          )
        ) {
          throw error;
        }
        // Race condition: another process linked this DID. If it was the same user the link is
        // theirs (idempotent) and only the route is left to publish.
        const existingLink = await linkedIdentityRepo.findByProviderUser(tenantId, 'did', did);
        if (!existingLink || existingLink.user_id !== linkUserId) {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
        linkedIdentityId = existingLink.id;
        alreadyLinked = true;
      }
    }

    try {
      await publishDidRoute(c, {
        tenantId,
        accountId: account.accountId,
        userId: linkUserId,
        linkedIdentityId,
        did,
      });
    } catch (error) {
      const definitive = error instanceof DidRoutePublicationError && error.definitive;
      log.error(
        'DID route publication failed',
        { action: 'register_verify', definitive },
        error as Error
      );
      if (definitive && createdHere) {
        // The DID is already routed to another account and nothing of this link was published:
        // drop the row so no link is left that can never sign in.
        try {
          await adapter.execute(
            'DELETE FROM linked_identities WHERE id = ? AND tenant_id = ? AND user_id = ?',
            [linkedIdentityId, tenantId, linkUserId]
          );
        } catch (cleanupError) {
          log.error(
            'DID link cleanup failed',
            { action: 'register_verify' },
            cleanupError as Error
          );
        }
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      // Possibly transient: the row stays so that repeating the link (same user, same DID)
      // publishes the same route operation again.
      return didRouteUnavailable(c);
    }

    return c.json({
      success: true,
      did,
      message: alreadyLinked
        ? 'DID is already linked to your account'
        : 'DID successfully linked to your account',
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
    const { repo: linkedIdentityRepo } = await resolveLinkStore(c, tenantId, userId);
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
    const {
      account,
      adapter,
      repo: linkedIdentityRepo,
    } = await resolveLinkStore(c, tenantId, userId);
    const accountId = account.accountId;
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
      // The account's own core database holds its creation record (identity_accounts and the
      // routing outbox). The tenant metadata core database does not: reading it here made every
      // unlink fail with identifier_directory_route_unavailable.
      const routeRow = await ensureDatabaseAdapter(account.coreDb, 'did-unlink-core').queryOne<{
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

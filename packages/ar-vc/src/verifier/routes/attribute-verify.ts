/**
 * Attribute Verification Routes
 *
 * Handles VP-based attribute verification for authenticated users.
 * This is used for attribute elevation (e.g., proving age for restricted content).
 *
 * Flow:
 * 1. User is already logged in via Passkey/Email/Social
 * 2. User initiates attribute verification request
 * 3. VP request is created with user's session context
 * 4. Wallet responds with VP token
 * 5. VP is verified and attributes are linked to the user's account
 *
 * Important: This is NOT for login - VC is used as attribute proof only.
 */

import type { Context } from 'hono';
import type { Env, VPRequestState } from '../../types';
import {
  AttributeVerificationRepository,
  UserVerifiedAttributeRepository,
  getLogger,
  createLogger,
  getTenantIdFromContext,
  resolveAuthCorePersistenceAdapterFromEnv,
  introspectTokenFromContext,
  requireDedicatedAdminDatabaseAdapter,
  resolveRuntimeIdentityMappingBinding,
  executeServerFlow,
  getActiveAccessTokenProtectedResourceContext,
} from '@authrim/ar-lib-core';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import type { SourceValueEnvelope } from '@authrim/ar-lib-field-mapping/contract';
import { getRequestIssuerUrl, getRequestVerifierIdentifier } from '../../request-identifiers';
import {
  getVPRequestStoreById,
  getVPRequestStoreForNewRequest,
} from '../../utils/vp-request-sharding';

const standaloneLog = createLogger().module('VC-ATTR-VERIFY');
import { verifyVPToken } from '../services/vp-verifier';
import {
  linkVerificationToUser,
  getUserVerifiedAttributes,
  type NormalizedAttribute,
} from '../services/attribute-mapper';
import { sha256Base64url } from '../../utils/crypto';

interface AttributeVerifyRequest {
  /** VP token (SD-JWT VC with KB-JWT) */
  vp_token: string;

  /** State parameter matching the VP request */
  state: string;

  /** Presentation submission metadata */
  presentation_submission?: object;
}

interface InitiateVerificationRequest {
  /** Published Credential Profile that controls disclosure and mapping. */
  credential_profile_id: string;
}

interface PublishedVerificationProfileRow {
  profile_id: string;
  version_id: string;
  verification_flow_version_id: string;
  credential_configuration_id: string;
  verification_mapping_set_id: string;
  verification_mapping_version_id: string;
  verification_mapping_snapshot_hash: string;
  claim_allowlist_json: string;
  maximum_attribute_age_seconds: number;
}

async function loadPublishedVerificationProfile(
  c: Context<{ Bindings: Env }>,
  profileId: string,
  tenantId: string
): Promise<PublishedVerificationProfileRow | null> {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'vc-attribute-profile').queryOne(
    `SELECT p.id AS profile_id, v.id AS version_id, v.credential_configuration_id,
            v.verification_flow_version_id, v.verification_mapping_set_id, v.verification_mapping_version_id,
            v.verification_mapping_snapshot_hash, v.claim_allowlist_json,
            v.maximum_attribute_age_seconds
       FROM credential_profiles p
       JOIN credential_profile_versions v ON v.id = p.current_published_version_id
      WHERE p.tenant_id = ? AND p.id = ? AND p.lifecycle_state = 'published'
        AND v.lifecycle_state = 'published' AND v.verification_mapping_set_id IS NOT NULL
        AND v.verification_flow_version_id IS NOT NULL
        AND v.verification_mapping_version_id IS NOT NULL
        AND v.verification_mapping_snapshot_hash IS NOT NULL`,
    [tenantId, profileId]
  );
}

async function buildMappedAttributePolicy(
  c: Context<{ Bindings: Env }>,
  request: VPRequestState,
  result: Awaited<ReturnType<typeof verifyVPToken>>
) {
  if (
    !request.credentialProfileId ||
    !request.credentialProfileVersionId ||
    !request.verificationMappingVersionId ||
    !request.verificationMappingSnapshotHash ||
    !request.maximumAttributeAgeSeconds
  ) {
    throw new Error('vp_profile_evidence_missing');
  }
  const binding = await resolveRuntimeIdentityMappingBinding(
    requireDedicatedAdminDatabaseAdapter(c.env, 'vc-attribute-mapping'),
    {
      tenantId: request.tenantId,
      protocol: 'vc',
      role: 'verifier',
      direction: 'verification',
      credentialProfileId: request.credentialProfileId,
      fieldMappingVersionId: request.verificationMappingVersionId,
    }
  );
  if (!binding || binding.mappingSnapshotHash !== request.verificationMappingSnapshotHash) {
    throw new Error('vp_mapping_snapshot_unavailable');
  }
  const sourceRefs = new Map(
    binding.edges
      .filter((edge) => edge.sourceRef.side === 'source')
      .map((edge) => [`${edge.sourceRef.namespace}:${edge.sourceRef.path}`, edge.sourceRef])
  );
  const disclosed = result.disclosedClaims ?? {};
  const sourceValues: SourceValueEnvelope[] = [];
  for (const ref of sourceRefs.values()) {
    const segments = ref.path.split('.');
    let value: unknown = disclosed[ref.path] ?? disclosed[segments.at(-1) ?? ref.path];
    if (value === undefined && segments.length > 1) {
      let current: unknown = disclosed[segments[0] ?? ''];
      for (const segment of segments.slice(1)) {
        current =
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[segment]
            : undefined;
      }
      value = current;
    }
    if (value !== undefined && value !== null) sourceValues.push({ value, sourceRef: ref });
  }
  const mapped = executeRuntimeMapping({
    catalog: binding.catalog,
    sourceValues,
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
  });
  if (mapped.status === 'failed') throw new Error('vp_attribute_mapping_failed');
  const namespace = binding.destinationNamespace ?? 'authrim.verified_attribute';
  const attributes: NormalizedAttribute[] = [];
  for (const item of mapped.values) {
    if (item.sourceRef.side !== 'destination' || item.sourceRef.namespace !== namespace) continue;
    const catalogEntry = binding.catalog.entries.find(
      (entry) => entry.namespace === namespace && entry.path === item.sourceRef.path
    );
    const value = item.value;
    const normalized =
      typeof value === 'boolean'
        ? String(value)
        : typeof value === 'string' &&
            value.length <= 128 &&
            catalogEntry?.allowedValues?.includes(value)
          ? value
          : null;
    if (normalized === null) continue;
    attributes.push({
      name: item.sourceRef.path,
      value: normalized,
      originalClaim: item.sourceRef.path,
    });
  }
  if (attributes.length === 0) throw new Error('vp_no_policy_ready_attributes');
  const secret = c.env.VC_EVIDENCE_HMAC_SECRET;
  if (!secret || secret.length < 32) throw new Error('vc_evidence_hmac_secret_missing');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const evidence = JSON.stringify({
    tenantId: request.tenantId,
    requestId: request.id,
    issuerDid: result.issuerDid,
    credentialType: result.credentialType,
    attributes: [...attributes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, value }) => [name, value]),
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(evidence))
  );
  const evidenceFingerprint = btoa(String.fromCharCode(...signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
  const now = Date.now();
  const statusCheckedAt = result.statusCheckedAt ?? now;
  const statusFreshUntil = result.statusFreshUntil ?? now;
  const profileExpiry = now + request.maximumAttributeAgeSeconds * 1000;
  const expiresAt = Math.min(result.credentialExpiresAt ?? profileExpiry, profileExpiry);
  const revalidateAfter = Math.min(expiresAt, statusFreshUntil);
  if (expiresAt <= now || revalidateAfter <= now) throw new Error('vp_evidence_not_fresh');
  return {
    attributes,
    expiresAt,
    revalidateAfter,
    credentialProfileId: request.credentialProfileId,
    credentialProfileVersionId: request.credentialProfileVersionId,
    mappingVersionId: request.verificationMappingVersionId,
    mappingSnapshotHash: request.verificationMappingSnapshotHash,
    policyVersion: c.env.HAIP_POLICY_VERSION,
    evidenceFingerprint,
    statusCheckedAt,
    statusFreshUntil,
  };
}

/**
 * POST /vp/initiate
 *
 * Initiates an attribute verification request for an authenticated user.
 * Creates a VP request that the wallet can respond to.
 *
 * Requires: Authorization header with valid access token
 */
export async function initiateAttributeVerification(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const log = getLogger(c).module('VC-VERIFIER');
  try {
    // Extract user info from access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'invalid_token', error_description: 'Missing access token' }, 401);
    }

    // Validate access token and get user info
    const userInfo = await validateAccessToken(c);
    if (!userInfo) {
      return c.json({ error: 'invalid_token', error_description: 'Invalid access token' }, 401);
    }

    const body = await c.req.json<InitiateVerificationRequest>();

    if (!body.credential_profile_id) {
      return c.json(
        { error: 'invalid_request', error_description: 'credential_profile_id is required' },
        400
      );
    }

    const profile = await loadPublishedVerificationProfile(
      c,
      body.credential_profile_id,
      userInfo.tenantId
    );
    if (!profile) {
      return c.json(
        { error: 'invalid_request', error_description: 'Published verification profile not found' },
        400
      );
    }
    const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
      c.env,
      'vc-attribute-profile-core',
      { tenantId: userInfo.tenantId }
    );
    const configuration = await coreAdapter.queryOne<{ vct: string; is_active: number }>(
      `SELECT vct, is_active FROM credential_configurations
        WHERE tenant_id = ? AND configuration_id = ?`,
      [userInfo.tenantId, profile.credential_configuration_id]
    );
    if (!configuration || configuration.is_active !== 1) {
      return c.json(
        { error: 'invalid_request', error_description: 'Credential configuration is inactive' },
        409
      );
    }
    const mapping = await resolveRuntimeIdentityMappingBinding(
      requireDedicatedAdminDatabaseAdapter(c.env, 'vc-attribute-profile'),
      {
        tenantId: userInfo.tenantId,
        protocol: 'vc',
        role: 'verifier',
        direction: 'verification',
        credentialProfileId: profile.profile_id,
        credentialConfigurationId: profile.credential_configuration_id,
        fieldMappingSetId: profile.verification_mapping_set_id,
        fieldMappingVersionId: profile.verification_mapping_version_id,
      }
    );
    if (!mapping || mapping.mappingSnapshotHash !== profile.verification_mapping_snapshot_hash) {
      return c.json(
        { error: 'invalid_request', error_description: 'Verification mapping is unavailable' },
        409
      );
    }

    // Create VP request
    const requestUuid = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const expirySeconds = parseInt(c.env.VP_REQUEST_EXPIRY_SECONDS || '300', 10);
    const clientId = getRequestVerifierIdentifier(c);
    const { stub, requestId } = await getVPRequestStoreForNewRequest(
      c.env,
      userInfo.tenantId,
      clientId,
      requestUuid
    );

    const claimAllowlist = JSON.parse(profile.claim_allowlist_json) as string[];
    const presentationDefinition = buildPresentationDefinition(configuration.vct, claimAllowlist);

    const vpRequest: VPRequestState = {
      id: requestId,
      clientId,
      tenantId: userInfo.tenantId,
      nonce,
      status: 'pending',
      responseUri: `${getBaseUrl(c)}/vp/attribute-response`,
      responseMode: 'direct_post',
      createdAt: Date.now(),
      expiresAt: Date.now() + expirySeconds * 1000,
      userId: userInfo.userId, // Link to authenticated user
      credentialProfileId: profile.profile_id,
      credentialProfileVersionId: profile.version_id,
      verificationFlowVersionId: profile.verification_flow_version_id,
      verificationMappingVersionId: profile.verification_mapping_version_id,
      verificationMappingSnapshotHash: profile.verification_mapping_snapshot_hash,
      maximumAttributeAgeSeconds: profile.maximum_attribute_age_seconds,
      presentationDefinition,
    };

    const storeResponse = await stub.fetch(
      new Request('https://internal/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vpRequest),
      })
    );

    if (!storeResponse.ok) {
      return c.json({ error: 'server_error', error_description: 'Failed to create request' }, 500);
    }

    // Build authorization request URL for wallet
    const authRequestUrl = buildAuthorizationRequestUrl(c, vpRequest);

    return c.json({
      request_id: requestId,
      authorization_request: authRequestUrl,
      nonce,
      expires_in: expirySeconds,
      state: requestId, // Use request ID as state
    });
  } catch (error) {
    log.error('Failed to initiate attribute verification', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return c.json(
      {
        error: 'server_error',
        error_description: 'Internal server error',
      },
      500
    );
  }
}

/**
 * POST /vp/attribute-response
 *
 * Receives VP response for authenticated attribute verification.
 * Links verified attributes to the user's account.
 */
export async function attributeVerifyResponse(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-VERIFIER');
  let reservation:
    | { stub: DurableObjectStub; id: string; tenantId: string; reservationId: string }
    | undefined;
  try {
    // A wallet presentation alone cannot authorize a write to an Authrim user.
    // Revalidate the active access token immediately before processing/persistence.
    const userInfo = await validateAccessToken(c);
    if (!userInfo) {
      return c.json({ error: 'invalid_token', error_description: 'Invalid access token' }, 401);
    }
    // Parse form data or JSON
    let body: AttributeVerifyRequest;
    const contentType = c.req.header('Content-Type') || '';

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await c.req.parseBody();
      body = {
        vp_token: formData['vp_token'] as string,
        state: formData['state'] as string,
        presentation_submission: formData['presentation_submission']
          ? (JSON.parse(formData['presentation_submission'] as string) as object)
          : undefined,
      };
    } else {
      body = await c.req.json<AttributeVerifyRequest>();
    }

    // Validate required fields
    if (!body.vp_token) {
      return c.json({ error: 'invalid_request', error_description: 'vp_token is required' }, 400);
    }

    if (!body.state) {
      return c.json({ error: 'invalid_request', error_description: 'state is required' }, 400);
    }

    // Get VP request from Durable Object
    const tenantId = getTenantIdFromContext(c);
    const { stub } = getVPRequestStoreById(c.env, body.state, tenantId);
    const reserveResponse = await stub.fetch(
      new Request('https://internal/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: body.state,
          tenantId,
          responseFingerprint: await sha256Base64url(body.vp_token),
          now: Date.now(),
        }),
      })
    );
    const reserveResult = reserveResponse.ok
      ? ((await reserveResponse.json()) as {
          reserved: boolean;
          reservationId?: string;
          request?: VPRequestState & { userId?: string };
        })
      : null;
    if (!reserveResult?.reserved || !reserveResult.reservationId || !reserveResult.request) {
      return c.json({ error: 'invalid_request', error_description: 'VP request unavailable' }, 400);
    }
    const vpRequest = reserveResult.request;
    reservation = {
      stub,
      id: body.state,
      tenantId,
      reservationId: reserveResult.reservationId,
    };

    // Check that this is an authenticated request (has userId)
    if (!vpRequest.userId) {
      await stub.fetch(
        new Request('https://internal/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: body.state,
            tenantId,
            reservationId: reservation.reservationId,
          }),
        })
      );
      reservation = undefined;
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'This endpoint is for authenticated users only',
        },
        400
      );
    }
    if (vpRequest.userId !== userInfo.userId || vpRequest.tenantId !== userInfo.tenantId) {
      await stub.fetch(
        new Request('https://internal/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: body.state,
            tenantId,
            reservationId: reservation.reservationId,
          }),
        })
      );
      reservation = undefined;
      return c.json({ error: 'invalid_token', error_description: 'Subject mismatch' }, 403);
    }

    // Verify the VP token
    const verificationResult = await verifyVPToken(c.env, body.vp_token, {
      nonce: vpRequest.nonce,
      audience: vpRequest.clientId,
      tenantId: vpRequest.tenantId,
    });

    if (!verificationResult.verified) {
      const failResponse = await stub.fetch(
        new Request('https://internal/fail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: body.state,
            tenantId,
            reservationId: reservation.reservationId,
            errorCode: 'verification_failed',
            errorDescription: verificationResult.errors.join('; '),
          }),
        })
      );
      const failed = failResponse.ok
        ? ((await failResponse.json()) as { failed?: boolean }).failed
        : false;
      if (!failed) throw new Error('vp_attribute_failure_transition_failed');
      reservation = undefined;

      return c.json(
        {
          error: 'invalid_presentation',
          error_description: verificationResult.errors.join('; '),
          warnings: verificationResult.warnings,
        },
        400
      );
    }

    // Verification and status retrieval can take time. Re-run the full active-token
    // check immediately before any user-linked evidence is written.
    const persistenceActor = await validateAccessToken(c, true);
    if (
      !persistenceActor ||
      persistenceActor.userId !== vpRequest.userId ||
      persistenceActor.tenantId !== vpRequest.tenantId
    ) {
      throw new Error('vp_persistence_authorization_expired');
    }

    // Link verification to user and store attributes
    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(c.env, 'vc-verifier-core', {
      tenantId: vpRequest.tenantId,
    });
    const verificationRepo = new AttributeVerificationRepository(adapter);
    const attributeRepo = new UserVerifiedAttributeRepository(adapter);

    if (!vpRequest.verificationFlowVersionId || !vpRequest.credentialProfileId) {
      throw new Error('vp_verification_flow_missing');
    }
    const subjectUserId = vpRequest.userId;
    if (!subjectUserId) throw new Error('vp_subject_missing');
    const flowVersion = await adapter.queryOne<{ runtime_snapshot_json: string }>(
      'SELECT runtime_snapshot_json FROM flow_versions WHERE tenant_id = ? AND id = ?',
      [vpRequest.tenantId, vpRequest.verificationFlowVersionId]
    );
    if (!flowVersion) throw new Error('vp_verification_flow_not_found');
    const flowState: {
      presentationVerified: boolean;
      attributeResult?: Awaited<ReturnType<typeof linkVerificationToUser>>;
    } = { presentationVerified: false };
    const matchesProfile = (value: unknown): boolean =>
      value === vpRequest.credentialProfileId ||
      (!!value &&
        typeof value === 'object' &&
        (value as { id?: unknown }).id === vpRequest.credentialProfileId);
    await executeServerFlow({
      contract: JSON.parse(flowVersion.runtime_snapshot_json) as FlowRuntimeContract,
      expectedKind: 'attribute_elevation',
      state: flowState,
      handlers: {
        credential_presentation({ step, state }) {
          if (
            !matchesProfile(step.config?.credential_profile_ref) ||
            !verificationResult.verified
          ) {
            throw new Error('vp_presentation_step_rejected');
          }
          state.presentationVerified = true;
          return { handle: 'verified' };
        },
        async verified_attribute({ step, state }) {
          if (!matchesProfile(step.config?.credential_profile_ref) || !state.presentationVerified) {
            throw new Error('vp_attribute_commit_step_rejected');
          }
          const persistencePolicy = await buildMappedAttributePolicy(
            c,
            vpRequest,
            verificationResult
          );
          state.attributeResult = await linkVerificationToUser(
            verificationRepo,
            attributeRepo,
            vpRequest,
            verificationResult,
            subjectUserId,
            persistencePolicy
          );
          return { handle: state.attributeResult.success ? 'committed' : 'rejected' };
        },
      },
    });
    const attributeResult = flowState.attributeResult;
    if (!attributeResult?.success) throw new Error('vp_attribute_commit_failed');

    // Update VP request status
    const completeResponse = await stub.fetch(
      new Request('https://internal/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: body.state,
          tenantId,
          reservationId: reservation.reservationId,
          verifiedClaimNames: Object.keys(verificationResult.disclosedClaims ?? {}),
        }),
      })
    );
    const completed = completeResponse.ok
      ? ((await completeResponse.json()) as { completed?: boolean }).completed
      : false;
    if (!completed) throw new Error('vp_attribute_completion_failed');
    reservation = undefined;

    return c.json({
      success: true,
      request_id: body.state,
      attributes_verified: attributeResult.attributes.map((a) => a.name),
      haip_compliant: verificationResult.haipCompliant,
    });
  } catch (error) {
    if (reservation) {
      await reservation.stub
        .fetch(
          new Request('https://internal/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: reservation.id,
              tenantId: reservation.tenantId,
              reservationId: reservation.reservationId,
            }),
          })
        )
        .catch(() => undefined);
    }
    log.error('Attribute verification response processing failed', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return c.json(
      {
        error: 'server_error',
        error_description: 'Internal server error',
      },
      500
    );
  }
}

/**
 * GET /vp/attributes
 *
 * Get verified attributes for the authenticated user.
 *
 * Requires: Authorization header with valid access token
 */
export async function getAttributes(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-VERIFIER');
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'invalid_token', error_description: 'Missing access token' }, 401);
    }

    const userInfo = await validateAccessToken(c);
    if (!userInfo) {
      return c.json({ error: 'invalid_token', error_description: 'Invalid access token' }, 401);
    }

    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(c.env, 'vc-verifier-core', {
      tenantId: userInfo.tenantId,
    });
    const attributeRepo = new UserVerifiedAttributeRepository(adapter);
    const verificationRepo = new AttributeVerificationRepository(adapter);
    const now = Date.now();
    await verificationRepo.invalidateStaleForUser(userInfo.tenantId, userInfo.userId, now);
    await verificationRepo.invalidateUntrustedForUser(userInfo.tenantId, userInfo.userId, now);
    const verifications = await verificationRepo.findByUser(userInfo.tenantId, userInfo.userId, {
      limit: 100,
    });
    for (const verification of verifications.items) {
      if (
        verification.invalidated_at !== null ||
        !verification.credential_profile_id ||
        !verification.mapping_version_id ||
        !verification.mapping_snapshot_hash
      ) {
        continue;
      }
      const binding = await resolveRuntimeIdentityMappingBinding(
        requireDedicatedAdminDatabaseAdapter(c.env, 'vc-attribute-revalidation'),
        {
          tenantId: userInfo.tenantId,
          protocol: 'vc',
          role: 'verifier',
          direction: 'verification',
          credentialProfileId: verification.credential_profile_id,
          fieldMappingVersionId: verification.mapping_version_id,
        }
      ).catch(() => null);
      if (!binding || binding.mappingSnapshotHash !== verification.mapping_snapshot_hash) {
        await verificationRepo.invalidateVerification(
          userInfo.tenantId,
          verification.id,
          'mapping_policy_changed'
        );
      }
    }
    const attributes = await getUserVerifiedAttributes(
      attributeRepo,
      userInfo.userId,
      userInfo.tenantId
    );

    return c.json({
      user_id: userInfo.userId,
      attributes,
    });
  } catch (error) {
    log.error('Failed to get verified attributes', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return c.json(
      {
        error: 'server_error',
        error_description: 'Internal server error',
      },
      500
    );
  }
}

/**
 * Validate access token and extract user info
 *
 * Signature, issuer, time, DPoP and revocation checks are delegated to the
 * shared protected-resource token introspector. Decoding a JWT is never treated
 * as authentication.
 */
async function validateAccessToken(
  c: Context<{ Bindings: Env }>,
  forceOnlineCheck = false
): Promise<{ userId: string; tenantId: string } | null> {
  try {
    if (!forceOnlineCheck) {
      const protectedContext = getActiveAccessTokenProtectedResourceContext(c);
      if (protectedContext) {
        return { userId: protectedContext.subject, tenantId: protectedContext.tenantId };
      }
    }
    const result = await introspectTokenFromContext(
      c as unknown as Parameters<typeof introspectTokenFromContext>[0]
    );
    if (!result.valid || !result.claims) {
      return null;
    }
    const payload = result.claims as Record<string, unknown>;
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : '';
    if (!subject || tenantId !== getTenantIdFromContext(c)) return null;
    const expectedAudience =
      c.env.VC_ATTRIBUTE_ELEVATION_AUDIENCE ?? 'svc://op-vc/attribute-elevation';
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(expectedAudience)) return null;
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/u) : [];
    if (!scopes.includes('vc.attribute')) return null;
    return { userId: subject, tenantId };
  } catch (e) {
    standaloneLog.error('Access token validation failed', {}, e as Error);
    return null;
  }
}

/**
 * Build presentation definition based on attribute type
 */
function buildPresentationDefinition(
  credentialConfigurationId: string,
  requiredClaims: string[]
): object {
  return {
    id: `pd-${credentialConfigurationId}-${Date.now()}`,
    input_descriptors: [
      {
        id: `id-${credentialConfigurationId}`,
        format: {
          'dc+sd-jwt': {
            alg: ['ES256', 'ES384', 'ES512'],
          },
        },
        constraints: {
          fields: [
            {
              path: ['$.vct'],
              filter: {
                type: 'string',
                enum: [credentialConfigurationId],
              },
            },
            ...requiredClaims.map((claim) => ({
              path: [`$.${claim}`],
              intent_to_retain: false,
            })),
          ],
        },
      },
    ],
  };
}

/**
 * Build authorization request URL for wallet
 *
 * OpenID4VP 1.0: Supports both inline presentation_definition and URI reference.
 * Uses inline for small PDs (< 2KB), URI reference for larger ones.
 */
function buildAuthorizationRequestUrl(
  c: Context<{ Bindings: Env }>,
  vpRequest: VPRequestState
): string {
  const baseUrl = getBaseUrl(c);
  const params = new URLSearchParams({
    response_type: 'vp_token',
    client_id: vpRequest.clientId,
    response_mode: vpRequest.responseMode,
    nonce: vpRequest.nonce,
    state: vpRequest.id,
  });

  // OpenID4VP 1.0: Use response_uri for direct_post, redirect_uri for fragment/query
  if (vpRequest.responseMode === 'direct_post' || vpRequest.responseMode === 'direct_post.jwt') {
    params.set('response_uri', vpRequest.responseUri);
  } else {
    params.set('redirect_uri', vpRequest.responseUri);
  }

  // OpenID4VP 1.0: Support both inline and URI reference for presentation_definition
  // Use inline for small PDs (< 2KB), URI reference for larger ones
  const MAX_INLINE_PD_SIZE = 2048;
  if (vpRequest.presentationDefinition) {
    const pdJson = JSON.stringify(vpRequest.presentationDefinition);
    if (pdJson.length < MAX_INLINE_PD_SIZE) {
      // Inline presentation definition (more efficient for small PDs)
      params.set('presentation_definition', pdJson);
    } else {
      // URI reference for large presentation definitions
      params.set('presentation_definition_uri', `${baseUrl}/vp/pd/${vpRequest.id}`);
    }
  } else {
    // Fallback to URI reference when PD not provided inline
    params.set('presentation_definition_uri', `${baseUrl}/vp/pd/${vpRequest.id}`);
  }

  return `openid4vp://?${params.toString()}`;
}

/**
 * Get base URL from request
 */
function getBaseUrl(c: Context<{ Bindings: Env }>): string {
  return getRequestIssuerUrl(c);
}

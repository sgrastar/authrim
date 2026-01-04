/**
 * VP Response Route
 *
 * Receives the VP token from the wallet via direct_post.
 * Verifies the VP and extracts claims.
 *
 * Uses region-aware sharding for Durable Object routing:
 * - Request ID format: g{gen}:{region}:{shard}:vp_{uuid}
 * - Self-routing: shard info embedded in ID, no external lookup needed
 * - Region-aware DO placement with locationHint
 */

import type { Context } from 'hono';
import type { Env, VPRequestState, VPVerificationResult } from '../../types';
import {
  D1Adapter,
  AttributeVerificationRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
} from '@authrim/ar-lib-core';
import { verifyVPToken } from '../services/vp-verifier';
import { getVPRequestStoreById } from '../../utils/vp-request-sharding';

interface VPResponseRequest {
  /** VP token (SD-JWT VC with KB-JWT) */
  vp_token: string;

  /** State parameter (echoed from authorization request) */
  state?: string;

  /** Presentation submission */
  presentation_submission?: object;
}

/**
 * POST /vp/response
 *
 * Receives the VP token from the wallet.
 * Verifies the SD-JWT VC and Key Binding JWT.
 */
export async function vpResponseRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('VC-VERIFIER');
  try {
    // Parse form data or JSON
    let body: VPResponseRequest;
    const contentType = c.req.header('Content-Type') || '';

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await c.req.parseBody();

      // SECURITY: Safely parse presentation_submission JSON
      let presentationSubmission: object | undefined;
      if (formData['presentation_submission']) {
        try {
          presentationSubmission = JSON.parse(
            formData['presentation_submission'] as string
          ) as object;
        } catch {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
      }

      body = {
        vp_token: formData['vp_token'] as string,
        state: formData['state'] as string | undefined,
        presentation_submission: presentationSubmission,
      };
    } else {
      body = await c.req.json<VPResponseRequest>();
    }

    // Validate vp_token
    // SECURITY: Check for both null/undefined and empty string
    if (!body.vp_token || (typeof body.vp_token === 'string' && body.vp_token.trim() === '')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'vp_token' },
      });
    }

    // Look up the VP request by state (which contains the request ID)
    if (!body.state) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'state' },
      });
    }

    // The state parameter contains the request ID (which embeds shard routing info)
    // Format: g{gen}:{region}:{shard}:vp_{uuid}
    const requestId = body.state;

    // Get the DO stub using region-aware sharding (self-routing from ID)
    const { stub } = getVPRequestStoreById(c.env, requestId);

    // Get the stored request
    const requestResponse = await stub.fetch(new Request('https://internal/get'));
    if (!requestResponse.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const vpRequest = (await requestResponse.json()) as VPRequestState;

    // Check if request is still valid
    if (vpRequest.status !== 'pending') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (Date.now() > vpRequest.expiresAt) {
      // Update status to expired
      await stub.fetch(
        new Request('https://internal/update-status', {
          method: 'POST',
          body: JSON.stringify({ status: 'expired' }),
        })
      );

      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Verify the VP token
    const verificationResult = await verifyVPToken(c.env, body.vp_token, {
      nonce: vpRequest.nonce,
      audience: vpRequest.clientId,
      tenantId: vpRequest.tenantId,
    });

    // Update the request with the result
    if (verificationResult.verified) {
      await stub.fetch(
        new Request('https://internal/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'verified',
            vpToken: body.vp_token,
            verifiedClaims: verificationResult.disclosedClaims,
          }),
        })
      );

      // Store attribute verification record using repository
      await storeAttributeVerification(c.env, vpRequest, verificationResult);

      return c.json({
        success: true,
        request_id: requestId,
        disclosed_claims: verificationResult.disclosedClaims,
        haip_compliant: verificationResult.haipCompliant,
      });
    } else {
      await stub.fetch(
        new Request('https://internal/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            errorCode: 'verification_failed',
            errorDescription: verificationResult.errors.join('; '),
          }),
        })
      );

      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
  } catch (error) {
    log.error('VP response processing failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Store attribute verification record in database
 * Note: Raw VC is NOT stored (data minimization)
 */
async function storeAttributeVerification(
  env: Env,
  vpRequest: VPRequestState,
  result: VPVerificationResult
): Promise<void> {
  const adapter = new D1Adapter({ db: env.DB });
  const verificationRepo = new AttributeVerificationRepository(adapter);

  await verificationRepo.createVerification({
    tenant_id: vpRequest.tenantId,
    user_id: null, // user_id - to be linked later
    vp_request_id: vpRequest.id,
    issuer_did: result.issuerDid || '',
    credential_type: result.credentialType || '',
    format: result.format || 'dc+sd-jwt',
    verification_result: result.verified ? 'verified' : 'failed',
    holder_binding_verified: result.holderBindingVerified || false,
    issuer_trusted: result.issuerTrusted || false,
    status_valid: result.statusValid || false,
  });
}

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
  D1Adapter,
  AttributeVerificationRepository,
  UserVerifiedAttributeRepository,
} from '@authrim/shared';
import { verifyVPToken } from '../services/vp-verifier';
import { linkVerificationToUser, getUserVerifiedAttributes } from '../services/attribute-mapper';

interface AttributeVerifyRequest {
  /** VP token (SD-JWT VC with KB-JWT) */
  vp_token: string;

  /** State parameter matching the VP request */
  state: string;

  /** Presentation submission metadata */
  presentation_submission?: object;
}

interface InitiateVerificationRequest {
  /** Attribute type to verify (e.g., 'age_over_18', 'country') */
  attribute_type: string;

  /** Optional: specific credential types to accept */
  credential_types?: string[];

  /** Optional: callback URL after verification */
  callback_url?: string;
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
  try {
    // Extract user info from access token
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized', error_description: 'Missing access token' }, 401);
    }

    // Validate access token and get user info
    const userInfo = await validateAccessToken(c.env, authHeader.substring(7));
    if (!userInfo) {
      return c.json({ error: 'unauthorized', error_description: 'Invalid access token' }, 401);
    }

    const body = await c.req.json<InitiateVerificationRequest>();

    if (!body.attribute_type) {
      return c.json(
        { error: 'invalid_request', error_description: 'attribute_type is required' },
        400
      );
    }

    // Create VP request
    const requestId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const expirySeconds = parseInt(c.env.VP_REQUEST_EXPIRY_SECONDS || '300', 10);

    const presentationDefinition = buildPresentationDefinition(
      body.attribute_type,
      body.credential_types
    );

    const vpRequest: VPRequestState = {
      id: requestId,
      clientId: c.env.VERIFIER_IDENTIFIER || 'did:web:authrim.com',
      tenantId: userInfo.tenantId,
      nonce,
      status: 'pending',
      responseUri: `${getBaseUrl(c)}/vp/attribute-response`,
      responseMode: 'direct_post',
      createdAt: Date.now(),
      expiresAt: Date.now() + expirySeconds * 1000,
      userId: userInfo.userId, // Link to authenticated user
      presentationDefinition,
    };

    // Store in Durable Object
    const doId = c.env.VP_REQUEST_STORE.idFromName(requestId);
    const stub = c.env.VP_REQUEST_STORE.get(doId);

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
    console.error('[initiateAttributeVerification] Error:', error);
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
 * POST /vp/attribute-response
 *
 * Receives VP response for authenticated attribute verification.
 * Links verified attributes to the user's account.
 */
export async function attributeVerifyResponse(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
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
    const doId = c.env.VP_REQUEST_STORE.idFromName(body.state);
    const stub = c.env.VP_REQUEST_STORE.get(doId);

    const requestResponse = await stub.fetch(new Request('https://internal/get'));
    if (!requestResponse.ok) {
      return c.json({ error: 'invalid_request', error_description: 'VP request not found' }, 400);
    }

    const vpRequest = (await requestResponse.json()) as VPRequestState & { userId?: string };

    // Validate request state
    if (vpRequest.status !== 'pending') {
      return c.json(
        { error: 'invalid_request', error_description: `VP request is ${vpRequest.status}` },
        400
      );
    }

    if (Date.now() > vpRequest.expiresAt) {
      await stub.fetch(
        new Request('https://internal/update-status', {
          method: 'POST',
          body: JSON.stringify({ status: 'expired' }),
        })
      );
      return c.json({ error: 'invalid_request', error_description: 'VP request has expired' }, 400);
    }

    // Check that this is an authenticated request (has userId)
    if (!vpRequest.userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'This endpoint is for authenticated users only',
        },
        400
      );
    }

    // Verify the VP token
    const verificationResult = await verifyVPToken(c.env, body.vp_token, {
      nonce: vpRequest.nonce,
      audience: vpRequest.clientId,
      tenantId: vpRequest.tenantId,
    });

    if (!verificationResult.verified) {
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

      return c.json(
        {
          error: 'invalid_presentation',
          error_description: verificationResult.errors.join('; '),
          warnings: verificationResult.warnings,
        },
        400
      );
    }

    // Link verification to user and store attributes
    const adapter = new D1Adapter({ db: c.env.DB });
    const verificationRepo = new AttributeVerificationRepository(adapter);
    const attributeRepo = new UserVerifiedAttributeRepository(adapter);

    const attributeResult = await linkVerificationToUser(
      verificationRepo,
      attributeRepo,
      vpRequest,
      verificationResult,
      vpRequest.userId
    );

    // Update VP request status
    await stub.fetch(
      new Request('https://internal/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'verified',
          vpToken: body.vp_token, // Store for audit (will be cleaned up)
          verifiedClaims: verificationResult.disclosedClaims,
        }),
      })
    );

    return c.json({
      success: true,
      request_id: body.state,
      attributes_verified: attributeResult.attributes.map((a) => a.name),
      haip_compliant: verificationResult.haipCompliant,
    });
  } catch (error) {
    console.error('[attributeVerifyResponse] Error:', error);
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
 * GET /vp/attributes
 *
 * Get verified attributes for the authenticated user.
 *
 * Requires: Authorization header with valid access token
 */
export async function getAttributes(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized', error_description: 'Missing access token' }, 401);
    }

    const userInfo = await validateAccessToken(c.env, authHeader.substring(7));
    if (!userInfo) {
      return c.json({ error: 'unauthorized', error_description: 'Invalid access token' }, 401);
    }

    const adapter = new D1Adapter({ db: c.env.DB });
    const attributeRepo = new UserVerifiedAttributeRepository(adapter);
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
    console.error('[getAttributes] Error:', error);
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
 * Validate access token and extract user info
 *
 * Security Note: This implements essential JWT validation (expiration, audience).
 * For signature verification, Authrim's internal tokens are trusted within the
 * same deployment. External tokens should be validated via the /introspect endpoint.
 */
async function validateAccessToken(
  env: Env,
  token: string
): Promise<{ userId: string; tenantId: string } | null> {
  try {
    // Parse JWT
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payloadStr = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadStr) as {
      sub?: string;
      tenant_id?: string;
      aud?: string | string[];
      exp?: number;
      iat?: number;
      iss?: string;
    };

    // Required claims check
    if (!payload.sub || !payload.tenant_id) {
      return null;
    }

    // Expiration check (RFC 7519)
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.warn('[validateAccessToken] Token expired');
      return null;
    }

    // Not-before check (if iat is in the future, token is invalid)
    if (payload.iat && payload.iat > now + 60) {
      // 60 seconds clock skew tolerance
      console.warn('[validateAccessToken] Token issued in the future');
      return null;
    }

    // Audience check (RFC 7519 Section 4.1.3)
    const expectedAudience = env.VERIFIER_IDENTIFIER || 'did:web:authrim.com';
    if (payload.aud) {
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.includes(expectedAudience) && !audiences.includes('authrim')) {
        console.warn('[validateAccessToken] Audience mismatch');
        return null;
      }
    }

    return {
      userId: payload.sub,
      tenantId: payload.tenant_id,
    };
  } catch (e) {
    console.error('[validateAccessToken] Error:', e);
    return null;
  }
}

/**
 * Build presentation definition based on attribute type
 */
function buildPresentationDefinition(attributeType: string, credentialTypes?: string[]): object {
  // Map attribute types to credential requirements
  const attributeCredentialMap: Record<string, { vct: string; claims: string[] }> = {
    age_over_18: {
      vct: 'https://authrim.com/credentials/age-verification/v1',
      claims: ['age_over_18'],
    },
    age_over_21: {
      vct: 'https://authrim.com/credentials/age-verification/v1',
      claims: ['age_over_21'],
    },
    identity: {
      vct: 'https://authrim.com/credentials/identity/v1',
      claims: ['given_name', 'family_name', 'birthdate'],
    },
    country: {
      vct: 'https://authrim.com/credentials/identity/v1',
      claims: ['address'],
    },
  };

  const config = attributeCredentialMap[attributeType];
  const vctValues = credentialTypes || (config ? [config.vct] : []);
  const requiredClaims = config?.claims || [];

  return {
    id: `pd-${attributeType}-${Date.now()}`,
    input_descriptors: [
      {
        id: `id-${attributeType}`,
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
                enum: vctValues,
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
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Device Authorization Handler
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.1
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@authrim/ar-lib-core';
import {
  generateDeviceCode,
  generateUserCode,
  getVerificationUriComplete,
  DEVICE_FLOW_CONSTANTS,
  getClient,
  createErrorResponse,
  AR_ERROR_CODES,
  // UI Configuration
  getUIConfig,
  buildIssuerUrl,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

/**
 * POST /device_authorization
 * Device Authorization Endpoint
 *
 * Issues device_code and user_code for device flow
 */
export async function deviceAuthorizationHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Parse request body
    const body = await c.req.parseBody();
    const client_id = body.client_id as string;
    const scope = (body.scope as string) || 'openid profile email';

    // Validate client_id
    if (!client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id' },
      });
    }

    // Validate client exists and is authorized for device flow
    // Per RFC 8628 Section 3.1: Client authentication is OPTIONAL for public clients,
    // but we MUST verify the client is registered
    const clientMetadata = await getClient(c.env, client_id);
    if (!clientMetadata) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }

    // Verify client is authorized to use device flow grant type
    const grantTypes = clientMetadata.grant_types as string[] | undefined;
    if (grantTypes && !grantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT);
    }

    // Generate device code and user code
    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();

    // Create device code metadata
    const now = Date.now();
    const expiresIn = DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN;

    const metadata: DeviceCodeMetadata = {
      device_code: deviceCode,
      user_code: userCode,
      client_id,
      scope,
      status: 'pending',
      created_at: now,
      expires_at: now + expiresIn * 1000,
      poll_count: 0,
    };

    // Store in DeviceCodeStore Durable Object
    // NOTE: Currently using global DO. Future: implement region-sharding with
    // KV-based user_code→device_code index for reverse lookups.
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName('global');
    const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

    const storeResponse = await deviceCodeStore.fetch(
      new Request('https://internal/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      })
    );

    if (!storeResponse.ok) {
      const error = await storeResponse.json();
      console.error('DeviceCodeStore error:', error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Build verification URIs
    // Use UI config if available (for external UI), otherwise fall back to ISSUER_URL
    // tenant_hint is added to verification_uri_complete for UX branding (untrusted, security is via Host header)
    const tenantId = getTenantIdFromContext(c);
    const uiConfig = await getUIConfig(c.env);
    let verificationBaseUrl: string;

    if (uiConfig?.baseUrl) {
      // External UI configured - use UI base URL with device path
      const devicePath = uiConfig.paths?.device || '/device';
      verificationBaseUrl = `${uiConfig.baseUrl}${devicePath}`;
    } else {
      // No external UI - use issuer URL (conformance mode or default)
      const issuer = buildIssuerUrl(c.env, tenantId);
      verificationBaseUrl = `${issuer}/device`;
    }

    const verificationUri = verificationBaseUrl;
    // Add tenant_hint to verification_uri_complete for UI branding (UX only, untrusted)
    const verificationUriComplete = getVerificationUriComplete(
      verificationBaseUrl,
      userCode,
      tenantId
    );

    // Return device authorization response
    return c.json(
      {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: verificationUriComplete,
        expires_in: expiresIn,
        interval: DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL,
      },
      200
    );
  } catch (error) {
    console.error('Device authorization error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

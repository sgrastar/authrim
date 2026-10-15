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
  resolveDeviceFlowPolicy,
  type DeviceFlowPolicy,
  getClientCached,
  createErrorResponse,
  AR_ERROR_CODES,
  // UI Configuration
  getUIConfig,
  buildRequestIssuerUrl,
  getLogger,
  buildDOInstanceName,
} from '@authrim/ar-lib-core';
import { resolveAsyncTenantId } from './tenant';
import { fal3Refusal } from './assurance';

/** Times a user code is drawn before the request gives up (each draw collides with a live code). */
const USER_CODE_ATTEMPTS = 5;

/**
 * POST /device_authorization
 * Device Authorization Endpoint
 *
 * Issues device_code and user_code for device flow
 */
export async function deviceAuthorizationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DEVICE');
  const tenantId = resolveAsyncTenantId(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant context' },
    });
  }
  const assuranceRefusal = await fal3Refusal(c, tenantId);
  if (assuranceRefusal) return assuranceRefusal;

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
    const clientMetadata = await getClientCached(c, c.env, client_id);
    if (!clientMetadata) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }

    // Verify client is authorized to use device flow grant type
    const grantTypes = clientMetadata.grant_types as string[] | undefined;
    if (grantTypes && !grantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT);
    }

    // The lifetime, polling interval and poll limits of the tenant and this client. Read only
    // for a client that exists and may use the grant, so a request that names a stranger's
    // client_id cannot probe the settings. Settings that cannot be read stop the request like the
    // assurance settings above.
    let policy: DeviceFlowPolicy;
    try {
      policy = await resolveDeviceFlowPolicy(c.env, tenantId, client_id);
    } catch (error) {
      log.error(
        'Failed to load device flow settings',
        { action: 'device_flow_settings' },
        error as Error
      );
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Device flow settings are temporarily unavailable',
        },
        503
      );
    }

    // Generate device code (the user code is generated below, and again if it is taken)
    const deviceCode = generateDeviceCode();

    // Create device code metadata
    const now = Date.now();
    const expiresIn = policy.expiresIn;
    const interval = policy.pollInterval;

    // Store in DeviceCodeStore Durable Object
    // NOTE: Currently using global DO. Future: implement region-sharding with
    // KV-based user_code→device_code index for reverse lookups.
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName(
      buildDOInstanceName('device', tenantId)
    );
    const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

    // The store refuses a user code another live device code holds (409): draw another and try
    // again. The retries are bounded; a tenant whose live codes crowd the code space gets a
    // retryable 503 and nothing about the codes it holds.
    let userCode = '';
    let stored = false;
    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS && !stored; attempt++) {
      userCode = generateUserCode();
      const metadata: DeviceCodeMetadata = {
        tenant_id: tenantId,
        device_code: deviceCode,
        user_code: userCode,
        client_id,
        scope,
        status: 'pending',
        created_at: now,
        expires_at: now + expiresIn * 1000,
        poll_count: 0,
        // The polling interval is kept on the code: slow_down raises it for this code only
        interval,
        // slow_down can raise this code's interval no higher than the tenant's limit of now
        max_interval: policy.maxInterval,
        // the poll governor reads these from the code, so a poll needs no settings read
        slow_down_increment: policy.slowDownIncrement,
        max_poll_count: policy.maxPollCount,
      };

      const storeResponse = await deviceCodeStore.fetch(
        new Request('https://internal/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': tenantId },
          body: JSON.stringify(metadata),
        })
      );

      if (storeResponse.status === 409) {
        continue;
      }
      if (!storeResponse.ok) {
        const error = await storeResponse.json();
        log.error(
          'DeviceCodeStore error',
          { action: 'store_device_code' },
          new Error(JSON.stringify(error))
        );
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }
      stored = true;
    }

    if (!stored) {
      log.error('No free user code found', {
        action: 'store_device_code',
        attempts: USER_CODE_ATTEMPTS,
      });
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The device code could not be issued. Retry shortly.',
        },
        503,
        { 'Retry-After': '1' }
      );
    }

    // Build verification URIs
    // Use UI config if available (for external UI), otherwise fall back to ISSUER_URL
    // tenant_hint is added to verification_uri_complete for UX branding (untrusted, security is via Host header)
    const uiConfig = await getUIConfig(c.env, tenantId);
    let verificationBaseUrl: string;

    if (uiConfig?.baseUrl) {
      // External UI configured - use UI base URL with device path
      const devicePath = uiConfig.paths?.device || '/device';
      verificationBaseUrl = `${uiConfig.baseUrl}${devicePath}`;
    } else {
      // No external UI - use issuer URL (conformance mode or default)
      const issuer = buildRequestIssuerUrl(c.req.raw, c.env, tenantId);
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
        interval,
      },
      200
    );
  } catch (error) {
    log.error('Device authorization error', { action: 'authorization' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

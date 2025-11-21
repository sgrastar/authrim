/**
 * Device Authorization Handler
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.1
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@authrim/shared';
import {
  generateDeviceCode,
  generateUserCode,
  getVerificationUriComplete,
  DEVICE_FLOW_CONSTANTS,
  getClient,
} from '@authrim/shared';

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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_id is required',
        },
        400
      );
    }

    // Validate client exists and is authorized for device flow
    // Per RFC 8628 Section 3.1: Client authentication is OPTIONAL for public clients,
    // but we MUST verify the client is registered
    const clientMetadata = await getClient(c.env, client_id);
    if (!clientMetadata) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client not found or not registered',
        },
        400
      );
    }

    // Verify client is authorized to use device flow grant type
    const grantTypes = clientMetadata.grant_types as string[] | undefined;
    if (grantTypes && !grantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
      return c.json(
        {
          error: 'unauthorized_client',
          error_description: 'Client is not authorized to use device flow',
        },
        400
      );
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
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to store device code',
        },
        500
      );
    }

    // Build verification URIs
    // Use UI_BASE_URL if available (for SvelteKit UI), otherwise fall back to ISSUER_URL
    const uiBaseUrl = c.env.UI_BASE_URL || c.env.ISSUER_URL;
    const baseUri = `${uiBaseUrl}/device`;
    const verificationUri = baseUri;
    const verificationUriComplete = getVerificationUriComplete(baseUri, userCode);

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
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

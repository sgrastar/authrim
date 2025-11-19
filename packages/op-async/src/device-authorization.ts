/**
 * Device Authorization Handler
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.1
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@enrai/shared';
import {
  generateDeviceCode,
  generateUserCode,
  getVerificationUriComplete,
  DEVICE_FLOW_CONSTANTS,
} from '@enrai/shared';

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

    // TODO: Validate client exists (optional for device flow per RFC 8628)
    // For now, we accept any client_id

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
    const baseUri = `${c.env.ISSUER_URL}/device`;
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

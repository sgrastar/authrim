/**
 * CIBA Push Mode Token Delivery
 * OpenID Connect CIBA Core 1.0
 *
 * In push mode, the OP sends the tokens directly to the client's callback endpoint
 * instead of requiring the client to poll the token endpoint.
 */

import { isInternalUrl } from '../utils/url-security';

/**
 * Send tokens directly to client in push mode
 * @param clientNotificationEndpoint - Client's callback URL
 * @param clientNotificationToken - Bearer token for authentication
 * @param authReqId - Authentication request ID
 * @param accessToken - Access token
 * @param idToken - ID token
 * @param refreshToken - Refresh token (optional)
 * @param expiresIn - Token expiration time in seconds
 * @returns Promise<void>
 */
export async function sendPushModeTokens(
  clientNotificationEndpoint: string,
  clientNotificationToken: string,
  authReqId: string,
  accessToken: string,
  idToken: string,
  refreshToken: string | null,
  expiresIn: number
): Promise<void> {
  try {
    // SSRF protection: Block requests to internal addresses
    if (isInternalUrl(clientNotificationEndpoint)) {
      throw new Error('SSRF protection: Cannot send tokens to internal addresses');
    }

    const payload: Record<string, unknown> = {
      auth_req_id: authReqId,
      access_token: accessToken,
      token_type: 'Bearer',
      id_token: idToken,
      expires_in: expiresIn,
    };

    if (refreshToken) {
      payload.refresh_token = refreshToken;
    }

    const response = await fetch(clientNotificationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientNotificationToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[CIBA] Push mode token delivery failed:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
        authReqId,
      });
      throw new Error(`Push mode token delivery failed: ${response.status} ${response.statusText}`);
    }

    console.log('[CIBA] Push mode tokens delivered successfully:', {
      authReqId,
      endpoint: clientNotificationEndpoint,
    });
  } catch (error) {
    console.error('[CIBA] Push mode token delivery error:', error);
    throw error;
  }
}

/**
 * Validate push mode requirements
 * @param clientNotificationEndpoint - Client's callback URL
 * @param clientNotificationToken - Bearer token for authentication
 * @returns boolean
 */
export function validatePushModeRequirements(
  clientNotificationEndpoint: string | null | undefined,
  clientNotificationToken: string | null | undefined
): boolean {
  if (!clientNotificationEndpoint || !clientNotificationToken) {
    return false;
  }

  // Validate URL format
  let parsed: URL;
  try {
    parsed = new URL(clientNotificationEndpoint);
  } catch {
    return false;
  }

  // Ensure HTTPS in production (allow http://localhost or 127.0.0.1 for development)
  const isHttps = parsed.protocol === 'https:';
  const isLocalDev =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (!isHttps && !isLocalDev) {
    return false;
  }

  // SSRF protection: Block internal addresses (except localhost/127.0.0.1 for dev)
  if (isInternalUrl(clientNotificationEndpoint) && !isLocalDev) {
    return false;
  }

  return true;
}

/**
 * CIBA Push Mode Token Delivery
 * OpenID Connect CIBA Core 1.0
 *
 * In push mode, the OP sends the tokens directly to the client's callback endpoint
 * instead of requiring the client to poll the token endpoint.
 *
 * Security measures:
 * - SSRF protection: Blocks requests to internal/private addresses
 * - Timeout: Prevents hanging requests (5 seconds)
 * - Response size limit: Prevents DoS from large responses (64KB)
 * - HTTPS required: Ensures secure transport (configurable for dev)
 */

import { safeFetch, isInternalUrl } from '../utils/url-security';

/** Push notification timeout (5 seconds) */
const PUSH_NOTIFICATION_TIMEOUT_MS = 5000;

/** Maximum response size for push notification (64KB is more than enough) */
const PUSH_NOTIFICATION_MAX_RESPONSE_SIZE = 64 * 1024;

/**
 * Send tokens directly to client in push mode
 *
 * @param clientNotificationEndpoint - Client's callback URL (must be HTTPS in production)
 * @param clientNotificationToken - Bearer token for authentication
 * @param authReqId - Authentication request ID
 * @param accessToken - Access token
 * @param idToken - ID token
 * @param refreshToken - Refresh token (optional)
 * @param expiresIn - Token expiration time in seconds
 * @param options - Additional options
 * @returns Promise<void>
 */
export async function sendPushModeTokens(
  clientNotificationEndpoint: string,
  clientNotificationToken: string,
  authReqId: string,
  accessToken: string,
  idToken: string,
  refreshToken: string | null,
  expiresIn: number,
  options: {
    /** Allow http://localhost for development (default: false) */
    allowLocalhost?: boolean;
    /** Custom timeout in milliseconds (default: 5000) */
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const { allowLocalhost = false, timeoutMs = PUSH_NOTIFICATION_TIMEOUT_MS } = options;

  try {
    // Defense in depth: double-check SSRF protection
    if (isInternalUrl(clientNotificationEndpoint)) {
      console.error('[CIBA] SSRF blocked - internal address in notification endpoint:', {
        authReqId,
      });
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

    // Use safeFetch for comprehensive protection (SSRF, timeout, size limits)
    const response = await safeFetch(clientNotificationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientNotificationToken}`,
      },
      body: JSON.stringify(payload),
      requireHttps: true,
      allowLocalhost,
      timeoutMs,
      maxResponseSize: PUSH_NOTIFICATION_MAX_RESPONSE_SIZE,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[CIBA] Push mode token delivery failed:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText.substring(0, 200), // Truncate for logging
        authReqId,
      });
      throw new Error(`Push token delivery failed: ${response.status} ${response.statusText}`);
    }

    console.log('[CIBA] Push mode tokens delivered successfully:', {
      authReqId,
      // Log sanitized endpoint info (host only)
      endpointHost: new URL(clientNotificationEndpoint).host,
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

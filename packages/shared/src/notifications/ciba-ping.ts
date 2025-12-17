/**
 * CIBA Ping Mode Notification
 * OpenID Connect CIBA Core 1.0
 *
 * In ping mode, the OP sends a notification to the client's callback endpoint
 * when the authentication request has been approved or denied.
 */

import { isInternalUrl } from '../utils/url-security';

/**
 * Send ping notification to client
 * @param clientNotificationEndpoint - Client's callback URL
 * @param clientNotificationToken - Bearer token for authentication
 * @param authReqId - Authentication request ID
 * @returns Promise<void>
 */
export async function sendPingNotification(
  clientNotificationEndpoint: string,
  clientNotificationToken: string,
  authReqId: string
): Promise<void> {
  try {
    // SSRF protection: Block requests to internal addresses
    if (isInternalUrl(clientNotificationEndpoint)) {
      throw new Error('SSRF protection: Cannot send notifications to internal addresses');
    }

    const response = await fetch(clientNotificationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientNotificationToken}`,
      },
      body: JSON.stringify({
        auth_req_id: authReqId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[CIBA] Ping notification failed:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
        authReqId,
      });
      throw new Error(`Ping notification failed: ${response.status} ${response.statusText}`);
    }

    console.log('[CIBA] Ping notification sent successfully:', {
      authReqId,
      endpoint: clientNotificationEndpoint,
    });
  } catch (error) {
    console.error('[CIBA] Ping notification error:', error);
    throw error;
  }
}

/**
 * Validate ping mode requirements
 * @param clientNotificationEndpoint - Client's callback URL
 * @param clientNotificationToken - Bearer token for authentication
 * @returns boolean
 */
export function validatePingModeRequirements(
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

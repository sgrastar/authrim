/**
 * CIBA Ping Mode Notification
 * OpenID Connect CIBA Core 1.0
 *
 * In ping mode, the OP sends a notification to the client's callback endpoint
 * when the authentication request has been approved or denied.
 *
 * Security measures:
 * - SSRF protection: Blocks requests to internal/private addresses
 * - Timeout: Prevents hanging requests (5 seconds)
 * - Response size limit: Prevents DoS from large responses (64KB)
 * - HTTPS required: Ensures secure transport (configurable for dev)
 */

import { safeFetch, isInternalUrl } from '../utils/url-security';

/** Ping notification timeout (5 seconds) */
const PING_NOTIFICATION_TIMEOUT_MS = 5000;

/** Maximum response size for ping notification (64KB is more than enough) */
const PING_NOTIFICATION_MAX_RESPONSE_SIZE = 64 * 1024;

/**
 * Send ping notification to client
 *
 * @param clientNotificationEndpoint - Client's callback URL (must be HTTPS in production)
 * @param clientNotificationToken - Bearer token for authentication
 * @param authReqId - Authentication request ID
 * @param options - Additional options
 * @returns Promise<void>
 */
export async function sendPingNotification(
  clientNotificationEndpoint: string,
  clientNotificationToken: string,
  authReqId: string,
  options: {
    /** Allow http://localhost for development (default: false) */
    allowLocalhost?: boolean;
    /** Custom timeout in milliseconds (default: 5000) */
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const { allowLocalhost = false, timeoutMs = PING_NOTIFICATION_TIMEOUT_MS } = options;

  try {
    // Additional logging for debugging (endpoint is already validated during registration)
    if (isInternalUrl(clientNotificationEndpoint)) {
      // This should have been caught during client registration,
      // but double-check as defense in depth
      console.error('[CIBA] SSRF blocked - internal address in notification endpoint:', {
        authReqId,
        // Don't log the full endpoint to avoid leaking internal URLs in logs
      });
      throw new Error('SSRF protection: Cannot send notifications to internal addresses');
    }

    // Use safeFetch for comprehensive protection (SSRF, timeout, size limits)
    const response = await safeFetch(clientNotificationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientNotificationToken}`,
      },
      body: JSON.stringify({
        auth_req_id: authReqId,
      }),
      requireHttps: true,
      allowLocalhost,
      timeoutMs,
      maxResponseSize: PING_NOTIFICATION_MAX_RESPONSE_SIZE,
    });

    if (!response.ok) {
      // Read error response with size limit already applied by safeFetch
      const errorText = await response.text();
      console.error('[CIBA] Ping notification failed:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText.substring(0, 200), // Truncate error for logging
        authReqId,
      });
      throw new Error(`Ping notification failed: ${response.status} ${response.statusText}`);
    }

    console.log('[CIBA] Ping notification sent successfully:', {
      authReqId,
      // Log sanitized endpoint info (host only)
      endpointHost: new URL(clientNotificationEndpoint).host,
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

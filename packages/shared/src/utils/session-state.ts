/**
 * OIDC Session Management 1.0 - Session State Utilities
 * https://openid.net/specs/openid-connect-session-1_0.html
 *
 * Provides functions for calculating and validating session state values
 * used in the OIDC Session Management specification.
 */

import { arrayBufferToBase64Url, generateSecureRandomString } from './crypto';

/**
 * Calculate the session state value according to OIDC Session Management 1.0
 *
 * The session state is calculated as:
 * session_state = hash(client_id + " " + origin + " " + op_browser_state [+ " " + salt]) . salt
 *
 * @param clientId - The client identifier
 * @param origin - The origin of the RP (e.g., "https://example.com")
 * @param opBrowserState - The OP's browser state (typically the session ID)
 * @param salt - Optional salt value (will be generated if not provided)
 * @returns The session state value in format "hash.salt"
 *
 * @example
 * ```ts
 * const sessionState = await calculateSessionState(
 *   'client123',
 *   'https://rp.example.com',
 *   'session-abc-123'
 * );
 * // Returns: "a3f2b1c4d5e6...hash.randomsalt"
 * ```
 */
export async function calculateSessionState(
  clientId: string,
  origin: string,
  opBrowserState: string,
  salt?: string
): Promise<string> {
  // Generate a random salt if not provided
  const usedSalt = salt || generateSecureRandomString(16);

  // Construct the data to hash: client_id + " " + origin + " " + op_browser_state + " " + salt
  const data = `${clientId} ${origin} ${opBrowserState} ${usedSalt}`;

  // Calculate SHA-256 hash
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);

  // Convert to base64url
  const hash = arrayBufferToBase64Url(hashBuffer);

  // Return in format: hash.salt
  return `${hash}.${usedSalt}`;
}

/**
 * Parse a session state value into its components
 *
 * @param sessionState - The session state value in format "hash.salt"
 * @returns Object containing hash and salt, or null if invalid format
 */
export function parseSessionState(sessionState: string): { hash: string; salt: string } | null {
  const lastDotIndex = sessionState.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return null;
  }

  const hash = sessionState.substring(0, lastDotIndex);
  const salt = sessionState.substring(lastDotIndex + 1);

  if (!hash || !salt) {
    return null;
  }

  return { hash, salt };
}

/**
 * Validate a session state value
 *
 * This function recalculates the session state using the provided parameters
 * and compares it with the provided session state value.
 *
 * @param sessionState - The session state value to validate
 * @param clientId - The client identifier
 * @param origin - The origin of the RP
 * @param opBrowserState - The OP's browser state
 * @returns true if the session state is valid, false otherwise
 */
export async function validateSessionState(
  sessionState: string,
  clientId: string,
  origin: string,
  opBrowserState: string
): Promise<boolean> {
  const parsed = parseSessionState(sessionState);
  if (!parsed) {
    return false;
  }

  // Recalculate with the same salt
  const expectedSessionState = await calculateSessionState(
    clientId,
    origin,
    opBrowserState,
    parsed.salt
  );

  // Compare the full session state values
  return sessionState === expectedSessionState;
}

/**
 * Extract the origin from a URL
 *
 * @param url - The URL to extract origin from
 * @returns The origin (protocol + host + port if non-standard)
 */
export function extractOrigin(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.origin;
  } catch {
    return '';
  }
}

/**
 * Generate the HTML content for the check_session_iframe endpoint
 *
 * This iframe is loaded by the RP to monitor session state changes.
 * The RP posts messages with format "client_id session_state" and
 * receives "changed", "unchanged", or "error" responses.
 *
 * @param issuerUrl - The issuer URL of the OP
 * @returns HTML content for the check_session_iframe
 */
export function generateCheckSessionIframeHtml(issuerUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OIDC Session Check</title>
</head>
<body>
<script>
(function() {
  'use strict';

  // Get the OP's browser state (session cookie)
  function getOpBrowserState() {
    var cookies = document.cookie.split(';');
    for (var i = 0; i < cookies.length; i++) {
      var cookie = cookies[i].trim();
      if (cookie.indexOf('authrim_session=') === 0) {
        return cookie.substring('authrim_session='.length);
      }
    }
    return '';
  }

  // Calculate SHA-256 hash and return base64url
  async function sha256Base64Url(data) {
    var encoder = new TextEncoder();
    var dataBuffer = encoder.encode(data);
    var hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    var bytes = new Uint8Array(hashBuffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
  }

  // Validate session state
  async function validateSessionState(clientId, sessionState, opBrowserState) {
    if (!sessionState || !opBrowserState) {
      return 'changed';
    }

    var lastDotIndex = sessionState.lastIndexOf('.');
    if (lastDotIndex === -1) {
      return 'error';
    }

    var expectedHash = sessionState.substring(0, lastDotIndex);
    var salt = sessionState.substring(lastDotIndex + 1);

    if (!expectedHash || !salt) {
      return 'error';
    }

    try {
      // Get the origin from the event source
      var origin = event.origin;

      // Calculate expected session state: client_id + " " + origin + " " + op_browser_state + " " + salt
      var data = clientId + ' ' + origin + ' ' + opBrowserState + ' ' + salt;
      var calculatedHash = await sha256Base64Url(data);

      if (calculatedHash === expectedHash) {
        return 'unchanged';
      } else {
        return 'changed';
      }
    } catch (e) {
      console.error('Session state validation error:', e);
      return 'error';
    }
  }

  // Handle incoming postMessage
  window.addEventListener('message', async function(event) {
    // Validate message format: "client_id session_state"
    if (typeof event.data !== 'string') {
      event.source.postMessage('error', event.origin);
      return;
    }

    var parts = event.data.split(' ');
    if (parts.length !== 2) {
      event.source.postMessage('error', event.origin);
      return;
    }

    var clientId = parts[0];
    var sessionState = parts[1];
    var opBrowserState = getOpBrowserState();

    var result = await validateSessionState(clientId, sessionState, opBrowserState);
    event.source.postMessage(result, event.origin);
  });
})();
</script>
</body>
</html>`;
}

/**
 * Session state change result types
 */
export type SessionStateResult = 'changed' | 'unchanged' | 'error';

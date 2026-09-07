/**
 * Front-Channel Logout Service
 *
 * Generates HTML pages for OIDC Front-Channel Logout 1.0.
 *
 * Front-Channel Logout works by embedding iframes in the OP's logout page
 * that load each RP's frontchannel_logout_uri. This allows the RP to clear
 * its session state when the user logs out.
 *
 * Per OIDC Front-Channel Logout 1.0:
 * - The OP embeds iframes for each RP's frontchannel_logout_uri
 * - Each iframe URL includes `iss` (issuer) parameter
 * - If frontchannel_logout_session_required is true, `sid` is also included
 *
 * Limitations:
 * - Third-party cookie restrictions may prevent RPs from clearing cookies
 * - The OP cannot detect if the RP successfully processed the logout
 * - For security-critical scenarios, use Backchannel Logout instead
 *
 * @see https://openid.net/specs/openid-connect-frontchannel-1_0.html
 * @packageDocumentation
 */

import type {
  FrontchannelLogoutConfig,
  FrontchannelLogoutIframe,
  FrontchannelLogoutRequest,
} from '../types/logout';
import type { SessionClientWithDetails } from '../repositories/core/session-client';
import { DEFAULT_LOGOUT_CONFIG } from '../types/logout';

/**
 * Build frontchannel logout URI with query parameters
 *
 * Per OIDC Front-Channel Logout 1.0 Section 2.1:
 * - `iss`: REQUIRED. Issuer Identifier
 * - `sid`: REQUIRED if frontchannel_logout_session_required is true
 *
 * @param baseUri - The RP's frontchannel_logout_uri
 * @param issuer - The OP's issuer URL
 * @param sessionId - The session ID (sid)
 * @param sessionRequired - Whether sid is required
 * @returns Complete logout URI with query parameters
 */
export function buildFrontchannelLogoutUri(
  baseUri: string,
  issuer: string,
  sessionId: string | undefined,
  sessionRequired: boolean
): string {
  const url = new URL(baseUri);

  // Always include issuer
  url.searchParams.set('iss', issuer);

  // Include sid if required or if we have it
  if (sessionRequired && sessionId) {
    url.searchParams.set('sid', sessionId);
  }

  return url.toString();
}

/**
 * Build iframe list from session clients
 *
 * @param clients - Session clients with logout URIs
 * @param issuer - The OP's issuer URL
 * @param sessionId - The session ID
 * @returns Array of iframe configurations
 */
export function buildFrontchannelLogoutIframes(
  clients: SessionClientWithDetails[],
  issuer: string,
  fallbackOidcSid?: string
): FrontchannelLogoutIframe[] {
  return clients
    .filter((client) => client.frontchannel_logout_uri)
    .map((client) => ({
      clientId: client.client_id,
      logoutUri: buildFrontchannelLogoutUri(
        client.frontchannel_logout_uri!,
        issuer,
        client.oidc_sid ?? fallbackOidcSid,
        client.frontchannel_logout_session_required
      ),
      sessionRequired: client.frontchannel_logout_session_required,
    }));
}

/**
 * Generate frontchannel logout HTML page
 *
 * Creates an HTML page with hidden iframes that load each RP's
 * frontchannel_logout_uri. The page automatically redirects to
 * the post-logout URI after a timeout.
 *
 * @param iframes - Array of iframe configurations
 * @param config - Frontchannel logout configuration
 * @param postLogoutRedirectUri - Where to redirect after logout
 * @param state - Optional state parameter to include in redirect
 * @returns HTML string
 */
export function generateFrontchannelLogoutHtml(
  iframes: FrontchannelLogoutIframe[],
  config: FrontchannelLogoutConfig,
  postLogoutRedirectUri: string,
  state?: string
): string {
  // Build redirect URL with state if provided
  let redirectUrl = postLogoutRedirectUri;
  if (state) {
    const url = new URL(postLogoutRedirectUri);
    url.searchParams.set('state', state);
    redirectUrl = url.toString();
  }

  // Escape URLs for HTML
  const escapeHtml = (str: string) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Generate iframe elements
  // Note: sandbox attribute removed to allow cross-origin requests for frontchannel logout
  // The RP's frontchannel_logout_uri just needs to receive the GET request with iss and sid
  // Using 1x1px size instead of 0x0 to ensure browsers don't skip loading invisible iframes
  const iframeElements = iframes
    .slice(0, config.max_concurrent_iframes)
    .map(
      (iframe, index) => `
    <iframe
      id="logout-frame-${index}"
      src="${escapeHtml(iframe.logoutUri)}"
      style="width:1px;height:1px;border:0;position:absolute;left:-9999px;top:-9999px;"
      loading="eager"
    ></iframe>`
    )
    .join('\n');

  // Generate HTML page
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logging out...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .logout-container {
      text-align: center;
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #f3f3f3;
      border-top: 3px solid #3498db;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    h1 {
      font-size: 1.5rem;
      color: #333;
      margin: 0 0 0.5rem;
    }
    p {
      color: #666;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="logout-container">
    <div class="spinner"></div>
    <h1>Logging out...</h1>
    <p>Please wait while we sign you out of all applications.</p>
  </div>

  <!-- Hidden iframes for frontchannel logout -->
  ${iframeElements}

  <script>
    // Track loaded iframes
    var loadedCount = 0;
    var totalIframes = ${iframes.length};
    var timeoutMs = ${config.iframe_timeout_ms};
    var redirectUrl = "${escapeHtml(redirectUrl)}";
    var redirectDone = false;
    // Minimum wait time to ensure iframes have time to send requests
    // Cross-origin iframes may fire onload immediately even before the request completes
    // Using 2500ms to give enough time for network latency
    var minWaitMs = 2500;
    var startTime = Date.now();

    function doRedirect() {
      if (redirectDone) return;
      redirectDone = true;
      window.location.href = redirectUrl;
    }

    function tryRedirect() {
      // Ensure minimum wait time has passed
      var elapsed = Date.now() - startTime;
      if (elapsed < minWaitMs) {
        setTimeout(doRedirect, minWaitMs - elapsed);
      } else {
        doRedirect();
      }
    }

    // Listen for iframe load events
    document.querySelectorAll('iframe').forEach(function(iframe) {
      iframe.onload = function() {
        loadedCount++;
        if (loadedCount >= totalIframes) {
          // All iframes loaded - but wait for minimum time
          tryRedirect();
        }
      };
      iframe.onerror = function() {
        loadedCount++;
        if (loadedCount >= totalIframes) {
          tryRedirect();
        }
      };
    });

    // Fallback: redirect after timeout even if iframes haven't loaded
    setTimeout(doRedirect, timeoutMs);
  </script>
</body>
</html>`;
}

/**
 * Check if frontchannel logout should be used
 *
 * Determines if the logout flow should show the frontchannel logout page
 * based on configuration and available clients.
 *
 * @param clients - Session clients with logout URIs
 * @param config - Frontchannel logout configuration
 * @returns True if frontchannel logout should be used
 */
export function shouldUseFrontchannelLogout(
  clients: SessionClientWithDetails[],
  config: FrontchannelLogoutConfig
): boolean {
  if (!config.enabled) {
    return false;
  }

  const frontchannelClients = clients.filter((c) => c.frontchannel_logout_uri);
  return frontchannelClients.length > 0;
}

/**
 * Get frontchannel logout configuration from KV or defaults
 *
 * @param kv - KV namespace for settings
 * @param settingsKey - Key for logout settings
 * @returns Frontchannel logout configuration
 */
export async function getFrontchannelLogoutConfig(
  kv: KVNamespace | undefined,
  settingsKey: string
): Promise<FrontchannelLogoutConfig> {
  if (kv) {
    try {
      const kvConfig = await kv.get(settingsKey);
      if (kvConfig) {
        const parsed = JSON.parse(kvConfig);
        if (parsed.frontchannel) {
          return {
            ...DEFAULT_LOGOUT_CONFIG.frontchannel,
            ...parsed.frontchannel,
          };
        }
      }
    } catch {
      // Ignore KV errors, use defaults
    }
  }

  return DEFAULT_LOGOUT_CONFIG.frontchannel;
}

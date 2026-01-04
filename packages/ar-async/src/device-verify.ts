/**
 * Device Verification Handler (Minimal - for OIDC Conformance Test)
 * RFC 8628: Device User Authorization
 *
 * IMPORTANT: This is a minimal HTML form for OIDC conformance testing only.
 * For production use, configure UI_URL and redirect users to the external UI.
 * or use the headless JSON API at POST /api/device/verify
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@authrim/ar-lib-core';
import {
  normalizeUserCode,
  validateUserCodeFormat,
  isMockAuthEnabled,
  getUIConfig,
  shouldUseBuiltinForms,
  createConfigurationError,
  getTenantIdFromContext,
  getLogger,
} from '@authrim/ar-lib-core';
import { html } from 'hono/html';

/**
 * GET /device
 * Minimal device verification form (Conformance test only)
 *
 * Note: In production, configure UI_URL and users will be redirected to external UI.
 */
export async function deviceVerifyHandler(c: Context<{ Bindings: Env }>) {
  if (c.req.method === 'GET') {
    return showMinimalVerificationForm(c);
  } else if (c.req.method === 'POST') {
    return handleVerificationSubmission(c);
  }

  return c.text('Method not allowed', 405);
}

/**
 * Show minimal device verification form (Conformance test only)
 */
async function showMinimalVerificationForm(c: Context<{ Bindings: Env }>) {
  const userCodeParam = c.req.query('user_code');
  const error = c.req.query('error');
  const success = c.req.query('success');

  // Note: For production, users are redirected to external UI in handleVerificationSubmission()
  // This built-in form is only used when CONFORMANCE_MODE=true

  // Minimal HTML for conformance testing
  const page = html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Device Verification</title>
      </head>
      <body>
        <h1>Device Verification</h1>
        ${error ? html`<p style="color: red;">${error}</p>` : ''}
        ${success ? html`<p style="color: green;">${success}</p>` : ''}
        <form method="POST" action="/device">
          <label for="user_code">Enter verification code:</label>
          <input
            type="text"
            id="user_code"
            name="user_code"
            value="${userCodeParam || ''}"
            placeholder="XXXX-XXXX"
            maxlength="9"
            pattern="[A-Z0-9]{4}-[A-Z0-9]{4}"
            required
            autofocus
          />
          <button type="submit">Continue</button>
        </form>
      </body>
    </html>
  `;

  return c.html(page);
}

/**
 * Handle device verification submission
 * User enters user_code and approves/denies
 */
async function handleVerificationSubmission(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DEVICE');
  try {
    const body = await c.req.parseBody();
    let userCode = body.user_code as string;

    if (!userCode) {
      return c.redirect('/device?error=User code is required');
    }

    // Normalize and validate user code format
    userCode = normalizeUserCode(userCode);

    if (!validateUserCodeFormat(userCode)) {
      return c.redirect('/device?error=Invalid user code format');
    }

    // Get device code metadata from DeviceCodeStore
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName('global');
    const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

    const getResponse = await deviceCodeStore.fetch(
      new Request('https://internal/get-by-user-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      })
    );

    const metadata: DeviceCodeMetadata | null = await getResponse.json();

    if (!metadata) {
      return c.redirect('/device?error=Invalid or expired user code');
    }

    if (metadata.status !== 'pending') {
      return c.redirect(`/device?error=This code has already been ${metadata.status}`);
    }

    // Check if mock authentication is enabled (SECURITY: default is disabled)
    const mockAuthEnabled = await isMockAuthEnabled(c.env);

    if (!mockAuthEnabled) {
      // Production mode: Redirect to proper authentication flow
      // Check conformance mode first
      if (await shouldUseBuiltinForms(c.env)) {
        // Conformance mode: Show error (mock auth disabled, no real auth in conformance mode)
        return c.redirect(
          '/device?error=Authentication required. Enable mock auth for conformance testing.'
        );
      }

      // Check UI configuration
      const uiConfig = await getUIConfig(c.env);
      if (uiConfig?.baseUrl) {
        const tenantId = getTenantIdFromContext(c);
        const deviceAuthPath = uiConfig.paths?.deviceAuthorize || '/device/authorize';
        const loginUrl = new URL(`${uiConfig.baseUrl}${deviceAuthPath}`);
        loginUrl.searchParams.set('user_code', userCode);
        // Add tenant_hint for UI branding (UX only, untrusted)
        if (tenantId && tenantId !== 'default') {
          loginUrl.searchParams.set('tenant_hint', tenantId);
        }
        return c.redirect(loginUrl.toString());
      }

      // No UI configured and conformance mode disabled - return configuration error
      return c.json(createConfigurationError(), 500);
    }

    // DEVELOPMENT ONLY: Auto-approve with mock user
    log.warn('Mock authentication is enabled. This should NEVER be used in production!');
    const mockUserId = 'user_' + Date.now();
    const mockSub = 'mock-user@example.com';

    const approveResponse = await deviceCodeStore.fetch(
      new Request('https://internal/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code: userCode,
          user_id: mockUserId,
          sub: mockSub,
        }),
      })
    );

    if (!approveResponse.ok) {
      const error = (await approveResponse.json()) as { error_description?: string };
      return c.redirect(`/device?error=${error.error_description || 'Approval failed'}`);
    }

    return c.redirect('/device?success=Device authorized successfully! You can close this window.');
  } catch (error) {
    log.error('Device verification error', {}, error as Error);
    return c.redirect('/device?error=An error occurred. Please try again.');
  }
}

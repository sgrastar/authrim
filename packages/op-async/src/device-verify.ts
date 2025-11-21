/**
 * Device Verification Handler (Minimal - for OIDC Conformance Test)
 * RFC 8628: Device User Authorization
 *
 * IMPORTANT: This is a minimal HTML form for OIDC conformance testing only.
 * For production use, redirect users to the SvelteKit UI at UI_BASE_URL/device
 * or use the headless JSON API at POST /api/device/verify
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@authrim/shared';
import { normalizeUserCode, validateUserCodeFormat } from '@authrim/shared';
import { html } from 'hono/html';

/**
 * GET /device
 * Minimal device verification form (Conformance test only)
 *
 * Note: In production, users should be redirected to UI_BASE_URL/device
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

  // For production use, redirect to SvelteKit UI
  // Uncomment the following lines when UI is deployed:
  // if (c.env.UI_BASE_URL) {
  //   const redirectUrl = new URL(`${c.env.UI_BASE_URL}/device`);
  //   if (userCodeParam) redirectUrl.searchParams.set('user_code', userCodeParam);
  //   return c.redirect(redirectUrl.toString());
  // }

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

    // TODO: Authenticate user and get user_id and sub
    // For now, we'll show a success message and redirect to login
    // In production, this would integrate with the session/auth flow

    // For demonstration, auto-approve with mock user
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
    console.error('Device verification error:', error);
    return c.redirect('/device?error=An error occurred. Please try again.');
  }
}

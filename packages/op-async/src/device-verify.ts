/**
 * Device Verification Handler
 * RFC 8628: Device User Authorization
 *
 * User-facing endpoint where users enter their user_code
 * and approve/deny the device authorization request
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@enrai/shared';
import { normalizeUserCode, validateUserCodeFormat } from '@enrai/shared';
import { html } from 'hono/html';

/**
 * GET /device
 * Show device verification form
 */
export async function deviceVerifyHandler(c: Context<{ Bindings: Env }>) {
  if (c.req.method === 'GET') {
    return showVerificationForm(c);
  } else if (c.req.method === 'POST') {
    return handleVerificationSubmission(c);
  }

  return c.text('Method not allowed', 405);
}

/**
 * Show device verification form
 */
async function showVerificationForm(c: Context<{ Bindings: Env }>) {
  const userCodeParam = c.req.query('user_code');
  const error = c.req.query('error');
  const success = c.req.query('success');

  const page = html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Device Verification - Enrai</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto',
              'Helvetica', 'Arial', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            padding: 40px;
            max-width: 480px;
            width: 100%;
          }
          h1 {
            color: #2d3748;
            font-size: 28px;
            margin-bottom: 8px;
            text-align: center;
          }
          .subtitle {
            color: #718096;
            font-size: 14px;
            text-align: center;
            margin-bottom: 32px;
          }
          .form-group {
            margin-bottom: 24px;
          }
          label {
            display: block;
            color: #4a5568;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
          }
          input[type='text'] {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 18px;
            font-weight: 600;
            letter-spacing: 2px;
            text-transform: uppercase;
            text-align: center;
            transition: border-color 0.2s;
          }
          input[type='text']:focus {
            outline: none;
            border-color: #667eea;
          }
          .hint {
            color: #a0aec0;
            font-size: 12px;
            margin-top: 8px;
            text-align: center;
          }
          .btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          }
          .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
          }
          .alert {
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 24px;
            font-size: 14px;
          }
          .alert-error {
            background: #fed7d7;
            color: #c53030;
            border: 1px solid #fc8181;
          }
          .alert-success {
            background: #c6f6d5;
            color: #22543d;
            border: 1px solid #68d391;
          }
          .logo {
            text-align: center;
            margin-bottom: 24px;
            font-size: 48px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">🔐</div>
          <h1>Device Verification</h1>
          <p class="subtitle">Enter the code shown on your device</p>

          ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
          ${success ? html`<div class="alert alert-success">${success}</div>` : ''}

          <form method="POST" action="/device">
            <div class="form-group">
              <label for="user_code">Verification Code</label>
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
              <div class="hint">Format: XXXX-XXXX (8 characters)</div>
            </div>

            <button type="submit" class="btn btn-primary">Continue</button>
          </form>
        </div>

        <script>
          // Auto-format user code input
          const input = document.getElementById('user_code');
          input.addEventListener('input', (e) => {
            let value = e.target.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (value.length > 4) {
              value = value.slice(0, 4) + '-' + value.slice(4, 8);
            }
            e.target.value = value;
          });
        </script>
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

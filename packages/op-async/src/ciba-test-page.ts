/**
 * CIBA Test Page Handler
 * Simple HTML page for testing CIBA flow
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';

/**
 * GET /ciba/test
 * Simple test page for CIBA flow
 */
export async function cibaTestPageHandler(c: Context<{ Bindings: Env }>) {
  const issuerUrl = c.env.ISSUER_URL || 'http://localhost:8787';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CIBA Flow Test</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 600px;
      width: 100%;
      padding: 40px;
    }

    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }

    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }

    .section {
      margin-bottom: 30px;
    }

    .section-title {
      font-size: 18px;
      font-weight: 600;
      color: #333;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .badge {
      background: #667eea;
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }

    .form-group {
      margin-bottom: 20px;
    }

    label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 500;
      font-size: 14px;
    }

    input[type="text"],
    textarea {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
      transition: all 0.3s;
    }

    input[type="text"]:focus,
    textarea:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    textarea {
      resize: vertical;
      min-height: 80px;
    }

    button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 14px 28px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      width: 100%;
    }

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .response {
      background: #f5f5f5;
      border-radius: 8px;
      padding: 16px;
      margin-top: 20px;
      display: none;
    }

    .response.show {
      display: block;
    }

    .response.error {
      background: #fee;
      border: 2px solid #fcc;
    }

    .response.success {
      background: #efe;
      border: 2px solid #cfc;
    }

    .response pre {
      background: white;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
      margin-top: 10px;
    }

    .info-box {
      background: #e3f2fd;
      border-left: 4px solid #2196f3;
      padding: 16px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 14px;
      color: #0d47a1;
    }

    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255,255,255,.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s ease-in-out infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 CIBA Flow Test</h1>
    <p class="subtitle">Test OpenID Connect Client Initiated Backchannel Authentication</p>

    <div class="info-box">
      <strong>ℹ️ Test Flow:</strong><br>
      1. Initiate CIBA request with login hint<br>
      2. User approves on separate device/page<br>
      3. Poll for tokens using auth_req_id
    </div>

    <!-- Step 1: Initiate CIBA Request -->
    <div class="section">
      <div class="section-title">
        <span class="badge">Step 1</span>
        Initiate CIBA Request
      </div>

      <form id="cibaForm">
        <div class="form-group">
          <label for="clientId">Client ID</label>
          <input type="text" id="clientId" name="client_id" value="test_client" required>
        </div>

        <div class="form-group">
          <label for="scope">Scope</label>
          <input type="text" id="scope" name="scope" value="openid profile email" required>
        </div>

        <div class="form-group">
          <label for="loginHint">Login Hint (email, phone, sub, or username)</label>
          <input type="text" id="loginHint" name="login_hint" value="user@example.com" required>
        </div>

        <div class="form-group">
          <label for="bindingMessage">Binding Message (optional, max 140 chars)</label>
          <input type="text" id="bindingMessage" name="binding_message" value="Sign in to Test App" maxlength="140">
        </div>

        <button type="submit" id="submitBtn">
          Initiate CIBA Request
        </button>
      </form>

      <div id="cibaResponse" class="response"></div>
    </div>

    <!-- Step 2: User Approval -->
    <div class="section">
      <div class="section-title">
        <span class="badge">Step 2</span>
        User Approval
      </div>

      <div class="info-box">
        After initiating the request, open the approval page:<br>
        <a href="${issuerUrl}/ciba" target="_blank" style="color: #1976d2; font-weight: 600;">
          ${issuerUrl}/ciba
        </a>
      </div>
    </div>

    <!-- Step 3: Poll for Tokens -->
    <div class="section">
      <div class="section-title">
        <span class="badge">Step 3</span>
        Poll for Tokens
      </div>

      <button id="pollBtn" onclick="pollForTokens()" disabled>
        Start Polling
      </button>

      <div id="pollResponse" class="response"></div>
    </div>
  </div>

  <script>
    let authReqId = null;
    let pollInterval = null;

    // Step 1: Initiate CIBA Request
    document.getElementById('cibaForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const submitBtn = document.getElementById('submitBtn');
      const responseDiv = document.getElementById('cibaResponse');
      const pollBtn = document.getElementById('pollBtn');

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="loading"></span> Initiating...';
      responseDiv.className = 'response';
      responseDiv.style.display = 'none';

      const formData = new FormData(e.target);
      const params = new URLSearchParams();

      for (const [key, value] of formData.entries()) {
        if (value) params.append(key, value);
      }

      try {
        const response = await fetch('${issuerUrl}/bc-authorize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString()
        });

        const data = await response.json();

        if (response.ok) {
          authReqId = data.auth_req_id;
          responseDiv.className = 'response success show';
          responseDiv.innerHTML = \`
            <strong>✅ CIBA Request Initiated Successfully!</strong>
            <pre>\${JSON.stringify(data, null, 2)}</pre>
          \`;
          pollBtn.disabled = false;
        } else {
          responseDiv.className = 'response error show';
          responseDiv.innerHTML = \`
            <strong>❌ Error:</strong> \${data.error_description || data.error}
            <pre>\${JSON.stringify(data, null, 2)}</pre>
          \`;
        }
      } catch (error) {
        responseDiv.className = 'response error show';
        responseDiv.innerHTML = \`<strong>❌ Error:</strong> \${error.message}\`;
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Initiate CIBA Request';
      }
    });

    // Step 3: Poll for Tokens
    async function pollForTokens() {
      if (!authReqId) {
        alert('Please initiate a CIBA request first');
        return;
      }

      const pollBtn = document.getElementById('pollBtn');
      const pollResponse = document.getElementById('pollResponse');

      pollBtn.disabled = true;
      pollBtn.innerHTML = '<span class="loading"></span> Polling...';
      pollResponse.className = 'response show';
      pollResponse.innerHTML = '<strong>⏳ Polling for tokens...</strong><p>Waiting for user approval...</p>';

      let attempts = 0;
      const maxAttempts = 60; // 5 minutes with 5-second intervals

      pollInterval = setInterval(async () => {
        attempts++;

        try {
          const params = new URLSearchParams({
            grant_type: 'urn:openid:params:grant-type:ciba',
            auth_req_id: authReqId,
            client_id: document.getElementById('clientId').value
          });

          const response = await fetch('${issuerUrl}/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString()
          });

          const data = await response.json();

          if (response.ok && data.access_token) {
            // Success!
            clearInterval(pollInterval);
            pollResponse.className = 'response success show';
            pollResponse.innerHTML = \`
              <strong>✅ Tokens Received!</strong>
              <pre>\${JSON.stringify(data, null, 2)}</pre>
            \`;
            pollBtn.innerHTML = 'Tokens Received';
          } else if (data.error === 'authorization_pending') {
            // Still waiting
            pollResponse.innerHTML = \`
              <strong>⏳ Polling for tokens...</strong>
              <p>Attempt \${attempts}/\${maxAttempts} - Still waiting for user approval...</p>
            \`;
          } else if (data.error === 'slow_down') {
            // Slow down
            pollResponse.innerHTML = \`
              <strong>⚠️ Slow down</strong>
              <p>Polling too fast, slowing down...</p>
            \`;
          } else if (data.error === 'access_denied') {
            // Denied
            clearInterval(pollInterval);
            pollResponse.className = 'response error show';
            pollResponse.innerHTML = \`
              <strong>❌ Access Denied</strong>
              <p>User denied the authentication request</p>
            \`;
            pollBtn.innerHTML = 'Access Denied';
            pollBtn.disabled = false;
          } else {
            // Other error
            clearInterval(pollInterval);
            pollResponse.className = 'response error show';
            pollResponse.innerHTML = \`
              <strong>❌ Error:</strong> \${data.error_description || data.error}
              <pre>\${JSON.stringify(data, null, 2)}</pre>
            \`;
            pollBtn.innerHTML = 'Error Occurred';
            pollBtn.disabled = false;
          }
        } catch (error) {
          clearInterval(pollInterval);
          pollResponse.className = 'response error show';
          pollResponse.innerHTML = \`<strong>❌ Error:</strong> \${error.message}\`;
          pollBtn.innerHTML = 'Error Occurred';
          pollBtn.disabled = false;
        }

        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          pollResponse.className = 'response error show';
          pollResponse.innerHTML = '<strong>⏱️ Timeout</strong><p>Maximum polling attempts reached</p>';
          pollBtn.innerHTML = 'Timeout';
          pollBtn.disabled = false;
        }
      }, 5000); // Poll every 5 seconds
    }
  </script>
</body>
</html>
  `;

  return c.html(html);
}

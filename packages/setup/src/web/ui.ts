/**
 * HTML Template for Authrim Setup Web UI
 *
 * A simple, self-contained UI for the setup wizard.
 */

export function getHtmlTemplate(sessionToken?: string): string {
  // Escape token for safe embedding in JavaScript
  const safeToken = sessionToken ? sessionToken.replace(/['"\\]/g, '') : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authrim Setup</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --success: #10b981;
      --error: #ef4444;
      --warning: #f59e0b;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
    }

    header {
      text-align: center;
      margin-bottom: 2rem;
    }

    h1 {
      font-size: 2rem;
      color: var(--primary);
      margin-bottom: 0.5rem;
    }

    .subtitle {
      color: var(--text-muted);
    }

    .card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .status-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 9999px;
      font-weight: 500;
    }

    .status-pending { background: var(--border); color: var(--text-muted); }
    .status-running { background: #dbeafe; color: var(--primary); }
    .status-success { background: #d1fae5; color: var(--success); }
    .status-error { background: #fee2e2; color: var(--error); }

    .form-group {
      margin-bottom: 1rem;
    }

    label {
      display: block;
      font-weight: 500;
      margin-bottom: 0.5rem;
    }

    input[type="text"],
    input[type="password"],
    select {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s;
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--primary);
    }

    .checkbox-group {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .checkbox-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    button {
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }

    .btn-primary {
      background: var(--primary);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--primary-dark);
    }

    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: var(--border);
      color: var(--text);
    }

    .btn-secondary:hover {
      background: #cbd5e1;
    }

    .button-group {
      display: flex;
      gap: 1rem;
      margin-top: 1.5rem;
    }

    .progress-log {
      background: #1e293b;
      border-radius: 8px;
      padding: 1rem;
      max-height: 300px;
      overflow-y: auto;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.875rem;
    }

    .progress-log pre {
      color: #e2e8f0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .step-indicator {
      display: flex;
      justify-content: center;
      gap: 0.5rem;
      margin-bottom: 2rem;
    }

    .step {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.875rem;
    }

    .step-active {
      background: var(--primary);
      color: white;
    }

    .step-complete {
      background: var(--success);
      color: white;
    }

    .step-pending {
      background: var(--border);
      color: var(--text-muted);
    }

    .step-connector {
      width: 40px;
      height: 2px;
      background: var(--border);
      align-self: center;
    }

    .alert {
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
    }

    .alert-success { background: #d1fae5; color: #065f46; }
    .alert-error { background: #fee2e2; color: #991b1b; }
    .alert-warning { background: #fef3c7; color: #92400e; }
    .alert-info { background: #dbeafe; color: #1e40af; }

    .url-display {
      background: var(--bg);
      padding: 1rem;
      border-radius: 8px;
      margin-top: 1rem;
    }

    .url-item {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .url-label {
      font-weight: 500;
      min-width: 100px;
    }

    .url-value {
      color: var(--primary);
    }

    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔐 Authrim Setup</h1>
      <p class="subtitle">OIDC Provider on Cloudflare Workers</p>
    </header>

    <div class="step-indicator">
      <div class="step step-active" id="step-1">1</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-2">2</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-3">3</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-4">4</div>
    </div>

    <!-- Step 1: Prerequisites -->
    <div id="section-prerequisites" class="card">
      <h2 class="card-title">
        Prerequisites
        <span class="status-badge status-running" id="prereq-status">Checking...</span>
      </h2>
      <div id="prereq-content">
        <p>Checking system requirements...</p>
      </div>
    </div>

    <!-- Step 2: Configuration -->
    <div id="section-config" class="card hidden">
      <h2 class="card-title">Configuration</h2>

      <div class="form-group">
        <label for="env">Environment</label>
        <select id="env">
          <option value="prod">Production (prod)</option>
          <option value="staging">Staging</option>
          <option value="dev">Development (dev)</option>
        </select>
      </div>

      <div class="form-group">
        <label for="domain">Custom Domain (optional)</label>
        <input type="text" id="domain" placeholder="auth.example.com">
        <small style="color: var(--text-muted)">Leave empty to use workers.dev / pages.dev</small>
      </div>

      <h3 style="margin: 1.5rem 0 1rem; font-size: 1rem;">Components</h3>
      <div class="checkbox-group">
        <label class="checkbox-item">
          <input type="checkbox" id="comp-api" checked disabled>
          API (required)
        </label>
        <label class="checkbox-item">
          <input type="checkbox" id="comp-login-ui" checked>
          Login UI
        </label>
        <label class="checkbox-item">
          <input type="checkbox" id="comp-admin-ui" checked>
          Admin UI
        </label>
        <label class="checkbox-item">
          <input type="checkbox" id="comp-saml">
          SAML IdP
        </label>
        <label class="checkbox-item">
          <input type="checkbox" id="comp-vc">
          Verifiable Credentials
        </label>
      </div>

      <div class="button-group">
        <button class="btn-primary" id="btn-configure">Continue</button>
      </div>
    </div>

    <!-- Step 3: Provisioning -->
    <div id="section-provision" class="card hidden">
      <h2 class="card-title">
        Resource Provisioning
        <span class="status-badge status-pending" id="provision-status">Ready</span>
      </h2>

      <p style="margin-bottom: 1rem;">The following resources will be created:</p>
      <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
        <li>2 D1 Databases (core, PII)</li>
        <li>8 KV Namespaces</li>
        <li>RSA Key Pair for JWT signing</li>
      </ul>

      <div class="progress-log hidden" id="provision-log">
        <pre id="provision-output"></pre>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-config">Back</button>
        <button class="btn-primary" id="btn-provision">Create Resources</button>
      </div>
    </div>

    <!-- Step 4: Deployment -->
    <div id="section-deploy" class="card hidden">
      <h2 class="card-title">
        Deployment
        <span class="status-badge status-pending" id="deploy-status">Ready</span>
      </h2>

      <p style="margin-bottom: 1rem;">Ready to deploy Authrim workers to Cloudflare.</p>

      <div class="progress-log hidden" id="deploy-log">
        <pre id="deploy-output"></pre>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-provision">Back</button>
        <button class="btn-primary" id="btn-deploy">Deploy</button>
      </div>
    </div>

    <!-- Complete -->
    <div id="section-complete" class="card hidden">
      <h2 class="card-title" style="color: var(--success);">
        Setup Complete!
      </h2>

      <p>Authrim has been successfully deployed.</p>

      <div class="url-display" id="urls">
        <!-- URLs will be inserted here -->
      </div>

      <div class="alert alert-info" style="margin-top: 1rem;">
        <strong>Next Steps:</strong>
        <ol style="margin-left: 1.5rem; margin-top: 0.5rem;">
          <li>Visit the Admin UI to create your first client</li>
          <li>Configure your application to use the OIDC endpoints</li>
        </ol>
      </div>
    </div>
  </div>

  <script>
    // Session token for API authentication (embedded by server)
    const SESSION_TOKEN = '${safeToken}';

    // State
    let currentStep = 1;
    let config = {};

    // Elements
    const steps = {
      1: document.getElementById('step-1'),
      2: document.getElementById('step-2'),
      3: document.getElementById('step-3'),
      4: document.getElementById('step-4'),
    };

    const sections = {
      prerequisites: document.getElementById('section-prerequisites'),
      config: document.getElementById('section-config'),
      provision: document.getElementById('section-provision'),
      deploy: document.getElementById('section-deploy'),
      complete: document.getElementById('section-complete'),
    };

    // API helpers (with session token authentication)
    async function api(endpoint, options = {}) {
      const response = await fetch('/api' + endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': SESSION_TOKEN,
        },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      return response.json();
    }

    // Step navigation
    function setStep(step) {
      currentStep = step;
      for (let i = 1; i <= 4; i++) {
        const el = steps[i];
        el.className = 'step ' + (i < step ? 'step-complete' : i === step ? 'step-active' : 'step-pending');
      }
    }

    function showSection(name) {
      Object.values(sections).forEach(s => s.classList.add('hidden'));
      sections[name].classList.remove('hidden');
    }

    // Safe DOM element creation helpers
    function createAlert(type, content) {
      const div = document.createElement('div');
      div.className = 'alert alert-' + type;
      if (typeof content === 'string') {
        div.textContent = content;
      } else {
        div.appendChild(content);
      }
      return div;
    }

    function createUrlItem(label, url) {
      const div = document.createElement('div');
      div.className = 'url-item';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'url-label';
      labelSpan.textContent = label;

      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.className = 'url-value';
      link.textContent = url;

      div.appendChild(labelSpan);
      div.appendChild(link);
      return div;
    }

    // Check prerequisites
    async function checkPrerequisites() {
      const prereqStatus = document.getElementById('prereq-status');
      const prereqContent = document.getElementById('prereq-content');

      try {
        const result = await api('/prerequisites');

        // Clear existing content
        prereqContent.textContent = '';

        if (!result.wranglerInstalled) {
          prereqStatus.textContent = 'Error';
          prereqStatus.className = 'status-badge status-error';

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-error';

          const title = document.createElement('strong');
          title.textContent = 'Wrangler not installed';
          alertDiv.appendChild(title);

          const para = document.createElement('p');
          para.textContent = 'Please install wrangler first:';
          alertDiv.appendChild(para);

          const code = document.createElement('code');
          code.style.display = 'block';
          code.style.marginTop = '0.5rem';
          code.textContent = 'npm install -g wrangler';
          alertDiv.appendChild(code);

          prereqContent.appendChild(alertDiv);
          return false;
        }

        if (!result.auth.isLoggedIn) {
          prereqStatus.textContent = 'Login Required';
          prereqStatus.className = 'status-badge status-warning';

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-warning';

          const title = document.createElement('strong');
          title.textContent = 'Not logged in to Cloudflare';
          alertDiv.appendChild(title);

          const para1 = document.createElement('p');
          para1.textContent = 'Please run this command in your terminal:';
          alertDiv.appendChild(para1);

          const code = document.createElement('code');
          code.style.display = 'block';
          code.style.marginTop = '0.5rem';
          code.textContent = 'wrangler login';
          alertDiv.appendChild(code);

          const para2 = document.createElement('p');
          para2.style.marginTop = '0.5rem';
          para2.textContent = 'Then refresh this page.';
          alertDiv.appendChild(para2);

          prereqContent.appendChild(alertDiv);
          return false;
        }

        prereqStatus.textContent = 'Ready';
        prereqStatus.className = 'status-badge status-success';

        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-success';

        const p1 = document.createElement('p');
        p1.textContent = 'Wrangler installed';
        alertDiv.appendChild(p1);

        const p2 = document.createElement('p');
        p2.textContent = 'Logged in as ' + (result.auth.email || 'Unknown');
        alertDiv.appendChild(p2);

        prereqContent.appendChild(alertDiv);

        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'button-group';

        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.textContent = 'Start Setup';
        btn.addEventListener('click', startSetup);
        buttonGroup.appendChild(btn);

        prereqContent.appendChild(buttonGroup);

        return true;
      } catch (error) {
        prereqStatus.textContent = 'Error';
        prereqStatus.className = 'status-badge status-error';
        prereqContent.textContent = '';
        prereqContent.appendChild(createAlert('error', 'Error checking prerequisites: ' + error.message));
        return false;
      }
    }

    // Start setup
    function startSetup() {
      setStep(2);
      showSection('config');
    }

    // Configure
    document.getElementById('btn-configure').addEventListener('click', async () => {
      const env = document.getElementById('env').value;
      const domain = document.getElementById('domain').value;

      config = {
        env,
        domain: domain || null,
        components: {
          api: true,
          loginUi: document.getElementById('comp-login-ui').checked,
          adminUi: document.getElementById('comp-admin-ui').checked,
          saml: document.getElementById('comp-saml').checked,
          vc: document.getElementById('comp-vc').checked,
        },
      };

      // Create default config
      await api('/config/default', {
        method: 'POST',
        body: { env, domain },
      });

      setStep(3);
      showSection('provision');
    });

    document.getElementById('btn-back-config').addEventListener('click', () => {
      setStep(2);
      showSection('config');
    });

    // Provision
    document.getElementById('btn-provision').addEventListener('click', async () => {
      const btn = document.getElementById('btn-provision');
      const status = document.getElementById('provision-status');
      const log = document.getElementById('provision-log');
      const output = document.getElementById('provision-output');

      btn.disabled = true;
      status.textContent = 'Running...';
      status.className = 'status-badge status-running';
      log.classList.remove('hidden');
      output.textContent = '';

      try {
        // Generate keys
        output.textContent += 'Generating cryptographic keys...\\n';
        await api('/keys/generate', {
          method: 'POST',
          body: { keyId: config.env + '-key-' + Date.now() },
        });
        output.textContent += 'Keys generated\\n\\n';

        // Provision resources
        output.textContent += 'Provisioning Cloudflare resources...\\n';
        const result = await api('/provision', {
          method: 'POST',
          body: { env: config.env },
        });

        if (result.success) {
          output.textContent += '\\nProvisioning complete!\\n';
          status.textContent = 'Complete';
          status.className = 'status-badge status-success';

          setStep(4);
          setTimeout(() => showSection('deploy'), 1000);
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        output.textContent += '\\nError: ' + error.message + '\\n';
        status.textContent = 'Error';
        status.className = 'status-badge status-error';
        btn.disabled = false;
      }
    });

    document.getElementById('btn-back-provision').addEventListener('click', () => {
      setStep(3);
      showSection('provision');
    });

    // Deploy
    document.getElementById('btn-deploy').addEventListener('click', async () => {
      const btn = document.getElementById('btn-deploy');
      const status = document.getElementById('deploy-status');
      const log = document.getElementById('deploy-log');
      const output = document.getElementById('deploy-output');

      btn.disabled = true;
      status.textContent = 'Deploying...';
      status.className = 'status-badge status-running';
      log.classList.remove('hidden');
      output.textContent = 'Starting deployment...\\n\\n';

      try {
        // Generate wrangler configs first
        output.textContent += 'Generating wrangler.toml files...\\n';
        await api('/wrangler/generate', {
          method: 'POST',
          body: { env: config.env },
        });
        output.textContent += 'Config files generated\\n\\n';

        // Start deployment
        output.textContent += 'Deploying workers...\\n';

        // Poll for status updates
        const pollInterval = setInterval(async () => {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress.length > 0) {
            output.textContent = statusResult.progress.join('\\n') + '\\n';
          }
        }, 1000);

        const result = await api('/deploy', {
          method: 'POST',
          body: {
            env: config.env,
            dryRun: false,
          },
        });

        clearInterval(pollInterval);

        if (result.success) {
          output.textContent += '\\nDeployment complete!\\n';
          status.textContent = 'Complete';
          status.className = 'status-badge status-success';

          // Show completion
          showComplete();
        } else {
          throw new Error(result.error || 'Deployment failed');
        }
      } catch (error) {
        output.textContent += '\\nError: ' + error.message + '\\n';
        status.textContent = 'Error';
        status.className = 'status-badge status-error';
        btn.disabled = false;
      }
    });

    // Show completion
    function showComplete() {
      const urlsEl = document.getElementById('urls');
      const env = config.env;
      const domain = config.domain;

      const apiUrl = domain ? 'https://' + domain : 'https://' + env + '-ar-router.workers.dev';
      const loginUrl = domain ? 'https://' + domain + '/login' : 'https://' + env + '-ar-ui.pages.dev';
      const adminUrl = domain ? 'https://' + domain + '/admin' : 'https://' + env + '-ar-ui.pages.dev/admin';

      // Clear and rebuild URLs section safely
      urlsEl.textContent = '';
      urlsEl.appendChild(createUrlItem('API (Issuer):', apiUrl));
      urlsEl.appendChild(createUrlItem('Login UI:', loginUrl));
      urlsEl.appendChild(createUrlItem('Admin UI:', adminUrl));

      showSection('complete');
    }

    // Initialize
    checkPrerequisites();
  </script>
</body>
</html>`;
}

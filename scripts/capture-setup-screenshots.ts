/**
 * Playwright script to capture screenshots of @authrim/setup Web UI
 *
 * This script:
 * 1. Starts the setup tool's web server
 * 2. Intercepts API calls to mock responses (no actual resources created)
 * 3. Navigates through each screen and captures screenshots for all 11 languages
 * 4. Saves screenshots to authrim-website/public/images/setup/{lang}/
 *
 * Usage:
 *   cd authrim
 *   npx tsx scripts/capture-setup-screenshots.ts
 */

import { chromium, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Base screenshot directory
const SCREENSHOT_BASE_DIR = path.join(
  process.cwd(),
  '..',
  'authrim-website',
  'public',
  'images',
  'setup'
);
const VIEWPORT = { width: 1280, height: 800 };
const SERVER_PORT = 3456;
const BASE_URL = `http://localhost:${SERVER_PORT}`;

// All supported languages
const LANGUAGES = ['en', 'ja', 'zh-CN', 'zh-TW', 'es', 'pt', 'fr', 'de', 'ko', 'ru', 'id'];

// Wait for animation to complete
const ANIMATION_DELAY = 600;
// Extra delay for complex screens
const LONG_DELAY = 1200;

/**
 * Start the @authrim/setup web server
 */
async function startSetupServer(): Promise<ChildProcess> {
  console.log('Starting @authrim/setup server...');

  const setupDir = path.join(process.cwd(), 'packages', 'setup');
  const serverProcess = spawn('npx', ['tsx', 'src/index.ts', 'init', '--lang', 'en'], {
    cwd: setupDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timeout'));
    }, 60000);

    serverProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      console.log('[Server]', output.trim());

      if (output.includes('Choose setup method') || output.includes('Web UI')) {
        setTimeout(() => {
          serverProcess.stdin?.write('\n');
        }, 500);
      }

      if (output.includes('Press ENTER')) {
        serverProcess.stdin?.write('\n');
      }

      if (output.includes('localhost:') || output.includes('Open at') || output.includes('3456')) {
        clearTimeout(timeout);
        setTimeout(resolve, 3000);
      }
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.error('[Server Error]', output);
      }
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return serverProcess;
}

/**
 * Setup API mocks to prevent actual resource creation
 */
async function setupMocks(page: Page): Promise<void> {
  await page.route('**/api/prerequisites', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        wranglerInstalled: true,
        auth: {
          isLoggedIn: true,
          email: 'demo@example.com',
          accountId: 'abc123def456789',
          accountName: 'Demo Account',
        },
        workersSubdomain: 'demo-account',
        cwd: '/Users/demo/projects/authrim',
      }),
    });
  });

  await page.route('**/api/config', async (route, request) => {
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          exists: false,
          config: null,
          structure: 'new',
          environments: [],
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }
  });

  await page.route('**/api/config/default', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        config: {
          environment: { prefix: 'prod' },
          tenant: { name: 'default', displayName: 'Default Tenant' },
          components: {
            auth: true,
            token: true,
            userinfo: true,
            management: true,
            discovery: true,
            saml: false,
            async: false,
            vc: false,
            bridge: false,
            policy: false,
            loginUi: true,
            adminUi: true,
          },
          urls: {
            api: { custom: null, auto: 'https://prod-ar-router.demo-account.workers.dev' },
            loginUi: { custom: null, auto: 'https://prod-ar-login-ui.pages.dev' },
            adminUi: { custom: null, auto: 'https://prod-ar-admin-ui.pages.dev' },
          },
        },
      }),
    });
  });

  await page.route('**/api/keys/check/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ exists: false }),
    });
  });

  await page.route('**/api/keys/generate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        keyId: 'key-2024-demo',
        publicKeyJwk: { kty: 'RSA', n: '...', e: 'AQAB', kid: 'key-2024-demo' },
        keysPath: '.authrim/prod/keys',
      }),
    });
  });

  await page.route('**/api/provision', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        resources: {
          d1: {
            core: { id: 'd1-core-id', name: 'prod-authrim-core' },
            pii: { id: 'd1-pii-id', name: 'prod-authrim-pii' },
          },
          kv: {
            sessions: { id: 'kv-sessions-id', name: 'prod-authrim-sessions' },
            config: { id: 'kv-config-id', name: 'prod-authrim-config' },
          },
        },
        lock: {
          env: 'prod',
          createdAt: new Date().toISOString(),
        },
      }),
    });
  });

  await page.route('**/api/deploy', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        summary: {
          totalComponents: 8,
          successCount: 8,
          failedCount: 0,
          results: [
            { component: 'ar-lib-core', success: true, workerName: 'prod-ar-lib-core' },
            { component: 'ar-discovery', success: true, workerName: 'prod-ar-discovery' },
            { component: 'ar-auth', success: true, workerName: 'prod-ar-auth' },
            { component: 'ar-token', success: true, workerName: 'prod-ar-token' },
            { component: 'ar-userinfo', success: true, workerName: 'prod-ar-userinfo' },
            { component: 'ar-management', success: true, workerName: 'prod-ar-management' },
            { component: 'ar-router', success: true, workerName: 'prod-ar-router' },
          ],
        },
        pagesResult: {
          results: [
            { component: 'ar-login-ui', success: true, projectName: 'prod-ar-login-ui' },
            { component: 'ar-admin-ui', success: true, projectName: 'prod-ar-admin-ui' },
          ],
        },
      }),
    });
  });

  await page.route('**/api/state', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'idle',
        config: null,
        auth: null,
        progress: [],
        error: null,
        deployResults: [],
      }),
    });
  });

  await page.route('**/api/deploy/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'complete',
        progress: ['Deployment complete!'],
        error: null,
        results: [],
      }),
    });
  });

  await page.route('**/api/admin/setup', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        setupUrl:
          'https://prod-ar-router.demo-account.workers.dev/admin-init-setup?token=demo-token',
        message: 'Visit the setup URL to create the initial administrator',
      }),
    });
  });

  await page.route('**/api/email/configure', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        provider: 'resend',
        fromAddress: 'auth@example.com',
        message: 'Email configuration saved.',
      }),
    });
  });

  await page.route('**/api/wrangler/generate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        components: [
          'ar-lib-core',
          'ar-discovery',
          'ar-auth',
          'ar-token',
          'ar-userinfo',
          'ar-management',
          'ar-router',
        ],
      }),
    });
  });

  await page.route('**/api/environments', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        environments: [],
        progress: [],
      }),
    });
  });
}

/**
 * Scroll to top and capture a full-page screenshot
 */
async function capture(page: Page, screenshotDir: string, name: string): Promise<void> {
  // Scroll to top of page before capturing
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);

  const filepath = path.join(screenshotDir, name);
  await page.screenshot({
    path: filepath,
    fullPage: true,
  });
  console.log(`    ✓ ${name}`);
}

/**
 * Capture screenshots for a single language
 */
async function captureForLanguage(page: Page, lang: string): Promise<void> {
  const screenshotDir = path.join(SCREENSHOT_BASE_DIR, lang);

  // Ensure directory exists
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  console.log(`\n  📸 Capturing screenshots for: ${lang}`);

  // Navigate to the setup page with language parameter
  await page.goto(`${BASE_URL}?lang=${lang}`, { waitUntil: 'networkidle' });

  // 1. Splash screen
  await page.waitForTimeout(1500);
  await capture(page, screenshotDir, '01-splash.png');

  // Wait for splash to fade
  await page.waitForTimeout(1500);

  // 2. Prerequisites check
  await page.waitForSelector('#section-prerequisites:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(ANIMATION_DELAY);
  await capture(page, screenshotDir, '02-prerequisites.png');

  // Click Continue
  await page.click('#section-prerequisites button.btn-primary');
  await page.waitForTimeout(ANIMATION_DELAY);

  // 3. Top Menu
  await page.waitForSelector('#section-top-menu:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(ANIMATION_DELAY);
  await capture(page, screenshotDir, '03-main-menu.png');

  // Click "New Setup"
  await page.click('#menu-new-setup');
  await page.waitForTimeout(ANIMATION_DELAY);

  // 4. Setup Mode Selection
  await page.waitForSelector('#section-mode:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(ANIMATION_DELAY);
  await capture(page, screenshotDir, '04-setup-mode.png');

  // Click "Custom Setup"
  await page.click('#mode-custom');
  await page.waitForTimeout(ANIMATION_DELAY);

  // 5. Configuration screen
  await page.waitForSelector('#section-config:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(LONG_DELAY);

  // Fill in sample values
  const envInput = await page.$('#env');
  if (envInput) {
    await envInput.fill('prod');
  }
  const tenantInput = await page.$('#tenant-display');
  if (tenantInput) {
    await tenantInput.fill('My Company');
  }

  await page.waitForTimeout(ANIMATION_DELAY);
  await capture(page, screenshotDir, '05-configuration.png');

  // Click Continue
  await page.click('#btn-configure');
  await page.waitForTimeout(ANIMATION_DELAY);

  // 6. Database Configuration
  await page.waitForSelector('#section-database:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(LONG_DELAY);
  await capture(page, screenshotDir, '06-database.png');

  // Click Continue
  await page.click('#btn-continue-database');
  await page.waitForTimeout(ANIMATION_DELAY);

  // 7. Email Configuration
  await page.waitForSelector('#section-email:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(LONG_DELAY);
  await capture(page, screenshotDir, '07-email.png');

  // Click Continue
  await page.click('#btn-continue-email');
  await page.waitForTimeout(ANIMATION_DELAY);

  // Handle "Save Configuration?" modal
  const saveModal = await page.$('#save-config-modal:not(.hidden)');
  if (saveModal) {
    await capture(page, screenshotDir, '08-save-modal.png');
    await page.click('#modal-skip-save');
    await page.waitForTimeout(ANIMATION_DELAY);
  }

  // 8. Provisioning screen
  await page.waitForSelector('#section-provision:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(LONG_DELAY);
  await capture(page, screenshotDir, '09-provision-ready.png');

  // Start provisioning
  await page.click('#btn-provision');
  await page.waitForTimeout(500);
  await capture(page, screenshotDir, '10-provisioning.png');

  // Wait for provisioning to complete
  await page.waitForSelector('#btn-goto-deploy:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(ANIMATION_DELAY);
  await capture(page, screenshotDir, '11-provision-complete.png');

  // Click Continue to Deploy
  await page.click('#btn-goto-deploy');
  await page.waitForTimeout(ANIMATION_DELAY);

  // 9. Deployment screen
  await page.waitForSelector('#section-deploy:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(LONG_DELAY);
  await capture(page, screenshotDir, '12-deploy-ready.png');

  // Start deployment
  await page.click('#btn-deploy');
  await page.waitForTimeout(500);
  await capture(page, screenshotDir, '13-deploying.png');

  // 10. Complete screen
  await page.waitForSelector('#section-complete:not(.hidden)', { timeout: 60000 });
  await page.waitForTimeout(LONG_DELAY);
  await capture(page, screenshotDir, '14-complete.png');
}

/**
 * Main screenshot capture flow
 */
async function captureScreenshots(): Promise<void> {
  // Ensure base screenshot directory exists
  if (!fs.existsSync(SCREENSHOT_BASE_DIR)) {
    fs.mkdirSync(SCREENSHOT_BASE_DIR, { recursive: true });
  }

  let serverProcess: ChildProcess | null = null;

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    // Start server
    serverProcess = await startSetupServer();
    console.log('Server started successfully');

    // Setup API mocks
    await setupMocks(page);

    console.log('\n📸 Starting screenshot capture for all languages...\n');

    // Capture screenshots for each language
    for (const lang of LANGUAGES) {
      await captureForLanguage(page, lang);
    }

    console.log('\n✅ Screenshot capture complete for all languages!\n');
    console.log(`Screenshots saved to: ${SCREENSHOT_BASE_DIR}/{lang}/`);
  } catch (error) {
    console.error('Error during screenshot capture:', error);
    try {
      await page.screenshot({ path: path.join(SCREENSHOT_BASE_DIR, 'error-debug.png') });
      console.log('Debug screenshot saved to error-debug.png');
    } catch (e) {
      console.error('Could not save debug screenshot:', e);
    }
    throw error;
  } finally {
    await browser.close();
    if (serverProcess) {
      console.log('Stopping server...');
      serverProcess.kill('SIGTERM');
    }
  }
}

// Run the script
captureScreenshots().catch((error) => {
  console.error('Failed to capture screenshots:', error);
  process.exit(1);
});

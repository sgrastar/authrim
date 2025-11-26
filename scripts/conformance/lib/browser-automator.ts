/**
 * Browser Automator for OIDC Conformance Tests
 *
 * Handles browser-based user interactions during conformance testing
 * using Playwright for automation.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { TestUser, BrowserAction } from './types.js';

export interface BrowserAutomatorOptions {
  headless?: boolean;
  slowMo?: number;
  timeout?: number;
  screenshotOnError?: boolean;
  screenshotDir?: string;
}

export class BrowserAutomator {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private options: Required<BrowserAutomatorOptions>;
  private currentTestName: string = 'unknown';

  constructor(options: BrowserAutomatorOptions = {}) {
    this.options = {
      headless: options.headless ?? true,
      slowMo: options.slowMo ?? 0,
      timeout: options.timeout ?? 30000,
      screenshotOnError: options.screenshotOnError ?? true,
      screenshotDir: options.screenshotDir ?? './screenshots',
    };
  }

  /**
   * Initialize the browser
   */
  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.options.headless,
      slowMo: this.options.slowMo,
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });

    this.context.setDefaultTimeout(this.options.timeout);
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Clear all cookies for specific domains (useful for prompt=none tests)
   */
  async clearCookies(domains?: string[]): Promise<void> {
    if (!this.context) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    if (domains && domains.length > 0) {
      // Clear cookies for specific domains
      const cookies = await this.context.cookies();
      const cookiesToClear = cookies.filter(c =>
        domains.some(d => c.domain.includes(d) || d.includes(c.domain))
      );

      if (cookiesToClear.length > 0) {
        await this.context.clearCookies();
        console.log(`[Browser] Cleared ${cookiesToClear.length} cookies for domains: ${domains.join(', ')}`);
      }
    } else {
      // Clear all cookies
      await this.context.clearCookies();
      console.log('[Browser] Cleared all cookies');
    }
  }

  /**
   * Create a new browser context (for isolated tests)
   * Useful for tests that need a fresh session
   */
  async createFreshContext(): Promise<void> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    // Close existing context
    if (this.context) {
      await this.context.close();
    }

    // Create new context
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });

    this.context.setDefaultTimeout(this.options.timeout);
    console.log('[Browser] Created fresh browser context');
  }

  /**
   * Handle a user interaction (login, consent, etc.)
   */
  async handleUserInteraction(
    authUrl: string,
    testUser: TestUser,
    options: {
      autoConsent?: boolean;
      maxAttempts?: number;
      testName?: string;
    } = {}
  ): Promise<string> {
    const { autoConsent = true, maxAttempts = 3, testName = 'unknown' } = options;
    this.currentTestName = testName;

    if (!this.context) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    const page = await this.context.newPage();

    try {
      console.log(`[Browser] Navigating to: ${authUrl}`);
      await page.goto(authUrl, { waitUntil: 'networkidle' });

      // Detect the current page type and handle accordingly
      let attempts = 0;
      while (attempts < maxAttempts) {
        attempts++;
        const currentUrl = page.url();
        console.log(`[Browser] Current URL: ${currentUrl}`);

        // Check if we've been redirected back to the conformance suite
        if (this.isConformanceCallback(currentUrl)) {
          console.log('[Browser] Redirected back to conformance suite');
          return currentUrl;
        }

        // Detect page type
        const pageType = await this.detectPageType(page);
        console.log(`[Browser] Detected page type: ${pageType}`);

        switch (pageType) {
          case 'login':
            await this.handleLogin(page, testUser);
            break;
          case 'consent':
            if (autoConsent) {
              await this.handleConsent(page, true);
            } else {
              throw new Error('Consent required but autoConsent is disabled');
            }
            break;
          case 'reauth':
            await this.handleReauth(page);
            break;
          case 'error':
            // Error page detected - this is expected for negative tests
            // The test should complete as the error is the expected outcome
            const errorMessage = await this.extractErrorMessage(page);
            console.log(`[Browser] OAuth error detected: ${errorMessage}`);
            // Return the current URL - the test will evaluate if the error was expected
            return currentUrl;
          case 'unknown':
            console.log('[Browser] Unknown page, waiting for navigation...');
            await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
            break;
        }

        // Wait for navigation after action
        await page.waitForLoadState('networkidle').catch(() => {});
      }

      throw new Error(`Max attempts (${maxAttempts}) reached without completing authorization`);
    } catch (error) {
      if (this.options.screenshotOnError) {
        await this.takeScreenshot(page, 'error');
      }
      throw error;
    } finally {
      await page.close();
    }
  }

  /**
   * Detect the type of the current page
   */
  private async detectPageType(
    page: Page
  ): Promise<'login' | 'consent' | 'reauth' | 'error' | 'unknown'> {
    const url = page.url();

    // Check URL patterns
    if (url.includes('/login') || url.includes('/signin')) {
      return 'login';
    }
    if (url.includes('/reauth')) {
      return 'reauth';
    }
    if (url.includes('/error')) {
      return 'error';
    }

    // Check for JSON error response (OAuth 2.0 error)
    const pageContent = await page.content();
    if (pageContent.includes('"error"') &&
        (pageContent.includes('"error_description"') || pageContent.includes('unsupported') || pageContent.includes('invalid'))) {
      return 'error';
    }

    // Check for login form elements
    const hasEmailInput = await page
      .locator('input[type="email"], input[name="email"]')
      .first()
      .isVisible()
      .catch(() => false);
    const hasUsernameInput = await page
      .locator('input[placeholder="Username"], input[name="username"]')
      .first()
      .isVisible()
      .catch(() => false);
    const hasPasskeyButton = await page
      .locator('button:has-text("Passkey"), button:has-text("パスキー")')
      .first()
      .isVisible()
      .catch(() => false);

    if (hasEmailInput || hasUsernameInput || hasPasskeyButton) {
      return 'login';
    }

    // Check for consent page elements
    if (url.includes('/consent') || url.includes('/authorize')) {
      const hasConsentButtons = await page
        .locator('button:has-text("Allow"), button:has-text("許可")')
        .first()
        .isVisible()
        .catch(() => false);
      if (hasConsentButtons) {
        return 'consent';
      }
    }

    // Check for consent elements by scope list
    const hasScopeList = await page
      .locator('[class*="scope"], [data-testid="scopes"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (hasScopeList) {
      return 'consent';
    }

    return 'unknown';
  }

  /**
   * Handle login page
   */
  private async handleLogin(page: Page, testUser: TestUser): Promise<void> {
    console.log(`[Browser] Handling login for user: ${testUser.email}`);

    // Check for various input field types
    // Priority: email input, then username input, then generic text input
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    const usernameInput = page.locator('input[placeholder="Username"], input[name="username"], input[type="text"]').first();

    let loginInput = emailInput;
    if (!(await emailInput.isVisible().catch(() => false))) {
      loginInput = usernameInput;
    }

    if (await loginInput.isVisible().catch(() => false)) {
      // Fill in email/username
      await loginInput.fill(testUser.email);
      console.log('[Browser] Filled username/email input');

      // Look for password field (if exists)
      const passwordInput = page.locator('input[type="password"], input[placeholder="Password"]').first();
      if (await passwordInput.isVisible().catch(() => false)) {
        const password = testUser.password || 'testpassword123';
        await passwordInput.fill(password);
        console.log('[Browser] Filled password input');
      }

      // Look for submit button
      const submitButton = page.locator(
        'button[type="submit"], button:has-text("Login"), button:has-text("ログイン"), button:has-text("Send"), button:has-text("送信")'
      ).first();

      if (await submitButton.isVisible()) {
        await submitButton.click();
        console.log('[Browser] Clicked submit button');
      }
    } else {
      // Try passkey login if available (for automated testing, we might skip this)
      console.log('[Browser] No login input found, checking for alternative login methods');
    }

    // Wait for page to load after login
    await page.waitForLoadState('networkidle');
  }

  /**
   * Handle consent page
   */
  private async handleConsent(page: Page, allow: boolean): Promise<void> {
    console.log(`[Browser] Handling consent: ${allow ? 'Allow' : 'Deny'}`);

    if (allow) {
      // Look for Allow/Approve button
      const allowButton = page.locator(
        'button:has-text("Allow"), button:has-text("許可"), button:has-text("Approve"), button:has-text("承認")'
      ).first();

      if (await allowButton.isVisible()) {
        await allowButton.click();
        console.log('[Browser] Clicked Allow button');
      } else {
        throw new Error('Allow button not found on consent page');
      }
    } else {
      // Look for Deny/Cancel button
      const denyButton = page.locator(
        'button:has-text("Deny"), button:has-text("拒否"), button:has-text("Cancel"), button:has-text("キャンセル")'
      ).first();

      if (await denyButton.isVisible()) {
        await denyButton.click();
        console.log('[Browser] Clicked Deny button');
      } else {
        throw new Error('Deny button not found on consent page');
      }
    }

    // Wait for redirect
    await page.waitForLoadState('networkidle');
  }

  /**
   * Handle re-authentication page
   * This page appears when prompt=login or max_age requires re-authentication
   */
  private async handleReauth(page: Page): Promise<void> {
    console.log('[Browser] Handling re-authentication page');

    // Look for Continue button on reauth page
    const continueButton = page.locator(
      'button[type="submit"], button:has-text("Continue"), button:has-text("続ける"), button:has-text("確認")'
    ).first();

    if (await continueButton.isVisible()) {
      await continueButton.click();
      console.log('[Browser] Clicked Continue button on reauth page');
    } else {
      throw new Error('Continue button not found on reauth page');
    }

    // Wait for redirect
    await page.waitForLoadState('networkidle');
  }

  /**
   * Extract error message from error page
   */
  private async extractErrorMessage(page: Page): Promise<string> {
    // First, try to extract JSON error from page content
    const pageContent = await page.content();

    // Try to parse JSON error response
    const jsonMatch = pageContent.match(/\{"error"[^}]+\}/);
    if (jsonMatch) {
      try {
        const errorJson = JSON.parse(jsonMatch[0]);
        const errorDesc = errorJson.error_description || errorJson.error || 'Unknown error';
        return `${errorJson.error}: ${errorDesc}`;
      } catch {
        // Not valid JSON, continue to other methods
      }
    }

    // Try to find error in HTML elements
    const errorElement = await page
      .locator('[class*="error"], [role="alert"], .alert-error')
      .first();

    if (await errorElement.isVisible().catch(() => false)) {
      return (await errorElement.textContent()) || 'Unknown error';
    }

    // Check for plain text error on page
    const bodyText = await page.locator('body').textContent().catch(() => '');
    if (bodyText && bodyText.includes('error')) {
      return bodyText.substring(0, 200);
    }

    return 'Unknown error on page';
  }

  /**
   * Check if the URL is a conformance suite callback (test completion)
   * The callback URL contains code= or error= parameters, indicating
   * the authorization flow has completed and we've been redirected back
   */
  private isConformanceCallback(url: string): boolean {
    // Only consider it a callback if we have an authorization code or error
    // Just being on certification.openid.net doesn't mean the flow is complete
    return (
      url.includes('code=') ||
      url.includes('error=') ||
      url.includes('/callback?')
    );
  }

  /**
   * Take a screenshot
   */
  private async takeScreenshot(page: Page, type: 'login' | 'consent' | 'error' | string): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    await fs.mkdir(this.options.screenshotDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const testNameSafe = this.currentTestName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filePath = path.join(this.options.screenshotDir, `${testNameSafe}_${type}_${timestamp}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[Browser] Screenshot saved: ${filePath}`);
  }

  /**
   * Handle email verification code flow
   * Note: This requires access to the test email inbox
   */
  async handleEmailCodeVerification(
    page: Page,
    getVerificationCode: () => Promise<string>
  ): Promise<void> {
    console.log('[Browser] Waiting for verification code...');

    // Get the verification code from external source (e.g., email API)
    const code = await getVerificationCode();
    console.log('[Browser] Got verification code');

    // Find and fill the code input
    const codeInput = page.locator(
      'input[name="code"], input[type="text"][maxlength="6"], input[placeholder*="code"]'
    ).first();

    if (await codeInput.isVisible()) {
      await codeInput.fill(code);
      console.log('[Browser] Filled verification code');

      // Submit the code
      const submitButton = page.locator(
        'button[type="submit"], button:has-text("Verify"), button:has-text("確認")'
      ).first();

      if (await submitButton.isVisible()) {
        await submitButton.click();
      }
    } else {
      throw new Error('Verification code input not found');
    }

    await page.waitForLoadState('networkidle');
  }
}

/**
 * Create a BrowserAutomator from environment variables
 */
export function createBrowserAutomatorFromEnv(): BrowserAutomator {
  return new BrowserAutomator({
    headless: process.env.HEADLESS !== 'false',
    slowMo: parseInt(process.env.SLOW_MO || '0', 10),
    timeout: parseInt(process.env.BROWSER_TIMEOUT || '30000', 10),
    screenshotOnError: process.env.SCREENSHOT_ON_ERROR !== 'false',
    screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',
  });
}

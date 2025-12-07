/**
 * Browser Automator for OIDC Conformance Tests
 *
 * Handles browser-based user interactions during conformance testing
 * using Playwright for automation.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { TestUser, BrowserAction } from './types.js';

// Re-export Page type for external use
export type { Page };

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
          // For fragment-based responses (implicit/hybrid flows), wait for the page to process
          // The conformance suite's callback page needs time to parse the fragment via JavaScript
          // and send the data to the server before we can consider the flow complete
          try {
            const urlObj = new URL(currentUrl);
            // Check if there's a fragment with OAuth/OIDC response parameters
            // This includes both error responses and successful responses (code, access_token, id_token)
            const hasFragmentResponse = urlObj.hash && (
              urlObj.hash.includes('error=') ||
              urlObj.hash.includes('code=') ||
              urlObj.hash.includes('access_token=') ||
              urlObj.hash.includes('id_token=')
            );
            if (hasFragmentResponse) {
              console.log('[Browser] Fragment response detected, waiting for page to process...');
              // Wait for the page to process the fragment (conformance suite's JavaScript)
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
              // Also wait for the page to update (title/content change)
              await page.waitForTimeout(1000);
            }
          } catch {
            // Ignore URL parsing errors
          }
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
            // Log page content for debugging unknown page types
            const pageTitle = await page.title().catch(() => 'Unknown');
            const bodyPreview = await page.locator('body').textContent().catch(() => '');
            console.log(`[Browser] Unknown page type. Title: "${pageTitle}"`);
            console.log(`[Browser] Body preview: ${bodyPreview?.substring(0, 200) || 'Empty'}`);
            console.log('[Browser] Waiting for navigation...');
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
    if (url.includes('/reauth') || url.includes('/reauthenticate')) {
      return 'reauth';
    }
    if (url.includes('/error')) {
      return 'error';
    }

    // Check URL parameters for OAuth errors (e.g., ?error=unsupported_response_type)
    // This catches errors that are returned as URL parameters in redirect
    try {
      const urlObj = new URL(url);
      if (urlObj.searchParams.has('error')) {
        console.log(`[Browser] Detected OAuth error in URL params: ${urlObj.searchParams.get('error')}`);
        return 'error';
      }

      // Check URL fragment for OAuth errors (e.g., #error=invalid_request)
      // This is required for implicit and hybrid flows per OIDC Core 3.2.2.6 and 3.3.2.6
      // Errors are returned in the fragment (hash) for these flows
      if (urlObj.hash) {
        const hashParams = new URLSearchParams(urlObj.hash.substring(1)); // Remove leading #
        if (hashParams.has('error')) {
          console.log(`[Browser] Detected OAuth error in URL fragment: ${hashParams.get('error')}`);
          return 'error';
        }
      }
    } catch {
      // Invalid URL, continue with other checks
    }

    // Check for JSON error response (OAuth 2.0 error)
    const pageContent = await page.content();
    if (pageContent.includes('"error"') &&
        (pageContent.includes('"error_description"') || pageContent.includes('unsupported') || pageContent.includes('invalid'))) {
      return 'error';
    }

    // Check if page body displays OAuth error response
    // Some servers display error as plain text or JSON without proper Content-Type
    const bodyText = await page.locator('body').textContent().catch(() => '');
    if (bodyText && (
      bodyText.includes('unsupported_response_type') ||
      bodyText.includes('invalid_request') ||
      bodyText.includes('unauthorized_client') ||
      bodyText.includes('access_denied') ||
      bodyText.includes('invalid_scope')
    )) {
      console.log(`[Browser] Detected OAuth error in page body`);
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
    const hasPasswordInput = await page
      .locator('input[type="password"], input[name="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    const hasPasskeyButton = await page
      .locator('button:has-text("Passkey"), button:has-text("パスキー")')
      .first()
      .isVisible()
      .catch(() => false);

    // Password input alone might indicate reauth scenario (user already known)
    // Check if only password is visible without email/username
    if (hasPasswordInput && !hasEmailInput && !hasUsernameInput) {
      // This might be a reauth page where user identity is already known
      // Check for indicators of reauth vs login
      const hasUserDisplay = await page
        .locator('[class*="user"], [class*="profile"], [data-testid*="user"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (hasUserDisplay) {
        return 'reauth';
      }
    }

    if (hasEmailInput || hasUsernameInput || hasPasswordInput || hasPasskeyButton) {
      return 'login';
    }

    // Check for consent page elements
    if (url.includes('/consent') || url.includes('/authorize')) {
      const hasConsentButtons = await page
        .locator('button:has-text("Allow"), button:has-text("許可"), button:has-text("Approve"), button:has-text("承認")')
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

    // Check for account selection page (might appear with max_age or prompt=select_account)
    const hasAccountList = await page
      .locator('[class*="account"], [data-testid*="account"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (hasAccountList) {
      // Treat account selection as a form of login
      return 'login';
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
    const usernameInput = page.locator('input[placeholder="Username"], input[name="username"]').first();
    const passwordInput = page.locator('input[type="password"], input[name="password"], input[placeholder="Password"]').first();

    const hasEmailInput = await emailInput.isVisible().catch(() => false);
    const hasUsernameInput = await usernameInput.isVisible().catch(() => false);
    const hasPasswordInput = await passwordInput.isVisible().catch(() => false);

    console.log(`[Browser] Form fields - Email: ${hasEmailInput}, Username: ${hasUsernameInput}, Password: ${hasPasswordInput}`);

    // Fill username/email if present
    if (hasEmailInput) {
      await emailInput.fill(testUser.email);
      console.log('[Browser] Filled email input');
    } else if (hasUsernameInput) {
      await usernameInput.fill(testUser.email);
      console.log('[Browser] Filled username input');
    }

    // Fill password if present
    if (hasPasswordInput) {
      const password = testUser.password || 'testpassword123';
      await passwordInput.fill(password);
      console.log('[Browser] Filled password input');
    }

    // Wait for form to be ready before submitting
    // This ensures any JavaScript validation has time to complete
    // Especially important for prompt=login and max_age tests
    await page.waitForTimeout(500);

    // Look for submit button with various labels
    const submitButton = page.locator(
      'button[type="submit"], button:has-text("Login"), button:has-text("ログイン"), button:has-text("Sign in"), button:has-text("サインイン"), button:has-text("Send"), button:has-text("送信"), button:has-text("Continue"), button:has-text("続ける")'
    ).first();

    if (await submitButton.isVisible()) {
      await submitButton.click();
      console.log('[Browser] Clicked submit button');
    } else {
      // Try to find any visible button that might be a submit
      const anyButton = page.locator('button:visible').first();
      if (await anyButton.isVisible().catch(() => false)) {
        const buttonText = await anyButton.textContent();
        console.log(`[Browser] Clicking visible button: "${buttonText}"`);
        await anyButton.click();
      } else {
        console.log('[Browser] No submit button found');
      }
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
    // Also handle custom callback paths like /callback/XXX used by some tests
    const isCallback = (
      url.includes('code=') ||
      url.includes('error=') ||
      url.includes('/callback?') ||
      // Match /callback/ followed by path segment (for custom redirect URIs)
      /\/callback\/[^/]+/.test(url)
    );

    if (isCallback) {
      console.log(`[Browser] Detected conformance callback URL: ${url}`);
    }

    return isCallback;
  }

  /**
   * Take a screenshot and return the file path
   * @param page - Playwright page instance
   * @param type - Screenshot type (used in filename)
   * @returns Path to the saved screenshot file
   */
  async takeScreenshot(page: Page, type: 'login' | 'consent' | 'error' | 'evidence' | string): Promise<string> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    await fs.mkdir(this.options.screenshotDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const testNameSafe = this.currentTestName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filePath = path.join(this.options.screenshotDir, `${testNameSafe}_${type}_${timestamp}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[Browser] Screenshot saved: ${filePath}`);
    return filePath;
  }

  /**
   * Set the current test name (used in screenshot filenames)
   */
  setCurrentTestName(testName: string): void {
    this.currentTestName = testName;
  }

  /**
   * Get a new page for manual screenshot capture
   * Caller is responsible for closing the page when done
   */
  async getNewPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }
    return this.context.newPage();
  }

  /**
   * Handle a user interaction with evidence screenshot capture
   * Returns both the final URL and any captured screenshot path
   */
  async handleUserInteractionWithEvidence(
    authUrl: string,
    testUser: TestUser,
    options: {
      autoConsent?: boolean;
      maxAttempts?: number;
      testName?: string;
      captureOnError?: boolean;
      captureOnInteraction?: boolean;
    } = {}
  ): Promise<{ finalUrl: string; screenshotPath?: string }> {
    const {
      autoConsent = true,
      maxAttempts = 3,
      testName = 'unknown',
      captureOnError = true,
      captureOnInteraction = false,
    } = options;
    this.currentTestName = testName;

    if (!this.context) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    const page = await this.context.newPage();
    let screenshotPath: string | undefined;

    const captureInteractionScreenshot = async (pageType: string) => {
      if (!captureOnInteraction || screenshotPath) {
        return;
      }
      try {
        screenshotPath = await this.takeScreenshot(page, 'evidence');
        console.log(`[Browser] Interaction screenshot captured (${pageType}): ${screenshotPath}`);
      } catch (error) {
        console.log(`[Browser] Failed to capture interaction screenshot (${pageType}): ${error}`);
      }
    };

    try {
      console.log(`[Browser] Navigating to: ${authUrl}`);
      await page.goto(authUrl, { waitUntil: 'networkidle' });

      let attempts = 0;
      while (attempts < maxAttempts) {
        attempts++;
        const currentUrl = page.url();
        console.log(`[Browser] Current URL: ${currentUrl}`);

        if (this.isConformanceCallback(currentUrl)) {
          console.log('[Browser] Redirected back to conformance suite');
          return { finalUrl: currentUrl, screenshotPath };
        }

        const pageType = await this.detectPageType(page);
        console.log(`[Browser] Detected page type: ${pageType}`);

        switch (pageType) {
          case 'login':
            await captureInteractionScreenshot(pageType);
            await this.handleLogin(page, testUser);
            break;
          case 'consent':
            await captureInteractionScreenshot(pageType);
            if (autoConsent) {
              await this.handleConsent(page, true);
            } else {
              throw new Error('Consent required but autoConsent is disabled');
            }
            break;
          case 'reauth':
            await captureInteractionScreenshot(pageType);
            await this.handleReauth(page);
            break;
          case 'error':
            // Capture evidence screenshot on error page
            if (captureOnError) {
              screenshotPath = await this.takeScreenshot(page, 'evidence');
              console.log(`[Browser] Evidence screenshot captured: ${screenshotPath}`);
            }
            const errorMsg = await this.extractErrorMessage(page);
            console.log(`[Browser] OAuth error detected: ${errorMsg}`);
            return { finalUrl: currentUrl, screenshotPath };
          case 'unknown':
            // Log page content for debugging unknown page types
            const evidencePageTitle = await page.title().catch(() => 'Unknown');
            const evidenceBodyPreview = await page.locator('body').textContent().catch(() => '');
            console.log(`[Browser] Unknown page type. Title: "${evidencePageTitle}"`);
            console.log(`[Browser] Body preview: ${evidenceBodyPreview?.substring(0, 200) || 'Empty'}`);
            console.log('[Browser] Waiting for navigation...');
            await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
            break;
        }

        await page.waitForLoadState('networkidle').catch(() => {});
      }

      throw new Error(`Max attempts (${maxAttempts}) reached without completing authorization`);
    } catch (error) {
      if (this.options.screenshotOnError && !screenshotPath) {
        screenshotPath = await this.takeScreenshot(page, 'error');
      }
      throw error;
    } finally {
      await page.close();
    }
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

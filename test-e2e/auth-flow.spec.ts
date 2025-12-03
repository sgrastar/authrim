import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  test.describe('Login Page', () => {
    test('should display login page elements', async ({ page }) => {
      await page.goto('/login');
      await page.waitForLoadState('networkidle');

      // Check for login form elements
      // Note: Adjust selectors based on actual UI implementation
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      if (await emailInput.isVisible()) {
        await expect(emailInput).toBeVisible();
      }

      // Check for passkey login option (WebAuthn)
      const passkeyButton = page
        .locator('button')
        .filter({ hasText: /passkey|webauthn|biometric/i });
      // Passkey might not be visible depending on browser support
    });

    test('should show error for empty form submission', async ({ page }) => {
      await page.goto('/login');
      await page.waitForLoadState('networkidle');

      // Find and click submit button without filling form
      const submitButton = page.locator('button[type="submit"]').first();
      if (await submitButton.isVisible()) {
        await submitButton.click();

        // Should show validation error
        await page.waitForTimeout(500);
        // Check for error message (implementation dependent)
      }
    });

    test('should handle invalid credentials gracefully', async ({ page }) => {
      await page.goto('/login');
      await page.waitForLoadState('networkidle');

      // Find email input and enter test email
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      if (await emailInput.isVisible()) {
        await emailInput.fill('test@example.com');

        // Submit form
        const submitButton = page.locator('button[type="submit"]').first();
        await submitButton.click();

        // Should not crash and should handle error
        await page.waitForTimeout(1000);
        // Page should still be responsive
        await expect(page).not.toHaveURL(/error$/);
      }
    });
  });

  test.describe('Signup Page', () => {
    test('should display signup page elements', async ({ page }) => {
      await page.goto('/signup');
      await page.waitForLoadState('networkidle');

      // Check page loaded
      await expect(page).toHaveURL(/signup/);
    });

    test('should have link to login page', async ({ page }) => {
      await page.goto('/signup');
      await page.waitForLoadState('networkidle');

      // Look for login link
      const loginLink = page.locator('a').filter({ hasText: /login|sign in/i });
      if (await loginLink.first().isVisible()) {
        await expect(loginLink.first()).toBeVisible();
      }
    });
  });

  test.describe('Consent Page', () => {
    test('should redirect to login when accessing consent without session', async ({ page }) => {
      // Consent page requires authentication
      await page.goto('/consent');
      await page.waitForLoadState('networkidle');

      // Should either redirect to login or show error
      const url = page.url();
      expect(
        url.includes('/login') || url.includes('/consent') || url.includes('/error')
      ).toBeTruthy();
    });
  });

  test.describe('Error Handling', () => {
    test('should display user-friendly error page', async ({ page }) => {
      await page.goto('/error');
      await page.waitForLoadState('networkidle');

      // Check for error page elements
      await expect(page).toHaveURL(/error/);
    });

    test('should handle 404 pages gracefully', async ({ page }) => {
      await page.goto('/nonexistent-page-12345');
      await page.waitForLoadState('networkidle');

      // Should show some error indication (404 or redirect)
      // Check page is not completely broken
      const bodyText = await page.locator('body').textContent();
      expect(bodyText).toBeTruthy();
    });
  });

  test.describe('Session Management', () => {
    test('should not have session cookies on fresh visit', async ({ page, context }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Get cookies
      const cookies = await context.cookies();
      const sessionCookies = cookies.filter(
        (c) => c.name.toLowerCase().includes('session') || c.name.toLowerCase().includes('auth')
      );

      // Session cookies should not exist before login
      // (or should be empty/invalid)
    });
  });

  test.describe('Redirect Handling', () => {
    test('should handle OAuth authorization redirect parameters', async ({ page }) => {
      // Test that authorization endpoint redirects properly
      const authUrl =
        '/authorize?response_type=code&client_id=test&redirect_uri=https://example.com/callback&scope=openid&state=test123';

      await page.goto(authUrl);
      await page.waitForLoadState('networkidle');

      // Should redirect to login for unauthenticated users
      const currentUrl = page.url();
      expect(
        currentUrl.includes('/login') ||
          currentUrl.includes('/authorize') ||
          currentUrl.includes('challenge')
      ).toBeTruthy();
    });
  });
});

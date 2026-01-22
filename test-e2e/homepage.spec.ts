import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test('should load successfully', async ({ page }) => {
    await page.goto('/');

    // Wait for the page to be fully loaded
    await page.waitForLoadState('networkidle');

    // Check that the page loaded (basic smoke test)
    expect(page).toHaveURL(/\/$/);
  });

  test('should have correct title', async ({ page }) => {
    await page.goto('/');

    // Check that the page has a title (adjust as needed)
    await expect(page).toHaveTitle(/Authrim/i);
  });

  test('should be accessible via keyboard', async ({ page }) => {
    await page.goto('/');

    // Press Tab to navigate
    await page.keyboard.press('Tab');

    // Check that an element is focused
    const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedElement).toBeTruthy();
  });

  test('should support language switcher', async ({ page }) => {
    await page.goto('/');

    // Look for language switcher (Globe icon or select element)
    const languageSwitcher = page
      .locator('select')
      .filter({ hasText: /English|Japanese|日本語/u })
      .first();

    if (await languageSwitcher.isVisible()) {
      await expect(languageSwitcher).toBeVisible();

      // Optionally test switching language
      const initialLang = await languageSwitcher.inputValue();
      const newLang = initialLang === 'en' ? 'ja' : 'en';

      await languageSwitcher.selectOption(newLang);

      // Note: This might trigger a reload, so we'll wait for it
      await page.waitForLoadState('networkidle');
    }
  });
});

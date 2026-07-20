import { defineConfig, devices } from '@playwright/test';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './test-e2e',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Login UI's local workerd uses shared SQLite state, so browser tests must be serialized. */
  workers: 1,

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
    ['list'],
  ],

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:4173',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Screenshots on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // Uncomment to test on Firefox and WebKit
    // {
    // 	name: 'firefox',
    // 	use: { ...devices['Desktop Firefox'] },
    // },
    // {
    // 	name: 'webkit',
    // 	use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    // 	name: 'Mobile Chrome',
    // 	use: { ...devices['Pixel 5'] },
    // },
    // {
    // 	name: 'Mobile Safari',
    // 	use: { ...devices['iPhone 12'] },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: [
    {
      command: 'pnpm --filter @authrim/ar-login-ui dev --host 127.0.0.1 --port 4173',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    },
    {
      command:
        'AUTHRIM_ADMIN_UI_DEV_MOCK=true pnpm --dir packages/ar-admin-ui exec vite dev --host 127.0.0.1 --port 4175',
      url: 'http://127.0.0.1:4175/admin/join',
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    },
  ],
});

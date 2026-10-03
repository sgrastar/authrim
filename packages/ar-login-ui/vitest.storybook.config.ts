import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

const dirname = fileURLToPath(new URL('.', import.meta.url));

// Renders every story in a real browser and runs its play function plus the a11y addon checks.
// Kept apart from vite.config.ts so `pnpm test` (the unit suite) is unaffected.
// Needs `pnpm exec playwright install chromium` once per machine.
export default mergeConfig(
	viteConfig,
	defineConfig({
		plugins: [storybookTest({ configDir: `${dirname}.storybook` })],
		// Prebundled up front: a dependency found mid-run (the on-demand QR library) reloads the page.
		optimizeDeps: { include: ['qrcode'] },
		test: {
			name: 'storybook',
			browser: {
				enabled: true,
				headless: true,
				provider: playwright(),
				instances: [{ browser: 'chromium' }]
			}
		}
	})
);

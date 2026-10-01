import { sveltekit } from '@sveltejs/kit/vite';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	plugins: [sveltekit()],
	logLevel: process.env.CI ? 'warn' : 'info',
	envPrefix: ['VITE_', 'PUBLIC_'],
	build: {
		target: 'esnext',
		minify: 'esbuild',
		sourcemap: false,
		reportCompressedSize: false
	},
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					environment: 'jsdom',
					include: ['src/**/*.test.ts'],
					setupFiles: ['./vitest-setup.ts']
				}
			},
			{
				// Renders every story in a real browser and runs its play function plus the a11y
				// addon checks. Needs `pnpm exec playwright install chromium` once per machine.
				extends: true,
				plugins: [storybookTest({ configDir: `${dirname}.storybook` })],
				test: {
					name: 'storybook',
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: 'chromium' }]
					}
				}
			}
		]
	}
});

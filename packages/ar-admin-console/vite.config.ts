import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	resolve: {
		alias: process.env.VITEST
			? {
					'cloudflare:workers': fileURLToPath(
						new URL('./src/test/cloudflare-workers-stub.ts', import.meta.url)
					)
				}
			: {}
	},
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			// The console replaces the legacy Admin UI in the same deployment slot. ar-router forwards
			// `/_authrim_admin/*` to the Admin UI Worker when the UI shares the API origin, so the
			// asset directory must stay identical.
			appDir: '_authrim_admin',
			// SvelteKit 3 drops the built-in `$lib`; keep it rather than rewriting every import.
			alias: { $lib: 'src/lib' },
			adapter: adapter({ routes: { include: ['/*'], exclude: ['<all>'] } })
		})
	],
	logLevel: process.env.CI ? 'warn' : 'info',
	envPrefix: ['VITE_', 'PUBLIC_'],
	build: {
		target: 'esnext',
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

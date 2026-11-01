import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocessMeltUI, sequence } from '@melt-ui/pp';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';

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
	// svelteTesting: under Vitest only, component tests mount Svelte's browser build.
	plugins: [
		UnoCSS(),
		sveltekit({
			// Consult https://svelte.dev/docs/kit/integrations
			// for more information about preprocessors
			preprocess: sequence([vitePreprocess(), preprocessMeltUI({ svelteConfigPath: false })]),
			appDir: '_authrim_admin',
			// Cloudflare Workers static-assets adapter configuration
			adapter: adapter({
				// Route all requests through the generated Worker when no static asset matches.
				routes: { include: ['/*'], exclude: ['<all>'] }
			}),
			// SvelteKit 3 drops the built-in `$lib`; keep it rather than rewriting every import.
			alias: { $lib: 'src/lib', $i18n: 'src/i18n' }
		}),
		svelteTesting()
	],

	// GitHub Actions processes each of the Admin UI's hundreds of output lines individually.
	// Keep warnings and errors while avoiding CI log transport becoming the build bottleneck.
	logLevel: process.env.CI ? 'warn' : 'info',
	// Expose both VITE_ and PUBLIC_ prefixed environment variables to import.meta.env
	// This allows SvelteKit apps to use PUBLIC_API_BASE_URL etc.
	envPrefix: ['VITE_', 'PUBLIC_'],
	build: {
		target: 'esnext',
		sourcemap: false,
		// The Admin UI emits a large chunk graph. Computing and printing the gzip size of every
		// output makes hosted CI spend minutes on reporting after the artifacts are already built.
		reportCompressedSize: false,
		chunkSizeWarningLimit: 1000
	}
});

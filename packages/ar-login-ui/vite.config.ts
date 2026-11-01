import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocessMeltUI, sequence } from '@melt-ui/pp';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';

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
		UnoCSS(),
		sveltekit({
			// Consult https://svelte.dev/docs/kit/integrations
			// for more information about preprocessors
			preprocess: sequence([vitePreprocess(), preprocessMeltUI({ svelteConfigPath: false })]),
			appDir: '_authrim_login',
			// Cloudflare Workers static-assets adapter configuration
			adapter: adapter({
				// Keep OAuth/OIDC API endpoints on the core Authrim Workers.
				routes: {
					include: ['/*'],
					exclude: [
						'<all>',
						// OAuth/OIDC endpoints handled by Workers
						// Keep /api/* and /logout on the UI Worker so hooks.server.ts can proxy them.
						'/authorize',
						'/authorize/*',
						'/as/*',
						'/token',
						'/userinfo',
						'/introspect',
						'/revoke',
						'/register',
						'/.well-known/*',
						// Async flow endpoints
						'/device_authorization',
						'/bc-authorize',
						'/api/device/*'
					]
				}
			}),
			// SvelteKit 3 drops the built-in `$lib`; keep it rather than rewriting every import.
			alias: { $lib: 'src/lib', $i18n: 'src/i18n' }
		})
	],

	// Preserve useful warnings and errors in CI without printing the full generated-file inventory.
	logLevel: process.env.CI ? 'warn' : 'info',
	// Expose both VITE_ and PUBLIC_ prefixed environment variables to import.meta.env
	// This allows SvelteKit apps to use PUBLIC_API_BASE_URL etc.
	envPrefix: ['VITE_', 'PUBLIC_'],
	build: {
		target: 'esnext',
		sourcemap: false,
		// Keep CI focused on producing the deployable artifacts; compressed-size reporting does
		// not affect their contents and is disproportionately expensive for the generated chunks.
		reportCompressedSize: false,
		chunkSizeWarningLimit: 1000
	}
});

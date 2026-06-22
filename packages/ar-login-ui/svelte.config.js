import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocessMeltUI, sequence } from '@melt-ui/pp';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: sequence([vitePreprocess(), preprocessMeltUI()]),

	kit: {
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
		alias: {
			$i18n: 'src/i18n'
		}
	}
};

export default config;

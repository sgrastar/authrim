import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocessMeltUI, sequence } from '@melt-ui/pp';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: sequence([vitePreprocess(), preprocessMeltUI()]),

	kit: {
		// Cloudflare Pages adapter configuration
		adapter: adapter({
			// Cloudflare Pages specific options
			routes: {
				include: ['/*'],
				exclude: [
					'<all>',
					// OAuth/OIDC endpoints handled by Workers
					'/authorize',
					'/authorize/*',
					'/as/*',
					'/api/auth/*',
					'/api/sessions/*',
					'/logout',
					'/logout/*',
					'/token',
					'/userinfo',
					'/introspect',
					'/revoke',
					'/register',
					'/.well-known/*',
					// Async flow endpoints
					'/device_authorization',
					'/device',
					'/bc-authorize',
					'/api/device/*',
					'/api/ciba/*',
					'/ciba/*'
				]
			}
		}),
		alias: {
			$i18n: 'src/i18n'
		}
	}
};

export default config;

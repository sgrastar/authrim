import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocessMeltUI, sequence } from '@melt-ui/pp';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: sequence([vitePreprocess(), preprocessMeltUI()]),

	kit: {
		// Cloudflare Workers static-assets adapter configuration
		adapter: adapter({
			// Route all requests through the generated Worker when no static asset matches.
			routes: {
				include: ['/*'],
				exclude: ['<all>']
			}
		}),
		alias: {
			$i18n: 'src/i18n'
		}
	}
};

export default config;

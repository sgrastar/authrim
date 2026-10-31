import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		// The console replaces the legacy Admin UI in the same deployment slot. ar-router forwards
		// `/_authrim_admin/*` to the Admin UI Worker when the UI shares the API origin, so the
		// asset directory must stay identical.
		appDir: '_authrim_admin',
		adapter: adapter({
			routes: {
				include: ['/*'],
				exclude: ['<all>']
			}
		})
	}
};

export default config;

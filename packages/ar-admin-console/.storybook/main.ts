import type { StorybookConfig } from '@storybook/sveltekit';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import remarkGfm from 'remark-gfm';
import type { Plugin } from 'vite';

/** Storybook's own pages; they and files on disk pass, anything else that reaches here is a 404. */
const STORYBOOK_PAGES = new Set(['/', '/index.html', '/iframe.html']);
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;

/**
 * Storybook renders stories in the browser and needs no SvelteKit page; yet a request for no file
 * (the browser's `/favicon.ico`, an unknown path) fell through to SvelteKit, which rendered its
 * error page server-side with the root layout. There Storybook's `$app/state` mock reads a
 * browser-only global and threw, and Vite showed that error over the open story. Such a request
 * now gets a plain 404. Files still pass: SvelteKit serves them (fonts and images under `src/`,
 * the `static/` folder) itself, from its own handler after this one.
 */
const noSvelteKitPages: Plugin = {
	name: 'admin-console-storybook-no-sveltekit-pages',
	configureServer(server) {
		const root = server.config.root;
		// Where the files a story asks for live: under src/ (fonts, images), SvelteKit's static/
		// (served at the root), and node_modules/. Not the package root itself (package.json…).
		const staticDir = join(root, 'static');
		const isFile = (path: string) => {
			const inRoot = resolve(root, `.${path}`);
			const candidates: [string, string][] = [
				[join(root, 'src'), inRoot],
				[join(root, 'node_modules'), inRoot],
				[staticDir, resolve(staticDir, `.${path}`)]
			];
			return candidates.some(
				([dir, file]) => file.startsWith(dir + sep) && existsSync(file) && statSync(file).isFile()
			);
		};
		// Returned, so it runs after Vite's own middleware (modules) and, the plugin being placed
		// first, before SvelteKit's.
		return () => {
			server.middlewares.use((req, res, next) => {
				// As it came, without the query: Storybook matches its pages on this, unnormalised
				// (`/%69frame.html`, `/x/../iframe.html` are no pages of its).
				const raw = (req.url ?? '/').split('?')[0];
				let path = '';
				try {
					// Read as SvelteKit reads it (`%2F` stays encoded), so that what passes here as a
					// file is a file there too.
					path = decodeURI(raw);
				} catch {
					// A malformed address is no file either.
				}
				// An address whose meaning depends on how it is normalised (`//host/…`, `.` or `..`
				// segments, a backslash on Windows) is not taken for a file.
				const plain =
					path.startsWith('/') &&
					!path.startsWith('//') &&
					!path.includes('\\') &&
					!DOT_SEGMENT.test(path);
				if (STORYBOOK_PAGES.has(raw) || (plain && isFile(path))) return next();
				res.statusCode = 404;
				res.end('Not found');
			});
		};
	}
};

const config: StorybookConfig = {
	stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|ts|svelte)'],
	// The icon of Storybook's tab (manager and preview); not part of the console's own build.
	staticDirs: ['./public'],
	addons: [
		'@storybook/addon-svelte-csf',
		{
			// MDX 3 does not parse GitHub-flavoured Markdown (tables, strikethrough) on its own.
			name: '@storybook/addon-docs',
			options: { mdxPluginOptions: { mdxCompileOptions: { remarkPlugins: [remarkGfm] } } }
		},
		'@storybook/addon-a11y',
		'@storybook/addon-vitest'
	],
	framework: {
		name: '@storybook/sveltekit',
		options: {}
	},
	core: {
		disableTelemetry: true
	},
	viteFinal: async (viteConfig) => {
		viteConfig.plugins = [noSvelteKitPages, ...(viteConfig.plugins ?? [])];
		return viteConfig;
	}
};

export default config;

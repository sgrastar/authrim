import type { StorybookConfig } from '@storybook/sveltekit';
import { fileURLToPath } from 'node:url';
import remarkGfm from 'remark-gfm';

const config: StorybookConfig = {
	stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|ts|svelte)'],
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
		// The Login UI stores write to <html>, cookies and localStorage whenever `browser` is true.
		// Stories render several Login UIs side by side, so they run as if server-side: the stores
		// stay reactive, nothing leaks to the document, and each frame carries its own attributes.
		// SvelteKit resolves `$app/env` through its own alias, so intercept the resolved path too.
		// Only the module itself: `$app/env/public` and `$app/env/private` stay real.
		const environment = fileURLToPath(
			new URL('../src/lib/storybook/app-environment.ts', import.meta.url)
		);
		viteConfig.plugins = [
			...(viteConfig.plugins ?? []),
			{
				name: 'login-ui-storybook-environment',
				enforce: 'pre',
				resolveId(id: string) {
					// The alias leaves the module as a directory path (or `#app/env` inside kit); a file
					// suffix is allowed too. `env/public` and `env/private` do not match.
					return id === '$app/env' ||
						id === '#app/env' ||
						/kit[\\/].*runtime[\\/]app[\\/]env(?:[\\/](?:index|client|server)\.js)?$/.test(id)
						? environment
						: null;
				}
			}
		];
		return viteConfig;
	}
};

export default config;

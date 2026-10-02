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
		// SvelteKit resolves `$app/environment` through its own alias, so intercept the resolved path.
		const environment = fileURLToPath(
			new URL('../src/lib/storybook/app-environment.ts', import.meta.url)
		);
		viteConfig.plugins = [
			...(viteConfig.plugins ?? []),
			{
				name: 'login-ui-storybook-environment',
				enforce: 'pre',
				resolveId(id: string) {
					return id === '$app/environment' || /kit[\\/].*runtime[\\/]app[\\/]environment/.test(id)
						? environment
						: null;
				}
			}
		];
		return viteConfig;
	}
};

export default config;

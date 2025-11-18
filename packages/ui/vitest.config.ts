import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';

export default defineConfig({
	plugins: [
		UnoCSS(),
		svelte({
			hot: !process.env.VITEST
		})
	],
	resolve: {
		conditions: ['browser']
	},
	test: {
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./src/test/setup.ts'],
		include: ['src/**/*.{test,spec}.{js,ts}'],
		alias: {
			$lib: '/src/lib'
		},
		coverage: {
			reporter: ['text', 'json', 'html'],
			include: ['src/lib/**/*.{js,ts,svelte}'],
			exclude: [
				'src/lib/paraglide/**',
				'**/*.d.ts',
				'**/*.config.*',
				'**/mockData/**',
				'**/types/**'
			]
		}
	}
});

import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

// Two projects behind one `vitest run`:
// - unit: everything but the DOM tests, as before (Svelte compiled for the server, so
//   `svelte/server` render tests work);
// - dom: `*.dom.test.ts`, which mount the real components in jsdom and press real keys. These need
//   Svelte's browser build, which would break the server render tests, hence the split.
// (The Storybook run has its own config, vitest.storybook.config.ts.)
export default defineConfig({
	test: {
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					exclude: ['**/node_modules/**', '**/dist/**', '**/*.dom.test.ts']
				}
			},
			{
				extends: './vite.config.ts',
				plugins: [svelteTesting()],
				test: {
					name: 'dom',
					environment: 'jsdom',
					include: ['src/**/*.dom.test.ts']
				}
			}
		]
	}
});

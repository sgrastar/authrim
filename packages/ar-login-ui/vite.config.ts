import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';

export default defineConfig({
	plugins: [UnoCSS(), sveltekit()],
	// Expose both VITE_ and PUBLIC_ prefixed environment variables to import.meta.env
	// This allows SvelteKit apps to use PUBLIC_API_BASE_URL etc.
	envPrefix: ['VITE_', 'PUBLIC_'],
	build: {
		target: 'esnext',
		minify: 'esbuild',
		sourcemap: false,
		chunkSizeWarningLimit: 1000,
		rollupOptions: {
			// Reduce parallelism to prevent EPIPE errors in CI
			maxParallelFileOps: 2
		}
	}
});

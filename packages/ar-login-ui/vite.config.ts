import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';

export default defineConfig({
	plugins: [UnoCSS(), sveltekit()],
	// Preserve useful warnings and errors in CI without printing the full generated-file inventory.
	logLevel: process.env.CI ? 'warn' : 'info',
	// Expose both VITE_ and PUBLIC_ prefixed environment variables to import.meta.env
	// This allows SvelteKit apps to use PUBLIC_API_BASE_URL etc.
	envPrefix: ['VITE_', 'PUBLIC_'],
	build: {
		target: 'esnext',
		minify: 'esbuild',
		sourcemap: false,
		// Keep CI focused on producing the deployable artifacts; compressed-size reporting does
		// not affect their contents and is disproportionately expensive for the generated chunks.
		reportCompressedSize: false,
		chunkSizeWarningLimit: 1000,
		rollupOptions: {
			// Reduce parallelism to prevent EPIPE errors in CI
			maxParallelFileOps: 2
		}
	}
});

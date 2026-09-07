import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';

export default defineConfig({
	plugins: [UnoCSS(), sveltekit()],
	// GitHub Actions processes each of the Admin UI's hundreds of output lines individually.
	// Keep warnings and errors while avoiding CI log transport becoming the build bottleneck.
	logLevel: process.env.CI ? 'warn' : 'info',
	// Expose both VITE_ and PUBLIC_ prefixed environment variables to import.meta.env
	// This allows SvelteKit apps to use PUBLIC_API_BASE_URL etc.
	envPrefix: ['VITE_', 'PUBLIC_'],
	build: {
		target: 'esnext',
		minify: 'esbuild',
		sourcemap: false,
		// The Admin UI emits a large chunk graph. Computing and printing the gzip size of every
		// output makes hosted CI spend minutes on reporting after the artifacts are already built.
		reportCompressedSize: false,
		chunkSizeWarningLimit: 1000,
		rollupOptions: {
			// Reduce parallelism to prevent EPIPE errors in CI
			maxParallelFileOps: 2
		}
	}
});

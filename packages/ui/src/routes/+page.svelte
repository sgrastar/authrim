<script lang="ts">
	import TestDialog from '$lib/components/TestDialog.svelte';
</script>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
	<div class="w-full max-w-md">
		<!-- Logo -->
		<div class="text-center mb-8">
			<h1 class="text-4xl font-bold text-primary-600 mb-2">Enrai</h1>
			<p class="text-gray-600 dark:text-gray-400">OpenID Connect Provider on Cloudflare Workers</p>
		</div>

		<!-- Test Card -->
		<div class="card">
			<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Frontend Stack Test</h2>

			<!-- Buttons -->
			<div class="space-y-3 mb-6">
				<button class="btn-primary w-full">Primary Button</button>
				<button class="btn-secondary w-full">Secondary Button</button>
				<button class="btn-ghost w-full">Ghost Button</button>
			</div>

			<!-- Input -->
			<div class="mb-6">
				<label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
					Email address
				</label>
				<input id="email" type="email" class="input-base" placeholder="you@example.com" />
			</div>

			<!-- Badges -->
			<div class="flex gap-2 flex-wrap mb-6">
				<span class="badge-success">Success</span>
				<span class="badge-warning">Warning</span>
				<span class="badge-error">Error</span>
				<span class="badge-info">Info</span>
			</div>

			<!-- Melt UI Dialog Test -->
			<div class="border-t pt-6 border-gray-200 dark:border-gray-700">
				<p class="text-sm text-gray-600 dark:text-gray-400 mb-3">
					Test Melt UI (Headless Components):
				</p>
				<TestDialog />
			</div>
		</div>

		<!-- Info -->
		<p class="mt-4 text-center text-sm text-gray-500">
			SvelteKit v5 + UnoCSS + Melt UI + Cloudflare Pages
		</p>
	</div>
</div>

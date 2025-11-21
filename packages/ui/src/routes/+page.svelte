<script lang="ts">
	import TestDialog from '$lib/components/TestDialog.svelte';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
</script>

<svelte:head>
	<title>Authrim - OpenID Connect Provider</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
	<div class="w-full max-w-md">
		<!-- Language Switcher -->
		<nav aria-label="Language selector" class="flex justify-end mb-4">
			<LanguageSwitcher />
		</nav>

		<main>
			<!-- Logo -->
			<div class="text-center mb-8">
				<h1 class="text-4xl font-bold text-primary-600 mb-2">{$LL.app_title()}</h1>
				<p class="text-gray-600 dark:text-gray-400">{$LL.app_subtitle()}</p>
			</div>

			<!-- Test Card -->
			<div class="card">
				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{$LL.test_title()}</h2>

				<!-- Buttons -->
				<div class="space-y-3 mb-6">
					<button class="btn-primary w-full">{$LL.button_primary()}</button>
					<button class="btn-secondary w-full">{$LL.button_secondary()}</button>
					<button class="btn-ghost w-full">{$LL.button_ghost()}</button>
				</div>

				<!-- Input -->
				<div class="mb-6">
					<label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
						{$LL.form_email()}
					</label>
					<input id="email" type="email" class="input-base" placeholder={$LL.form_emailPlaceholder()} />
				</div>

				<!-- Badges -->
				<div class="flex gap-2 flex-wrap mb-6">
					<span class="badge-success">{$LL.badge_success()}</span>
					<span class="badge-warning">{$LL.badge_warning()}</span>
					<span class="badge-error">{$LL.badge_error()}</span>
					<span class="badge-info">{$LL.badge_info()}</span>
				</div>

				<!-- Melt UI Dialog Test -->
				<div class="border-t pt-6 border-gray-200 dark:border-gray-700">
					<p class="text-sm text-gray-600 dark:text-gray-400 mb-3">
						{$LL.test_meltui()}
					</p>
					<TestDialog />
				</div>
			</div>
		</main>

		<!-- Info -->
		<footer class="mt-4 text-center text-sm text-gray-500">
			<p>{$LL.footer_stack()}</p>
		</footer>
	</div>
</div>

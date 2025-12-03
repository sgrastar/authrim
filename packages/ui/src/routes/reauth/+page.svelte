<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let challengeId = $state('');
	let loading = $state(false);
	let error = $state('');

	onMount(() => {
		// Get challenge_id from URL params
		const urlParams = new URLSearchParams(window.location.search);
		challengeId = urlParams.get('challenge_id') || '';

		if (!challengeId) {
			error = 'Missing challenge ID';
		}
	});
</script>

<svelte:head>
	<title>Re-authentication Required - {$LL.app_title()}</title>
</svelte:head>

<div
	class="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center px-4 py-12"
>
	<!-- Language Switcher (Top Right) -->
	<div class="absolute top-4 right-4">
		<LanguageSwitcher />
	</div>

	<!-- Main Card -->
	<div class="w-full max-w-md">
		<Card>
			<!-- Icon -->
			<div class="text-center mb-6">
				<div
					class="h-16 w-16 mx-auto mb-4 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center"
				>
					<div
						class="i-heroicons-shield-check h-8 w-8 text-primary-600 dark:text-primary-400"
					></div>
				</div>

				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
					Re-authentication Required
				</h2>

				<p class="text-gray-600 dark:text-gray-400 text-sm">
					For security reasons, you need to confirm your authentication.
				</p>
			</div>

			<!-- Error Message -->
			{#if error}
				<div
					class="mb-4 p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg"
				>
					<p class="text-error-600 dark:text-error-400 text-sm">{error}</p>
				</div>
			{/if}

			<!-- Confirmation Form -->
			<form method="POST" action="/authorize/confirm" onsubmit={() => (loading = true)}>
				<input type="hidden" name="challenge_id" value={challengeId} />
				<Button
					type="submit"
					variant="primary"
					class="w-full"
					{loading}
					disabled={!challengeId || !!error}
				>
					Continue
				</Button>
			</form>

			<!-- Info Text -->
			<p class="mt-4 text-center text-xs text-gray-500 dark:text-gray-400">
				This confirmation is required to ensure the security of your account.
			</p>
		</Card>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

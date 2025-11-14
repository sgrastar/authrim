<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Alert, Spinner } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { CheckCircle, XCircle } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	type VerificationState = 'verifying' | 'success' | 'error';

	let state = $state<VerificationState>('verifying');
	let errorMessage = $state('');
	let token = $state('');

	onMount(async () => {
		// Get token from URL parameter
		const urlParams = new URLSearchParams(window.location.search);
		token = urlParams.get('token') || '';

		// If no token, show error
		if (!token) {
			state = 'error';
			errorMessage = m.magicLink_verify_errorInvalid();
			return;
		}

		// Verify token
		await verifyToken(token);
	});

	async function verifyToken(token: string) {
		try {
			// TODO: Implement Magic Link verification
			// 1. Call /auth/magic-link/verify with token
			// 2. Handle response (success or error)
			// 3. On success: redirect to client app or dashboard
			// 4. On error: show error message

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 2000));
			console.log('Verifying token:', token);

			// Mock success for now (change to actual API call)
			// Uncomment one of the following to test different states:

			// Success case:
			// state = 'success';
			// setTimeout(() => {
			// 	window.location.href = '/dashboard'; // or redirect_uri
			// }, 2000);

			// Error case (for testing):
			throw new Error(m.magicLink_verify_errorInvalid());
		} catch (err) {
			state = 'error';
			errorMessage = err instanceof Error ? err.message : m.magicLink_verify_errorInvalid();
		}
	}

	function handleRequestNewLink() {
		window.location.href = '/login';
	}
</script>

<svelte:head>
	<title>{m.magicLink_verify_title()} - {m.app_title()}</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center px-4 py-12">
	<!-- Language Switcher (Top Right) -->
	<div class="absolute top-4 right-4">
		<LanguageSwitcher />
	</div>

	<!-- Main Card -->
	<div class="w-full max-w-md">
		<!-- Logo -->
		<div class="text-center mb-8">
			<h1 class="text-4xl font-bold text-primary-600 dark:text-primary-400 mb-2">
				{m.app_title()}
			</h1>
			<p class="text-gray-600 dark:text-gray-400 text-sm">
				{m.app_subtitle()}
			</p>
		</div>

		<!-- Verification Card -->
		<Card class="text-center">
			{#if state === 'verifying'}
				<!-- Verifying State -->
				<div class="flex justify-center mb-6">
					<Spinner size="xl" color="primary" />
				</div>

				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
					{m.magicLink_verify_title()}
				</h2>

				<p class="text-gray-600 dark:text-gray-400">
					{m.magicLink_verify_subtitle()}
				</p>
			{:else if state === 'success'}
				<!-- Success State -->
				<div class="flex justify-center mb-6">
					<div class="rounded-full bg-success-100 dark:bg-success-900/30 p-4">
						<CheckCircle class="h-12 w-12 text-success-600 dark:text-success-400" />
					</div>
				</div>

				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
					{m.magicLink_verify_success()}
				</h2>

				<p class="text-gray-600 dark:text-gray-400">
					{m.common_loading()}
				</p>
			{:else if state === 'error'}
				<!-- Error State -->
				<div class="flex justify-center mb-6">
					<div class="rounded-full bg-error-100 dark:bg-error-900/30 p-4">
						<XCircle class="h-12 w-12 text-error-600 dark:text-error-400" />
					</div>
				</div>

				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
					{m.error_title()}
				</h2>

				<Alert variant="error" class="mb-6 text-left">
					{errorMessage}
				</Alert>

				<Button
					variant="primary"
					class="w-full"
					onclick={handleRequestNewLink}
				>
					{m.magicLink_verify_requestNew()}
				</Button>
			{/if}
		</Card>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{m.footer_stack()}</p>
	</footer>
</div>

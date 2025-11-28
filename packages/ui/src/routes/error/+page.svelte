<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let errorCode = $state('');
	let errorDescription = $state('');
	let errorMessage = $state('');

	onMount(() => {
		// Get error parameters from URL
		const urlParams = new URLSearchParams(window.location.search);
		errorCode = urlParams.get('error') || 'unknown';
		errorDescription = urlParams.get('error_description') || '';

		// Get user-friendly error message
		errorMessage = getErrorMessage(errorCode);
	});

	function getErrorMessage(code: string): string {
		const errorMessages: Record<string, string> = {
			invalid_request: $LL.error_invalid_request(),
			access_denied: $LL.error_access_denied(),
			unauthorized_client: $LL.error_unauthorized_client(),
			unsupported_response_type: $LL.error_unsupported_response_type(),
			invalid_scope: $LL.error_invalid_scope(),
			server_error: $LL.error_server_error(),
			temporarily_unavailable: $LL.error_temporarily_unavailable(),
			unknown: $LL.error_unknown()
		};

		return errorMessages[code] || errorMessages.unknown;
	}

	function handleBackToLogin() {
		window.location.href = '/login';
	}

	function handleContactSupport() {
		// TODO: Add support email or link
		window.location.href = 'mailto:support@authrim.dev?subject=Error: ' + errorCode;
	}
</script>

<svelte:head>
	<title>{$LL.error_title()} - {$LL.app_title()}</title>
	<meta name="description" content="An error occurred. Please try again or contact support." />
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
				{$LL.app_title()}
			</h1>
			<p class="text-gray-600 dark:text-gray-400 text-sm">
				{$LL.app_subtitle()}
			</p>
		</div>

		<!-- Error Card -->
		<Card class="text-center">
			<!-- Error Icon -->
			<div class="flex justify-center mb-6">
				<div class="rounded-full bg-error-100 dark:bg-error-900/30 p-4">
					<div class="i-heroicons-exclamation-circle h-12 w-12 text-error-600 dark:text-error-400"></div>
				</div>
			</div>

			<!-- Title -->
			<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
				{$LL.error_title()}
			</h2>

			<!-- Subtitle -->
			<p class="text-gray-600 dark:text-gray-400 mb-6">
				{$LL.error_subtitle()}
			</p>

			<!-- Error Message -->
			<Alert variant="error" class="mb-4 text-left">
				<p class="font-medium mb-1">{errorMessage}</p>
				{#if errorDescription}
					<p class="text-sm opacity-90">{errorDescription}</p>
				{/if}
			</Alert>

			<!-- Error Code -->
			<div class="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 mb-6">
				<p class="text-xs text-gray-600 dark:text-gray-400 mb-1">
					{$LL.error_errorCode()}
				</p>
				<p class="text-sm font-mono text-gray-900 dark:text-white">
					{errorCode}
				</p>
			</div>

			<!-- Action Buttons -->
			<div class="space-y-3">
				<Button
					variant="primary"
					class="w-full"
					onclick={handleBackToLogin}
				>
					<div class="i-heroicons-arrow-left h-5 w-5"></div>
					{$LL.common_backToLogin()}
				</Button>

				<Button
					variant="ghost"
					class="w-full"
					onclick={handleContactSupport}
				>
					<div class="i-heroicons-question-mark-circle h-5 w-5"></div>
					Contact Support
				</Button>
			</div>

			<!-- Contact Support Text -->
			<p class="mt-6 text-xs text-gray-600 dark:text-gray-400">
				{$LL.error_contactSupport()}
			</p>
		</Card>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-600 dark:text-gray-400">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

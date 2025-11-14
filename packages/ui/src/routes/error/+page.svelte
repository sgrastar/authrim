<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { AlertCircle, ArrowLeft, HelpCircle } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

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
		const errorMessages: Record<string, () => string> = {
			invalid_request: m.error_invalid_request,
			access_denied: m.error_access_denied,
			unauthorized_client: m.error_unauthorized_client,
			unsupported_response_type: m.error_unsupported_response_type,
			invalid_scope: m.error_invalid_scope,
			server_error: m.error_server_error,
			temporarily_unavailable: m.error_temporarily_unavailable,
			unknown: m.error_unknown
		};

		return errorMessages[code]?.() || errorMessages.unknown();
	}

	function handleBackToLogin() {
		window.location.href = '/login';
	}

	function handleContactSupport() {
		// TODO: Add support email or link
		window.location.href = 'mailto:support@enrai.dev?subject=Error: ' + errorCode;
	}
</script>

<svelte:head>
	<title>{m.error_title()} - {m.app_title()}</title>
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

		<!-- Error Card -->
		<Card class="text-center">
			<!-- Error Icon -->
			<div class="flex justify-center mb-6">
				<div class="rounded-full bg-error-100 dark:bg-error-900/30 p-4">
					<AlertCircle class="h-12 w-12 text-error-600 dark:text-error-400" />
				</div>
			</div>

			<!-- Title -->
			<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
				{m.error_title()}
			</h2>

			<!-- Subtitle -->
			<p class="text-gray-600 dark:text-gray-400 mb-6">
				{m.error_subtitle()}
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
				<p class="text-xs text-gray-500 dark:text-gray-400 mb-1">
					{m.error_errorCode()}
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
					<ArrowLeft class="h-5 w-5" />
					{m.common_backToLogin()}
				</Button>

				<Button
					variant="ghost"
					class="w-full"
					onclick={handleContactSupport}
				>
					<HelpCircle class="h-5 w-5" />
					Contact Support
				</Button>
			</div>

			<!-- Contact Support Text -->
			<p class="mt-6 text-xs text-gray-500 dark:text-gray-400">
				{m.error_contactSupport()}
			</p>
		</Card>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{m.footer_stack()}</p>
	</footer>
</div>

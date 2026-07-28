<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import FooterText from '$lib/components/FooterText.svelte';
	import LocalizedTagline from '$lib/components/LocalizedTagline.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	const { brandingStore } = useLoginUIStores();

	let errorCode = $state('');
	let errorMessage = $derived(getErrorMessage(errorCode));

	onMount(() => {
		// Get error parameters from URL
		const urlParams = new URLSearchParams(window.location.search);
		errorCode = urlParams.get('error') || 'unknown';
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
		window.location.href =
			'mailto:support@authrim.dev?subject=Error: ' + encodeURIComponent(errorCode);
	}
</script>

<svelte:head>
	<title>{$LL.error_title()} - {brandingStore.brandName || $LL.app_title()}</title>
	<meta name="description" content={$LL.error_subtitle()} />
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<div class="auth-container">
		<!-- Header -->
		<div class="auth-header">
			<h1 class="auth-header__title">
				{brandingStore.brandName || $LL.app_title()}
			</h1>
			<p class="auth-header__subtitle">
				<LocalizedTagline />
			</p>
		</div>

		<!-- Error Card -->
		<Card class="text-center">
			<!-- Error Icon -->
			<div class="auth-icon-badge">
				<div class="auth-icon-badge__circle auth-icon-badge__circle--danger">
					<div class="i-heroicons-exclamation-circle h-9 w-9 auth-icon-badge__icon"></div>
				</div>
			</div>

			<!-- Title -->
			<h2 class="auth-section-title text-center">
				{$LL.error_title()}
			</h2>

			<!-- Subtitle -->
			<p class="auth-section-subtitle text-center mb-6">
				{$LL.error_subtitle()}
			</p>

			<!-- Error Message -->
			<Alert variant="error" class="mb-4 text-left">
				<p class="font-medium mb-1">{errorMessage}</p>
			</Alert>

			<!-- Error Code -->
			<div class="auth-error-code-box mb-6">
				<p class="auth-error-code-box__label">
					{$LL.error_errorCode()}
				</p>
				<p class="auth-error-code-box__value">
					{errorCode}
				</p>
			</div>

			<!-- Action Buttons -->
			<div class="space-y-3">
				<Button variant="primary" class="w-full" onclick={handleBackToLogin}>
					<div class="i-heroicons-arrow-left h-5 w-5"></div>
					{$LL.common_backToLogin()}
				</Button>

				<Button variant="ghost" class="w-full" onclick={handleContactSupport}>
					<div class="i-heroicons-question-mark-circle h-5 w-5"></div>
					{$LL.common_contactSupport()}
				</Button>
			</div>

			<!-- Contact Support Text -->
			<p class="mt-6 text-xs" style="color: var(--text-muted);">
				{$LL.error_contactSupport()}
			</p>
		</Card>
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<FooterText value={$LL.footer_stack()} />
	</footer>
</div>

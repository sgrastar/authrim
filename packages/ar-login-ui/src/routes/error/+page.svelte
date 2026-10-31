<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Alert } from '$lib/components';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { errorPageMessage } from '$lib/errors/error-page-message';

	const { brandingStore } = useLoginUIStores();

	let errorCode = $state('');
	let errorMessage = $derived(errorPageMessage($LL, errorCode));

	onMount(() => {
		// Get error parameters from URL
		const urlParams = new URLSearchParams(window.location.search);
		errorCode = urlParams.get('error') || 'unknown';
	});

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

<AuthPageShell>
	<!-- Error Card -->
	<Card class="text-center">
		<!-- Error Icon -->
		<div class="auth-icon-badge">
			<div class="auth-icon-badge__circle auth-icon-badge__circle--danger">
				<div class="i-ph-warning-circle h-9 w-9 auth-icon-badge__icon"></div>
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
				<div class="i-ph-arrow-left h-5 w-5"></div>
				{$LL.common_backToLogin()}
			</Button>

			<Button variant="ghost" class="w-full" onclick={handleContactSupport}>
				<div class="i-ph-question h-5 w-5"></div>
				{$LL.common_contactSupport()}
			</Button>
		</div>

		<!-- Contact Support Text -->
		<p class="mt-6 text-xs" style="color: var(--text-muted);">
			{$LL.error_contactSupport()}
		</p>
	</Card>
</AuthPageShell>

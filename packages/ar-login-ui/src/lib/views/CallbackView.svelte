<script lang="ts">
	/**
	 * The sign-in callback page, as the person sees it: finishing the sign-in, done, or what went
	 * wrong. The route owns the handoff and provisioning; this view only draws the status it is given.
	 */
	import { Alert, Button, Card } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	type Props = {
		status: 'processing' | 'success' | 'error';
		errorCode?: string;
		errorMessage?: string;
		onRetry: () => void;
	};

	let { status, errorCode = '', errorMessage = '', onRetry }: Props = $props();
</script>

<Card class="text-center">
	{#if status === 'processing'}
		<div class="py-8" role="status">
			<span class="auth-initial-loading__spinner auth-callback__spinner" aria-hidden="true"></span>
			<h2 class="auth-section-title text-center">
				{$LL.callback_processing()}
			</h2>
			<p class="auth-section-subtitle text-center">
				{$LL.callback_pleaseWait()}
			</p>
		</div>
	{:else if status === 'success'}
		<div class="py-8" role="status">
			<div class="auth-icon-badge">
				<div class="auth-icon-badge__circle">
					<span class="i-ph-check-circle h-9 w-9 auth-icon-badge__icon"></span>
				</div>
			</div>
			<h2 class="auth-section-title text-center">
				{$LL.callback_success()}
			</h2>
			<p class="auth-section-subtitle text-center">
				{$LL.callback_redirecting()}
			</p>
		</div>
	{:else}
		<div class="auth-icon-badge">
			<div class="auth-icon-badge__circle auth-icon-badge__circle--danger">
				<span class="i-ph-warning-circle h-9 w-9 auth-icon-badge__icon"></span>
			</div>
		</div>

		<h2 class="auth-section-title text-center">
			{$LL.callback_errorTitle()}
		</h2>

		<Alert variant="error" class="mb-4 text-left">
			<p>{errorMessage}</p>
		</Alert>

		{#if errorCode}
			<div class="auth-error-code-box mb-6">
				<p class="auth-error-code-box__label">
					{$LL.error_errorCode()}
				</p>
				<p class="auth-error-code-box__value">
					{errorCode}
				</p>
			</div>
		{/if}

		<Button variant="primary" class="w-full" onclick={onRetry}>
			{$LL.common_backToLogin()}
		</Button>
	{/if}
</Card>

<script lang="ts">
	/**
	 * The email-code page, as the person sees it: one accepted status whatever account the address
	 * belongs to, the code to type, and resend. The route owns the requests and the countdown; this
	 * view only draws what it is given and reports what the person does.
	 */
	import { Alert, Button, Card } from '$lib/components';
	import PinCodeInput from '$lib/components/PinCodeInput.svelte';
	import { LL } from '$i18n/i18n-svelte';

	type Props = {
		email: string;
		code: string;
		/** Seconds until a code can be sent again. */
		countdown: number;
		canResend: boolean;
		loading?: boolean;
		resendLoading?: boolean;
		error?: string;
		success?: string;
		resendNotice?: string;
		onCodeChange: (code: string) => void;
		onVerify: () => void;
		onResend: () => void;
		onDismissError: () => void;
		onDismissSuccess: () => void;
		onDismissResendNotice: () => void;
	};

	let {
		email,
		code,
		countdown,
		canResend,
		loading = false,
		resendLoading = false,
		error = '',
		success = '',
		resendNotice = '',
		onCodeChange,
		onVerify,
		onResend,
		onDismissError,
		onDismissSuccess,
		onDismissResendNotice
	}: Props = $props();

	const busy = $derived(loading || resendLoading || !!success);
</script>

<Card class="mb-6">
	<div class="auth-icon-badge">
		<div class="auth-icon-badge__circle">
			<div class="i-heroicons-envelope-solid h-9 w-9 auth-icon-badge__icon"></div>
		</div>
	</div>

	<h2 class="auth-section-title text-center">
		{$LL.emailCode_title()}
	</h2>

	<!-- The same accepted status is shown regardless of account existence. -->
	<div class="auth-progress mb-6" role="status" aria-live="polite">
		<span class="i-heroicons-check-circle h-5 w-5" aria-hidden="true"></span>
		<div class="min-w-0">
			<p class="auth-email-code__lead">{$LL.emailCode_subtitle()}</p>
			<p class="auth-email-code__address">{email}</p>
		</div>
	</div>

	<div class="auth-binding-message mb-6">
		<p class="auth-email-code__instructions">{$LL.emailCode_instructions()}</p>
	</div>

	{#if success}
		<Alert variant="success" dismissible={true} onDismiss={onDismissSuccess} class="mb-4">
			{success}
		</Alert>
	{/if}

	{#if resendNotice}
		<Alert variant="success" dismissible={true} onDismiss={onDismissResendNotice} class="mb-4">
			{resendNotice}
		</Alert>
	{/if}

	{#if error}
		<Alert variant="error" dismissible={true} onDismiss={onDismissError} class="mb-4">
			{error}
		</Alert>
	{/if}

	<div class="mb-6">
		<div class="auth-email-code__label">{$LL.emailCode_codeLabel()}</div>
		<PinCodeInput
			value={code}
			length={6}
			disabled={busy}
			label={$LL.emailCode_codeLabel()}
			digitLabel={(position) => $LL.emailCode_digitLabel({ position })}
			onValueChange={onCodeChange}
		/>
	</div>

	<Button
		variant="primary"
		class="w-full mb-4"
		disabled={code.length !== 6 || busy}
		{loading}
		onclick={onVerify}
	>
		{$LL.emailCode_verifyButton()}
	</Button>

	<Button
		variant="secondary"
		class="w-full"
		disabled={!canResend || resendLoading || !!success}
		loading={resendLoading}
		onclick={onResend}
	>
		{#if canResend || resendLoading}
			{$LL.emailCode_resendButton()}
		{:else}
			{$LL.emailCode_resendTimer({ seconds: countdown })}
		{/if}
	</Button>
</Card>

<p class="auth-bottom-link">
	<a href="/login" class="inline-flex items-center gap-2" data-sveltekit-reload>
		<span class="i-heroicons-arrow-left h-4 w-4"></span>
		{$LL.common_backToLogin()}
	</a>
</p>

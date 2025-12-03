<script lang="ts">
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { emailCodeAPI } from '$lib/api/client';
	import { createPinInput, melt } from '@melt-ui/svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	let email = $state('');
	let error = $state('');
	let success = $state('');
	let loading = $state(false);
	let resendLoading = $state(false);
	let countdown = $state(60);
	let canResend = $state(false);
	let intervalId: number | null = null;

	// Melt UI Pin Input - 6 digits
	const {
		elements: { root, input, hiddenInput },
		states: { value }
	} = createPinInput({
		placeholder: '0',
		type: 'text',
		defaultValue: []
	});

	// Watch for PIN input value changes and auto-submit when complete
	$effect(() => {
		const code = $value.join('');
		if (code.length === 6 && !loading && !success) {
			handleVerify(code);
		}
	});

	onMount(() => {
		// Get email from URL parameter
		email = $page.url.searchParams.get('email') || '';

		// If no email, redirect to login
		if (!email) {
			window.location.href = '/login';
			return;
		}

		// Start countdown timer
		startCountdown();

		return () => {
			if (intervalId !== null) {
				clearInterval(intervalId);
			}
		};
	});

	function startCountdown() {
		countdown = 60;
		canResend = false;

		if (intervalId !== null) {
			clearInterval(intervalId);
		}

		intervalId = window.setInterval(() => {
			countdown -= 1;

			if (countdown <= 0) {
				if (intervalId !== null) {
					clearInterval(intervalId);
					intervalId = null;
				}
				canResend = true;
			}
		}, 1000);
	}

	async function handleVerify(code?: string) {
		const verifyCode = code || $value.join('');

		// Validate code is 6 digits
		if (!/^\d{6}$/.test(verifyCode)) {
			error = $LL.emailCode_errorInvalid();
			return;
		}

		error = '';
		loading = true;

		try {
			const { data, error: apiError } = await emailCodeAPI.verify({
				code: verifyCode,
				email
			});

			if (apiError) {
				if (apiError.error === 'session_mismatch') {
					error = $LL.emailCode_errorSessionMismatch();
				} else {
					error = apiError.error_description || $LL.emailCode_errorInvalid();
				}
				// Clear the input on error
				value.set([]);
				return;
			}

			// Success
			success = $LL.emailCode_success();

			// Store session and redirect
			if (data?.sessionId) {
				localStorage.setItem('sessionId', data.sessionId);
				localStorage.setItem('userId', data.userId);
			}

			// Redirect to home after delay
			setTimeout(() => {
				window.location.href = '/';
			}, 2000);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.emailCode_errorInvalid();
			value.set([]);
		} finally {
			loading = false;
		}
	}

	async function handleResend() {
		resendLoading = true;
		error = '';

		try {
			const { error: apiError } = await emailCodeAPI.send({ email });

			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to resend code');
			}

			// Clear the input
			value.set([]);

			// Show success message
			success = $LL.emailCode_resendSuccess();

			// Restart countdown timer
			startCountdown();

			// Clear success message after delay
			setTimeout(() => {
				if (success === $LL.emailCode_resendSuccess()) {
					success = '';
				}
			}, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to resend code';
		} finally {
			resendLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.emailCode_title()} - {$LL.app_title()}</title>
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
		<!-- Logo -->
		<div class="text-center mb-8">
			<h1 class="text-4xl font-bold text-primary-600 dark:text-primary-400 mb-2">
				{$LL.app_title()}
			</h1>
			<p class="text-gray-600 dark:text-gray-400 text-sm">
				{$LL.app_subtitle()}
			</p>
		</div>

		<!-- Verification Card -->
		<Card class="mb-6">
			<!-- Icon -->
			<div class="flex justify-center mb-6">
				<div class="rounded-full bg-primary-100 dark:bg-primary-900/30 p-4">
					<div
						class="i-heroicons-envelope-solid h-12 w-12 text-primary-600 dark:text-primary-400"
					></div>
				</div>
			</div>

			<!-- Title -->
			<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2 text-center">
				{$LL.emailCode_title()}
			</h2>

			<!-- Email -->
			<div class="mb-6 text-center">
				<p class="text-gray-600 dark:text-gray-400 mb-2">
					{$LL.emailCode_subtitle()}
				</p>
				<p class="text-lg font-medium text-gray-900 dark:text-white break-all">
					{email}
				</p>
			</div>

			<!-- Instructions -->
			<div
				class="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4 mb-6"
			>
				<p class="text-sm text-info-800 dark:text-info-200">
					{$LL.emailCode_instructions()}
				</p>
			</div>

			<!-- Success Message -->
			{#if success}
				<Alert variant="success" dismissible={true} onDismiss={() => (success = '')} class="mb-4">
					{success}
				</Alert>
			{/if}

			<!-- Error Message -->
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={() => (error = '')} class="mb-4">
					{error}
				</Alert>
			{/if}

			<!-- Pin Input -->
			<div class="mb-6">
				<div class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 text-center">
					{$LL.emailCode_codeLabel()}
				</div>

				<div use:melt={$root} class="flex gap-2 items-center justify-center">
					{#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
						<input
							use:melt={$input()}
							autocomplete="one-time-code"
							inputmode="numeric"
							pattern="[0-9]*"
							class="w-12 h-14 text-center text-xl font-bold border-2 border-gray-300 dark:border-gray-600 rounded-lg
							       focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20
							       bg-white dark:bg-gray-800 text-gray-900 dark:text-white
							       transition-all disabled:opacity-50"
							maxlength="1"
							disabled={loading || !!success}
						/>
					{/each}
				</div>

				<input use:melt={$hiddenInput} />
			</div>

			<!-- Verify Button -->
			<Button
				variant="primary"
				class="w-full mb-4"
				disabled={$value.join('').length !== 6 || loading || !!success}
				{loading}
				onclick={() => handleVerify()}
			>
				{$LL.emailCode_verifyButton()}
			</Button>

			<!-- Resend Button -->
			<Button
				variant="secondary"
				class="w-full"
				disabled={!canResend || resendLoading || !!success}
				loading={resendLoading}
				onclick={handleResend}
			>
				{#if canResend || resendLoading}
					{$LL.emailCode_resendButton()}
				{:else}
					{$LL.emailCode_resendTimer({ seconds: countdown })}
				{/if}
			</Button>
		</Card>

		<!-- Back to Login Link -->
		<div class="text-center">
			<a
				href="/login"
				class="inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
			>
				<div class="i-heroicons-arrow-left h-4 w-4"></div>
				{$LL.common_backToLogin()}
			</a>
		</div>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

<style>
	/* Additional styling for pin input cells */
	:global(.pin-input-cell:focus) {
		@apply ring-2 ring-primary-500 border-primary-500;
	}
</style>

<script lang="ts">
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { emailCodeAPI } from '$lib/api/client';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { auth } from '$lib/stores/auth';
	import { createPinInput, melt } from '@melt-ui/svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	let email = $state('');
	let inviteToken = $state('');
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
		// Get email and invite_token from URL parameters
		email = $page.url.searchParams.get('email') || '';
		inviteToken = $page.url.searchParams.get('invite_token') || '';

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
		// Prevent concurrent submissions (race condition: auto-verify + button click)
		if (loading) return;

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
				// Use generic error message for all failures to avoid
				// leaking session state information (e.g., session_mismatch)
				error = $LL.emailCode_errorInvalid();
				// Clear the input on error
				value.set([]);
				return;
			}

			// Success
			success = $LL.emailCode_success();

			// Store session and update auth store
			if (data?.sessionId) {
				auth.login(data.sessionId, {
					userId: data.userId,
					email: data.user?.email || email,
					name: data.user?.name || undefined
				});
			}

			// Apply invitation if present
			if (inviteToken && data?.userId) {
				try {
					await fetch('/api/v1/invitations/use', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ token: inviteToken, user_id: data.userId })
					});
				} catch {
					// Non-fatal: proceed regardless
				}
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
	<title>{$LL.emailCode_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<!-- Main Card -->
	<div class="auth-container">
		<!-- Header -->
		<div class="auth-header">
			<h1 class="auth-header__title">
				{brandingStore.brandName || $LL.app_title()}
			</h1>
			<p class="auth-header__subtitle">
				{$LL.app_subtitle()}
			</p>
		</div>

		<!-- Verification Card -->
		<Card class="mb-6">
			<!-- Icon -->
			<div class="auth-icon-badge">
				<div class="auth-icon-badge__circle">
					<div class="i-heroicons-envelope-solid h-9 w-9 auth-icon-badge__icon"></div>
				</div>
			</div>

			<!-- Title -->
			<h2 class="auth-section-title text-center">
				{$LL.emailCode_title()}
			</h2>

			<!-- Email -->
			<div class="mb-6 text-center">
				<p style="color: var(--text-secondary); margin-bottom: 8px;">
					{$LL.emailCode_subtitle()}
				</p>
				<p class="text-lg font-medium break-all" style="color: var(--text-primary);">
					{email}
				</p>
			</div>

			<!-- Instructions -->
			<div class="auth-binding-message mb-6">
				<p class="text-sm" style="color: var(--text-secondary);">
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
				<div
					class="block text-sm font-medium mb-2 text-center"
					style="color: var(--text-secondary);"
				>
					{$LL.emailCode_codeLabel()}
				</div>

				<div use:melt={$root} class="flex gap-2 items-center justify-center">
					{#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
						<input
							use:melt={$input()}
							aria-label={$LL.emailCode_digitLabel({ position: i + 1 })}
							autocomplete="one-time-code"
							inputmode="numeric"
							pattern="[0-9]*"
							class="auth-pin-cell"
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
		<p class="auth-bottom-link">
			<a href="/login" class="inline-flex items-center gap-2">
				<span class="i-heroicons-arrow-left h-4 w-4"></span>
				{$LL.common_backToLogin()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

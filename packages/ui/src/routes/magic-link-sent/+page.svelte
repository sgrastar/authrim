<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { MailCheck, ArrowLeft } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let email = $state('');
	let countdown = $state(60);
	let canResend = $state(false);
	let resendLoading = $state(false);
	let successMessage = $state('');
	let error = $state('');
	let intervalId: number | null = null;

	onMount(() => {
		// Get email from URL parameter
		const urlParams = new URLSearchParams(window.location.search);
		email = urlParams.get('email') || '';

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

	async function handleResend() {
		resendLoading = true;
		error = '';
		successMessage = '';

		try {
			// TODO: Implement resend Magic Link
			// 1. Call /auth/magic-link/send with email
			// 2. Show success message
			// 3. Restart countdown

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));
			console.log('Resending magic link to:', email);

			successMessage = m.magicLink_sent_resendSuccess();
			startCountdown();
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred while resending magic link';
		} finally {
			resendLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{m.magicLink_sent_title()} - {m.app_title()}</title>
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

		<!-- Magic Link Sent Card -->
		<Card class="mb-6">
			<!-- Icon -->
			<div class="flex justify-center mb-6">
				<div class="rounded-full bg-success-100 dark:bg-success-900/30 p-4">
					<MailCheck class="h-12 w-12 text-success-600 dark:text-success-400" />
				</div>
			</div>

			<!-- Title -->
			<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2 text-center">
				{m.magicLink_sent_title()}
			</h2>

			<!-- Email -->
			<div class="mb-6 text-center">
				<p class="text-gray-600 dark:text-gray-400 mb-2">
					{m.magicLink_sent_subtitle()}
				</p>
				<p class="text-lg font-medium text-gray-900 dark:text-white break-all">
					{email}
				</p>
			</div>

			<!-- Instructions -->
			<div class="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4 mb-6">
				<p class="text-sm text-info-800 dark:text-info-200">
					{m.magicLink_sent_instructions()}
				</p>
			</div>

			<!-- Success Message -->
			{#if successMessage}
				<Alert variant="success" dismissible={true} onDismiss={() => successMessage = ''} class="mb-4">
					{successMessage}
				</Alert>
			{/if}

			<!-- Error Message -->
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={() => error = ''} class="mb-4">
					{error}
				</Alert>
			{/if}

			<!-- Resend Button -->
			<Button
				variant="secondary"
				class="w-full"
				disabled={!canResend || resendLoading}
				loading={resendLoading}
				onclick={handleResend}
			>
				{#if canResend || resendLoading}
					{m.magicLink_sent_resendButton()}
				{:else}
					{m.magicLink_sent_resendTimer({ seconds: countdown })}
				{/if}
			</Button>
		</Card>

		<!-- Back to Login Link -->
		<p class="text-center">
			<!-- svelte-ignore svelte/no-navigation-without-resolve -->
			<a
				href="/login"
				class="inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
			>
				<ArrowLeft class="h-4 w-4" />
				{m.common_backToLogin()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{m.footer_stack()}</p>
	</footer>
</div>

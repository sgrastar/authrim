<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { Mail, Key } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let email = $state('');
	let error = $state('');
	let passkeyLoading = $state(false);
	let magicLinkLoading = $state(false);

	// Email validation
	function validateEmail(email: string): boolean {
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		return emailRegex.test(email);
	}

	// Check if WebAuthn is supported
	const isPasskeySupported = $derived(
		typeof window !== 'undefined' &&
		window.PublicKeyCredential !== undefined &&
		typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	);

	async function handlePasskeyLogin() {
		// Clear previous errors
		error = '';

		// Validate email
		if (!email.trim()) {
			error = m.login_errorEmailRequired();
			return;
		}

		if (!validateEmail(email)) {
			error = m.login_errorEmailInvalid();
			return;
		}

		passkeyLoading = true;

		try {
			// TODO: Implement Passkey authentication
			// 1. Call /auth/passkey/login/options with email
			// 2. Get challenge from server
			// 3. Call navigator.credentials.get()
			// 4. Send assertion to /auth/passkey/login/verify
			// 5. Redirect to client app or dashboard

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));
			console.log('Passkey login for:', email);

			// TODO: Remove this mock error
			throw new Error('Passkey authentication not yet implemented');
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred during passkey authentication';
		} finally {
			passkeyLoading = false;
		}
	}

	async function handleMagicLinkSend() {
		// Clear previous errors
		error = '';

		// Validate email
		if (!email.trim()) {
			error = m.login_errorEmailRequired();
			return;
		}

		if (!validateEmail(email)) {
			error = m.login_errorEmailInvalid();
			return;
		}

		magicLinkLoading = true;

		try {
			// TODO: Implement Magic Link send
			// 1. Call /auth/magic-link/send with email
			// 2. Redirect to /magic-link-sent page with email parameter

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));
			console.log('Magic link sent to:', email);

			// Redirect to magic link sent page
			window.location.href = `/magic-link-sent?email=${encodeURIComponent(email)}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred while sending magic link';
		} finally {
			magicLinkLoading = false;
		}
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			// Default to Magic Link on Enter key
			handleMagicLinkSend();
		}
	}
</script>

<svelte:head>
	<title>{m.login_title()} - {m.app_title()}</title>
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

		<!-- Login Card -->
		<Card class="mb-6">
			<div class="mb-6">
				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
					{m.login_title()}
				</h2>
				<p class="text-gray-600 dark:text-gray-400 text-sm">
					{m.login_subtitle()}
				</p>
			</div>

			<!-- Error Alert -->
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={() => error = ''} class="mb-4">
					{error}
				</Alert>
			{/if}

			<!-- Email Input -->
			<div class="mb-6">
				<Input
					label={m.common_email()}
					type="email"
					placeholder={m.common_emailPlaceholder()}
					bind:value={email}
					onkeypress={handleKeyPress}
					autocomplete="email"
					required
				>
					{#snippet icon()}
						<Mail class="h-5 w-5 text-gray-400" />
					{/snippet}
				</Input>
			</div>

			<!-- Passkey Button -->
			{#if isPasskeySupported}
				<Button
					variant="primary"
					class="w-full mb-3"
					loading={passkeyLoading}
					disabled={magicLinkLoading}
					onclick={handlePasskeyLogin}
				>
					<Key class="h-5 w-5" />
					{m.login_continueWithPasskey()}
				</Button>

				<!-- Divider -->
				<div class="flex items-center my-4">
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
					<span class="px-4 text-sm text-gray-500 dark:text-gray-400">{m.common_or()}</span>
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
				</div>
			{/if}

			<!-- Magic Link Button -->
			<Button
				variant="secondary"
				class="w-full"
				loading={magicLinkLoading}
				disabled={passkeyLoading}
				onclick={handleMagicLinkSend}
			>
				<Mail class="h-5 w-5" />
				{m.login_sendMagicLink()}
			</Button>
		</Card>

		<!-- Create Account Link -->
		<p class="text-center text-sm text-gray-600 dark:text-gray-400">
			<!-- svelte-ignore svelte/no-navigation-without-resolve -->
			<a
				href="/register"
				class="font-medium text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
			>
				{m.login_createAccount()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{m.footer_stack()}</p>
	</footer>
</div>

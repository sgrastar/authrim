<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { Mail, Key, User } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let email = $state('');
	let name = $state('');
	let error = $state('');
	let passkeyLoading = $state(false);
	let magicLinkLoading = $state(false);
	let emailError = $state('');
	let nameError = $state('');

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

	async function handlePasskeyRegister() {
		// Clear previous errors
		error = '';
		emailError = '';
		nameError = '';

		// Validate email
		if (!email.trim()) {
			emailError = m.login_errorEmailRequired();
			return;
		}

		if (!validateEmail(email)) {
			emailError = m.login_errorEmailInvalid();
			return;
		}

		// Validate name
		if (!name.trim()) {
			nameError = m.register_errorNameRequired();
			return;
		}

		passkeyLoading = true;

		try {
			// TODO: Implement Passkey registration
			// 1. Call /auth/passkey/register/options with email and name
			// 2. Get challenge from server
			// 3. Call navigator.credentials.create()
			// 4. Send attestation to /auth/passkey/register/verify
			// 5. Redirect to client app or dashboard

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));
			console.log('Passkey registration for:', { email, name });

			// TODO: Remove this mock error
			throw new Error('Passkey registration not yet implemented');
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred during passkey registration';
		} finally {
			passkeyLoading = false;
		}
	}

	async function handleMagicLinkSignup() {
		// Clear previous errors
		error = '';
		emailError = '';
		nameError = '';

		// Validate email
		if (!email.trim()) {
			emailError = m.login_errorEmailRequired();
			return;
		}

		if (!validateEmail(email)) {
			emailError = m.login_errorEmailInvalid();
			return;
		}

		// Validate name (optional for magic link, but recommended)
		if (!name.trim()) {
			nameError = m.register_errorNameRequired();
			return;
		}

		magicLinkLoading = true;

		try {
			// TODO: Implement Magic Link registration
			// 1. Call /auth/magic-link/send with email and name
			// 2. Redirect to /magic-link-sent page with email parameter

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));
			console.log('Magic link registration for:', { email, name });

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
			handleMagicLinkSignup();
		}
	}
</script>

<svelte:head>
	<title>{m.register_title()} - {m.app_title()}</title>
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

		<!-- Registration Card -->
		<Card class="mb-6">
			<div class="mb-6">
				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
					{m.register_title()}
				</h2>
				<p class="text-gray-600 dark:text-gray-400 text-sm">
					{m.register_subtitle()}
				</p>
			</div>

			<!-- Error Alert -->
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={() => error = ''} class="mb-4">
					{error}
				</Alert>
			{/if}

			<!-- Name Input -->
			<div class="mb-4">
				<Input
					label={m.common_name()}
					type="text"
					placeholder={m.common_namePlaceholder()}
					bind:value={name}
					error={nameError}
					autocomplete="name"
					required
				>
					{#snippet icon()}
						<User class="h-5 w-5 text-gray-400" />
					{/snippet}
				</Input>
			</div>

			<!-- Email Input -->
			<div class="mb-6">
				<Input
					label={m.common_email()}
					type="email"
					placeholder={m.common_emailPlaceholder()}
					bind:value={email}
					error={emailError}
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
					onclick={handlePasskeyRegister}
				>
					<Key class="h-5 w-5" />
					{m.register_createWithPasskey()}
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
				onclick={handleMagicLinkSignup}
			>
				<Mail class="h-5 w-5" />
				{m.register_signupWithMagicLink()}
			</Button>

			<!-- Terms Agreement -->
			<p class="mt-4 text-xs text-gray-500 dark:text-gray-400 text-center">
				{m.register_termsAgreement()}
			</p>
		</Card>

		<!-- Sign In Link -->
		<p class="text-center text-sm text-gray-600 dark:text-gray-400">
			<!-- svelte-ignore svelte/no-navigation-without-resolve -->
			<a
				href="/login"
				class="font-medium text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
			>
				{m.register_alreadyHaveAccount()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{m.footer_stack()}</p>
	</footer>
</div>

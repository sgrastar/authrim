<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { Mail, Key, User } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import { passkeyAPI, magicLinkAPI } from '$lib/api/client';
	import { startRegistration } from '@simplewebauthn/browser';
	import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/types';

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
			// 1. Get registration options from server
			const { data: optionsData, error: optionsError } = await passkeyAPI.getRegisterOptions({
				email,
				name
			});

			console.log('API Response:', { optionsData, optionsError });

			if (optionsError) {
				throw new Error(optionsError.error_description || 'Failed to get registration options');
			}

			if (!optionsData || !optionsData.options) {
				throw new Error('Invalid response from server: missing options');
			}

			console.log('Registration options:', optionsData.options);

			// 2. Call WebAuthn API using @simplewebauthn/browser
			// This handles all the base64url to Uint8Array conversions automatically
			let credential;
			try {
				console.log('Calling startRegistration with:', optionsData.options);
				credential = await startRegistration({ optionsJSON: optionsData.options });
				console.log('Registration credential:', credential);
			} catch (webauthnError) {
				console.error('WebAuthn error:', webauthnError);
				throw new Error(`WebAuthn failed: ${webauthnError instanceof Error ? webauthnError.message : 'Unknown error'}`);
			}

			// 3. Send credential to server for verification
			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyRegistration({
				userId: optionsData!.userId,
				credential,
				deviceName: navigator.userAgent.includes('Mobile') ? 'Mobile Device' : 'Desktop'
			});

			if (verifyError) {
				throw new Error(verifyError.error_description || 'Registration verification failed');
			}

			// 4. Registration successful
			console.log('Registration successful:', verifyData!.message);
			console.log('Passkey created:', verifyData!.passkeyId);

			// Redirect to login page after successful registration
			window.location.href = '/login';

		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred during passkey registration';
			console.error('Passkey registration error:', err);
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
			// Call API to send magic link
			const { error: apiError } = await magicLinkAPI.send({ email, name });

			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to send magic link');
			}

			console.log('Magic link sent to:', email);

			// Redirect to magic link sent page
			window.location.href = `/magic-link-sent?email=${encodeURIComponent(email)}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred while sending magic link';
			console.error('Magic link send error:', err);
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

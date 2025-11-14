<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { Mail, Key } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import { passkeyAPI, magicLinkAPI } from '$lib/api/client';

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
			// 1. Get authentication options from server
			const { data: optionsData, error: optionsError } = await passkeyAPI.getLoginOptions({ email });

			if (optionsError) {
				throw new Error(optionsError.error_description || 'Failed to get authentication options');
			}

			// 2. Call WebAuthn API to get credential
			const credential = await navigator.credentials.get({
				publicKey: optionsData!.options
			}) as any;

			if (!credential) {
				throw new Error('No credential received from authenticator');
			}

			// 3. Send credential to server for verification
			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyLogin({
				challengeId: optionsData!.challengeId,
				credential: {
					id: credential.id,
					rawId: credential.id,
					response: {
						clientDataJSON: Array.from(new Uint8Array(credential.response.clientDataJSON)),
						authenticatorData: Array.from(new Uint8Array(credential.response.authenticatorData)),
						signature: Array.from(new Uint8Array(credential.response.signature)),
						userHandle: credential.response.userHandle ? Array.from(new Uint8Array(credential.response.userHandle)) : undefined
					},
					type: credential.type
				}
			});

			if (verifyError) {
				throw new Error(verifyError.error_description || 'Authentication verification failed');
			}

			// 4. Store session and redirect
			console.log('Logged in as:', verifyData!.user.email);
			// TODO: Store session ID and redirect to appropriate page
			alert('Login successful! Session ID: ' + verifyData!.sessionId);

		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred during passkey authentication';
			console.error('Passkey login error:', err);
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
			// Call API to send magic link
			const { data, error: apiError } = await magicLinkAPI.send({ email });

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

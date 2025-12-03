<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { passkeyAPI, emailCodeAPI } from '$lib/api/client';
	import { startRegistration } from '@simplewebauthn/browser';

	let email = $state('');
	let name = $state('');
	let error = $state('');
	let passkeyLoading = $state(false);
	let emailCodeLoading = $state(false);
	let emailError = $state('');
	let nameError = $state('');
	let debugInfo = $state<Array<{ step: string; data: unknown; timestamp: string }>>([]);

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
		// Clear previous errors and debug info
		error = '';
		emailError = '';
		nameError = '';
		debugInfo = [];

		// Validate email
		if (!email.trim()) {
			emailError = $LL.login_errorEmailRequired();
			return;
		}

		if (!validateEmail(email)) {
			emailError = $LL.login_errorEmailInvalid();
			return;
		}

		// Validate name
		if (!name.trim()) {
			nameError = $LL.register_errorNameRequired();
			return;
		}

		passkeyLoading = true;

		try {
			// 1. Get registration options from server
			const { data: optionsData, error: optionsError } = await passkeyAPI.getRegisterOptions({
				email,
				name
			});

			debugInfo.push({
				step: '1. Registration Options Response',
				data: { optionsData, optionsError },
				timestamp: new Date().toISOString()
			});

			if (optionsError) {
				throw new Error(optionsError.error_description || 'Failed to get registration options');
			}

			if (!optionsData || !optionsData.options) {
				throw new Error('Invalid response from server: missing options');
			}

			// 2. Call WebAuthn API using @simplewebauthn/browser
			// This handles all the base64url to Uint8Array conversions automatically
			let credential;
			try {
				/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
				credential = await startRegistration({ optionsJSON: optionsData.options as any });
				debugInfo.push({
					step: '2. WebAuthn Credential Created',
					data: credential,
					timestamp: new Date().toISOString()
				});
			} catch (webauthnError) {
				debugInfo.push({
					step: '2. WebAuthn Error',
					data: {
						error: webauthnError,
						message: webauthnError instanceof Error ? webauthnError.message : 'Unknown error',
						stack: webauthnError instanceof Error ? webauthnError.stack : undefined
					},
					timestamp: new Date().toISOString()
				});
				throw new Error(
					`WebAuthn failed: ${webauthnError instanceof Error ? webauthnError.message : 'Unknown error'}`
				);
			}

			// 3. Send credential to server for verification
			const verificationPayload = {
				userId: optionsData!.userId,
				credential,
				deviceName: navigator.userAgent.includes('Mobile') ? 'Mobile Device' : 'Desktop'
			};

			debugInfo.push({
				step: '3. Verification Request Payload',
				data: verificationPayload,
				timestamp: new Date().toISOString()
			});

			const { data: verifyData, error: verifyError } =
				await passkeyAPI.verifyRegistration(verificationPayload);

			debugInfo.push({
				step: '4. Verification Response',
				data: { verifyData, verifyError },
				timestamp: new Date().toISOString()
			});

			if (verifyError) {
				throw new Error(verifyError.error_description || 'Registration verification failed');
			}

			// 5. Registration successful
			debugInfo.push({
				step: '5. Success - Redirecting',
				data: { message: 'Registration completed successfully' },
				timestamp: new Date().toISOString()
			});

			// Redirect to login page after successful registration
			// Give time for debug info to render before redirect
			setTimeout(() => {
				window.location.href = '/login';
			}, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred during passkey registration';
			debugInfo.push({
				step: 'ERROR',
				data: {
					error: err,
					message: err instanceof Error ? err.message : 'Unknown error',
					stack: err instanceof Error ? err.stack : undefined
				},
				timestamp: new Date().toISOString()
			});
		} finally {
			passkeyLoading = false;
		}
	}

	async function handleEmailCodeSignup() {
		// Clear previous errors
		error = '';
		emailError = '';
		nameError = '';

		// Validate email
		if (!email.trim()) {
			emailError = $LL.login_errorEmailRequired();
			return;
		}

		if (!validateEmail(email)) {
			emailError = $LL.login_errorEmailInvalid();
			return;
		}

		// Validate name
		if (!name.trim()) {
			nameError = $LL.register_errorNameRequired();
			return;
		}

		emailCodeLoading = true;

		try {
			// Call API to send verification code
			const { error: apiError } = await emailCodeAPI.send({ email, name });

			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to send verification code');
			}

			console.log('Verification code sent to:', email);

			// Redirect to email code verification page
			window.location.href = `/verify-email-code?email=${encodeURIComponent(email)}`;
		} catch (err) {
			error =
				err instanceof Error ? err.message : 'An error occurred while sending verification code';
			console.error('Email code send error:', err);
		} finally {
			emailCodeLoading = false;
		}
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			// Default to Email Code on Enter key
			handleEmailCodeSignup();
		}
	}
</script>

<svelte:head>
	<title>{$LL.register_title()} - {$LL.app_title()}</title>
	<meta
		name="description"
		content="Create a new account using passkey or email code authentication."
	/>
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

		<!-- Registration Card -->
		<Card class="mb-6">
			<div class="mb-6">
				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
					{$LL.register_title()}
				</h2>
				<p class="text-gray-600 dark:text-gray-400 text-sm">
					{$LL.register_subtitle()}
				</p>
			</div>

			<!-- Error Alert -->
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={() => (error = '')} class="mb-4">
					{error}
				</Alert>
			{/if}

			<!-- Name Input -->
			<div class="mb-4">
				<Input
					label={$LL.common_name()}
					type="text"
					placeholder={$LL.common_namePlaceholder()}
					bind:value={name}
					error={nameError}
					autocomplete="name"
					required
				>
					{#snippet icon()}
						<div class="i-heroicons-user h-5 w-5 text-gray-400"></div>
					{/snippet}
				</Input>
			</div>

			<!-- Email Input -->
			<div class="mb-6">
				<Input
					label={$LL.common_email()}
					type="email"
					placeholder={$LL.common_emailPlaceholder()}
					bind:value={email}
					error={emailError}
					onkeypress={handleKeyPress}
					autocomplete="email"
					required
				>
					{#snippet icon()}
						<div class="i-heroicons-envelope h-5 w-5 text-gray-400"></div>
					{/snippet}
				</Input>
			</div>

			<!-- Passkey Button -->
			{#if isPasskeySupported}
				<Button
					variant="primary"
					class="w-full mb-3"
					loading={passkeyLoading}
					disabled={emailCodeLoading}
					onclick={handlePasskeyRegister}
				>
					<div class="i-heroicons-key h-5 w-5"></div>
					{$LL.register_createWithPasskey()}
				</Button>

				<!-- Divider -->
				<div class="flex items-center my-4">
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
					<span class="px-4 text-sm text-gray-600 dark:text-gray-400">{$LL.common_or()}</span>
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
				</div>
			{/if}

			<!-- Email Code Button -->
			<Button
				variant="secondary"
				class="w-full"
				loading={emailCodeLoading}
				disabled={passkeyLoading}
				onclick={handleEmailCodeSignup}
			>
				<div class="i-heroicons-envelope h-5 w-5"></div>
				{$LL.register_sendCode()}
			</Button>

			<!-- Terms Agreement -->
			<p class="mt-4 text-xs text-gray-600 dark:text-gray-400 text-center">
				{$LL.register_termsAgreement()}
			</p>
		</Card>

		<!-- Debug Information -->
		{#if debugInfo.length > 0}
			<Card class="mt-6 bg-gray-900 text-white">
				<div class="mb-4">
					<h3 class="text-lg font-semibold text-yellow-400">🐛 Debug Information</h3>
					<p class="text-xs text-gray-400 mt-1">
						This section shows technical details for debugging
					</p>
				</div>

				<div class="space-y-4 max-h-96 overflow-y-auto">
					{#each debugInfo as info (info.timestamp)}
						<div class="border border-gray-700 rounded-lg p-3">
							<div class="flex items-center justify-between mb-2">
								<h4 class="font-mono text-sm font-semibold text-green-400">{info.step}</h4>
								<span class="text-xs text-gray-500"
									>{new Date(info.timestamp).toLocaleTimeString()}</span
								>
							</div>
							<pre class="bg-black rounded p-2 text-xs overflow-x-auto"><code
									>{JSON.stringify(info.data, null, 2)}</code
								></pre>
						</div>
					{/each}
				</div>
			</Card>
		{/if}

		<!-- Sign In Link -->
		<p class="text-center text-sm text-gray-600 dark:text-gray-400">
			<a
				href="/login"
				class="font-medium text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
			>
				{$LL.register_alreadyHaveAccount()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-600 dark:text-gray-400">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

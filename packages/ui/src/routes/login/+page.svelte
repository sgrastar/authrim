<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { passkeyAPI, emailCodeAPI, externalIdpAPI, loginChallengeAPI } from '$lib/api/client';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	let email = $state('');
	let error = $state('');
	let passkeyLoading = $state(false);
	let emailCodeLoading = $state(false);
	let externalIdpLoading = $state<string | null>(null);
	let debugInfo = $state<Array<{ step: string; data: unknown; timestamp: string }>>([]);

	// OAuth login challenge client info (for OIDC Dynamic OP conformance)
	interface ClientInfo {
		client_id: string;
		client_name: string;
		logo_uri?: string;
		client_uri?: string;
		policy_uri?: string;
		tos_uri?: string;
	}
	let clientInfo = $state<ClientInfo | null>(null);
	let clientInfoLoading = $state(false);

	// External IdP providers
	interface ExternalProvider {
		id: string;
		name: string;
		providerType: 'oidc' | 'oauth2';
		enabled: boolean;
		iconUrl?: string;
		buttonColor?: string;
		buttonText?: string;
	}
	let externalProviders = $state<ExternalProvider[]>([]);
	let externalProvidersLoading = $state(true);

	// Fetch external IdP providers and login challenge data on mount
	onMount(async () => {
		// Check for challenge_id in URL (OAuth authorization flow)
		const urlChallengeId = $page.url.searchParams.get('challenge_id');
		if (urlChallengeId) {
			clientInfoLoading = true;
			try {
				const { data, error: apiError } = await loginChallengeAPI.getData(urlChallengeId);
				if (data) {
					clientInfo = data.client;
					// Pre-fill login_hint if provided
					if (data.login_hint) {
						email = data.login_hint;
					}
				}
				if (apiError) {
					console.warn('Failed to load login challenge data:', apiError);
				}
			} catch (err) {
				console.warn('Error loading login challenge data:', err);
			} finally {
				clientInfoLoading = false;
			}
		}

		// Fetch external IdP providers
		try {
			const { data, error: apiError } = await externalIdpAPI.getProviders();
			if (data && data.providers) {
				externalProviders = data.providers.filter((p) => p.enabled);
			}
			if (apiError) {
				console.warn('Failed to load external IdP providers:', apiError);
			}
		} catch (err) {
			console.warn('Error loading external IdP providers:', err);
		} finally {
			externalProvidersLoading = false;
		}
	});

	// Handle external IdP login
	async function handleExternalLogin(providerId: string) {
		externalIdpLoading = providerId;
		try {
			const { url } = await externalIdpAPI.startLogin(providerId);
			window.location.href = url;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start external login';
			externalIdpLoading = null;
		}
	}

	// Get provider icon (use default icons for known providers)
	function getProviderIcon(provider: ExternalProvider): string {
		if (provider.iconUrl) return provider.iconUrl;
		const name = provider.name.toLowerCase();
		if (name.includes('google')) return 'i-logos-google-icon';
		if (name.includes('github')) return 'i-logos-github-icon';
		if (name.includes('microsoft') || name.includes('azure')) return 'i-logos-microsoft-icon';
		if (name.includes('apple')) return 'i-logos-apple';
		if (name.includes('facebook')) return 'i-logos-facebook';
		return 'i-heroicons-arrow-right-end-on-rectangle';
	}

	// Get provider button text
	function getProviderButtonText(provider: ExternalProvider): string {
		if (provider.buttonText) return provider.buttonText;
		return $LL.login_continueWith({ provider: provider.name });
	}

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
		// Clear previous errors and debug info
		error = '';
		debugInfo = [];

		// No email validation for Passkey - uses Discoverable Credentials
		passkeyLoading = true;

		try {
			// 1. Get authentication options from server (no email = discoverable credentials mode)
			const { data: optionsData, error: optionsError } = await passkeyAPI.getLoginOptions({});

			debugInfo.push({
				step: '1. Authentication Options Response',
				data: { optionsData, optionsError },
				timestamp: new Date().toISOString()
			});

			if (optionsError) {
				throw new Error(optionsError.error_description || 'Failed to get authentication options');
			}

			// 2. Call WebAuthn API using @simplewebauthn/browser
			// This handles all the base64url to Uint8Array conversions automatically
			let credential;
			try {
				credential = await startAuthentication({
					/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
					optionsJSON: optionsData!.options as any
				});
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
				challengeId: optionsData!.challengeId,
				credential
			};

			debugInfo.push({
				step: '3. Verification Request Payload',
				data: verificationPayload,
				timestamp: new Date().toISOString()
			});

			const { data: verifyData, error: verifyError } =
				await passkeyAPI.verifyLogin(verificationPayload);

			debugInfo.push({
				step: '4. Verification Response',
				data: { verifyData, verifyError },
				timestamp: new Date().toISOString()
			});

			if (verifyError) {
				throw new Error(verifyError.error_description || 'Authentication verification failed');
			}

			// 4. Store session using auth store
			if (verifyData!.sessionId) {
				auth.login(verifyData!.sessionId, {
					userId: verifyData!.userId,
					email: verifyData!.user.email,
					name: verifyData!.user.name || undefined
				});
			}

			debugInfo.push({
				step: '5. Success - Redirecting',
				data: { message: 'Login completed successfully', user: verifyData!.user.email },
				timestamp: new Date().toISOString()
			});

			// Redirect to home page
			// Give time for debug info to render before redirect
			setTimeout(() => {
				window.location.href = '/';
			}, 1000);
		} catch (err) {
			error =
				err instanceof Error ? err.message : 'An error occurred during passkey authentication';
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

	async function handleEmailCodeSend() {
		// Clear previous errors
		error = '';

		// Validate email
		if (!email.trim()) {
			error = $LL.login_errorEmailRequired();
			return;
		}

		if (!validateEmail(email)) {
			error = $LL.login_errorEmailInvalid();
			return;
		}

		emailCodeLoading = true;

		try {
			// Call API to send verification code
			const { error: apiError } = await emailCodeAPI.send({ email });

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
			handleEmailCodeSend();
		}
	}
</script>

<svelte:head>
	<title>{$LL.login_title()} - {$LL.app_title()}</title>
	<meta
		name="description"
		content="Sign in to your account using passkey or email code authentication."
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

		<!-- Client Info Section (OIDC Dynamic OP - logo_uri, policy_uri, tos_uri) -->
		{#if clientInfoLoading}
			<!-- Loading skeleton -->
			<Card class="mb-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 animate-pulse">
				<div class="flex items-center gap-4">
					<div class="flex-shrink-0 h-12 w-12 bg-gray-300 dark:bg-gray-600 rounded-lg"></div>
					<div class="flex-1">
						<div class="h-3 bg-gray-300 dark:bg-gray-600 rounded w-20 mb-2"></div>
						<div class="h-4 bg-gray-300 dark:bg-gray-600 rounded w-32"></div>
					</div>
				</div>
			</Card>
		{:else if clientInfo}
			<Card class="mb-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
				<div class="flex items-center gap-4">
					<!-- Client Logo -->
					{#if clientInfo.logo_uri}
						<div class="flex-shrink-0">
							<img
								src={clientInfo.logo_uri}
								alt="{clientInfo.client_name} logo"
								class="h-12 w-12 object-contain rounded-lg"
								onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
							/>
						</div>
					{/if}
					<!-- Client Name & Links -->
					<div class="flex-1 min-w-0">
						<p class="text-sm text-gray-600 dark:text-gray-400">Signing in to</p>
						{#if clientInfo.client_uri}
							<a
								href={clientInfo.client_uri}
								target="_blank"
								rel="noopener noreferrer"
								class="font-semibold text-gray-900 dark:text-white hover:text-primary-600 dark:hover:text-primary-400 truncate block"
							>
								{clientInfo.client_name}
							</a>
						{:else}
							<p class="font-semibold text-gray-900 dark:text-white truncate">
								{clientInfo.client_name}
							</p>
						{/if}
						<!-- Policy and ToS Links -->
						{#if clientInfo.policy_uri || clientInfo.tos_uri}
							<div class="flex gap-3 mt-1 text-xs">
								{#if clientInfo.policy_uri}
									<a
										href={clientInfo.policy_uri}
										target="_blank"
										rel="noopener noreferrer"
										class="text-blue-600 dark:text-blue-400 hover:underline"
									>
										Privacy Policy
									</a>
								{/if}
								{#if clientInfo.tos_uri}
									<a
										href={clientInfo.tos_uri}
										target="_blank"
										rel="noopener noreferrer"
										class="text-blue-600 dark:text-blue-400 hover:underline"
									>
										Terms of Service
									</a>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</Card>
		{/if}

		<!-- Login Card -->
		<Card class="mb-6">
			<div class="mb-6">
				<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
					{$LL.login_title()}
				</h2>
				<p class="text-gray-600 dark:text-gray-400 text-sm">
					{$LL.login_subtitle()}
				</p>
			</div>

			<!-- Error Alert -->
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={() => (error = '')} class="mb-4">
					{error}
				</Alert>
			{/if}

			<!-- Passkey Button (No email required) -->
			{#if isPasskeySupported}
				<Button
					variant="primary"
					class="w-full mb-4"
					loading={passkeyLoading}
					disabled={emailCodeLoading}
					onclick={handlePasskeyLogin}
				>
					<div class="i-heroicons-key h-5 w-5"></div>
					{$LL.login_signInWithPasskey()}
				</Button>

				<!-- Divider -->
				<div class="flex items-center my-4">
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
					<span class="px-4 text-sm text-gray-600 dark:text-gray-400">{$LL.common_or()}</span>
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
				</div>
			{/if}

			<!-- Email Input (Only for Email Code) -->
			<div class="mb-4">
				<Input
					label={$LL.common_email()}
					type="email"
					placeholder={$LL.common_emailPlaceholder()}
					bind:value={email}
					onkeypress={handleKeyPress}
					autocomplete="email"
					required
				>
					{#snippet icon()}
						<div class="i-heroicons-envelope h-5 w-5 text-gray-400"></div>
					{/snippet}
				</Input>
			</div>

			<!-- Email Code Button -->
			<Button
				variant="secondary"
				class="w-full"
				loading={emailCodeLoading}
				disabled={passkeyLoading || externalIdpLoading !== null}
				onclick={handleEmailCodeSend}
			>
				<div class="i-heroicons-envelope h-5 w-5"></div>
				{$LL.login_sendCode()}
			</Button>

			<!-- External IdP Section -->
			{#if !externalProvidersLoading && externalProviders.length > 0}
				<!-- Divider -->
				<div class="flex items-center my-6">
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
					<span class="px-4 text-sm text-gray-600 dark:text-gray-400"
						>{$LL.login_orContinueWith()}</span
					>
					<div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
				</div>

				<!-- External IdP Buttons -->
				<div class="space-y-3">
					{#each externalProviders as provider (provider.id)}
						<Button
							variant="secondary"
							class="w-full justify-center"
							loading={externalIdpLoading === provider.id}
							disabled={passkeyLoading ||
								emailCodeLoading ||
								(externalIdpLoading !== null && externalIdpLoading !== provider.id)}
							onclick={() => handleExternalLogin(provider.id)}
							style={provider.buttonColor
								? `border-color: ${provider.buttonColor}; color: ${provider.buttonColor};`
								: ''}
						>
							<div class="{getProviderIcon(provider)} h-5 w-5"></div>
							{getProviderButtonText(provider)}
						</Button>
					{/each}
				</div>
			{/if}
		</Card>

		<!-- Debug Information -->
		{#if debugInfo.length > 0}
			<Card class="mt-6 bg-gray-900 text-white">
				<div class="mb-4">
					<h3 class="text-lg font-semibold text-yellow-400">Debug Information</h3>
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

		<!-- Create Account Link -->
		<p class="text-center text-sm text-gray-600 dark:text-gray-400">
			<a
				href="/signup"
				class="font-medium text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
			>
				{$LL.login_createAccount()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-600 dark:text-gray-400">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

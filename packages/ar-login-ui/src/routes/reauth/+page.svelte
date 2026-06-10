<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { passkeyAPI, emailCodeAPI, loginChallengeAPI } from '$lib/api/client';
	import { isValidRedirectUrl, isValidImageUrl } from '$lib/utils/url-validation';
	import { fetchLoginMethods } from '$lib/api/login-methods';
	import { startAuthentication } from '@simplewebauthn/browser';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let loading = $state(true);
	let error = $state('');
	let challengeId = $state('');

	// Challenge data
	interface ChallengeData {
		client: {
			client_id: string;
			client_name: string;
			logo_uri?: string;
		};
		user: {
			id: string;
			email: string;
			name?: string;
		};
		max_age?: number;
		login_hint?: string;
	}
	let challengeData = $state<ChallengeData | null>(null);

	// Auth method states
	let passkeyEnabled = $state(false);
	let emailCodeEnabled = $state(false);
	let passkeyLoading = $state(false);
	let emailCodeLoading = $state(false);
	let email = $state('');

	// Derived
	const isPasskeySupported = $derived(
		typeof window !== 'undefined' &&
			window.PublicKeyCredential !== undefined &&
			typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	);

	const showPasskey = $derived(passkeyEnabled && isPasskeySupported);

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(async () => {
		challengeId = $page.url.searchParams.get('challenge_id') || '';
		if (!challengeId) {
			error = 'Missing challenge_id parameter';
			loading = false;
			return;
		}

		await Promise.all([loadChallengeData(), loadLoginMethods()]);
		loading = false;
	});

	// ---------------------------------------------------------------------------
	// Data
	// ---------------------------------------------------------------------------
	async function loadChallengeData() {
		try {
			const { data, error: apiError } = await loginChallengeAPI.getData(challengeId);
			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to load challenge data');
			}
			challengeData = data as unknown as ChallengeData;
			if (challengeData?.user?.email) {
				email = challengeData.user.email;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load challenge data';
		}
	}

	async function loadLoginMethods() {
		try {
			const { data } = await fetchLoginMethods();
			if (data) {
				passkeyEnabled = data.methods.passkey.reauthEnabled ?? data.methods.passkey.enabled;
				emailCodeEnabled = data.methods.emailCode.reauthEnabled ?? data.methods.emailCode.enabled;
			}
		} catch {
			passkeyEnabled = true;
			emailCodeEnabled = true;
		}
	}

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
	async function handlePasskeyReauth() {
		if (passkeyLoading) return;
		error = '';
		passkeyLoading = true;

		try {
			const { data: optionsData, error: optionsError } = await passkeyAPI.getLoginOptions({});
			if (optionsError) {
				throw new Error(optionsError.error_description || 'Failed to get authentication options');
			}

			/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
			const credential = await startAuthentication({ optionsJSON: optionsData!.options as any });

			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyLogin({
				challengeId: optionsData!.challengeId,
				credential,
				authorizationChallengeId: challengeId || undefined
			});

			if (verifyError) {
				throw new Error(verifyError.error_description || 'Authentication failed');
			}

			/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
			const redirectUrl = (verifyData as any)?.redirect_url;
			if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
				window.location.href = redirectUrl;
			} else {
				window.location.href = '/';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Re-authentication failed';
		} finally {
			passkeyLoading = false;
		}
	}

	async function handleEmailCodeReauth() {
		if (emailCodeLoading) return;
		error = '';
		if (!email) {
			error = $LL.login_errorEmailRequired();
			return;
		}

		emailCodeLoading = true;

		try {
			const { error: apiError } = await emailCodeAPI.send({ email });
			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to send verification code');
			}
			window.location.href = `/verify-email-code?email=${encodeURIComponent(email)}&challenge_id=${encodeURIComponent(challengeId)}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to send verification code';
		} finally {
			emailCodeLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.reauth_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<div class="auth-container">
		<!-- Header -->
		<div class="auth-header">
			<h1 class="auth-header__title">
				{brandingStore.brandName || $LL.app_title()}
			</h1>
		</div>

		{#if loading}
			<Card class="text-center py-8">
				<div
					class="h-8 w-8 border-3 rounded-full animate-spin mx-auto mb-3"
					style="border-color: var(--border); border-top-color: var(--primary);"
				></div>
				<p style="color: var(--text-muted); font-size: 0.875rem;">{$LL.common_loading()}</p>
			</Card>
		{:else}
			<Card class="mb-6">
				<!-- Icon -->
				<div class="auth-icon-badge">
					<div class="auth-icon-badge__circle auth-icon-badge__circle--warning">
						<div class="i-heroicons-shield-exclamation h-9 w-9 auth-icon-badge__icon"></div>
					</div>
				</div>

				<h2 class="auth-section-title text-center">
					{$LL.reauth_title()}
				</h2>
				<p class="auth-section-subtitle text-center mb-6">
					{$LL.reauth_subtitle()}
				</p>

				<!-- Challenge Info -->
				{#if challengeData}
					<div class="auth-info-box mb-6">
						<div class="flex items-center gap-3">
							{#if challengeData.client.logo_uri && isValidImageUrl(challengeData.client.logo_uri)}
								<img
									src={challengeData.client.logo_uri}
									alt={challengeData.client.client_name}
									class="h-10 w-10 rounded-lg"
								/>
							{/if}
							<div>
								<p class="auth-info-box__value">
									{challengeData.client.client_name}
								</p>
								{#if challengeData.user}
									<p class="auth-info-box__label" style="margin: 0;">
										{challengeData.user.email}
									</p>
								{/if}
							</div>
						</div>
					</div>
				{/if}

				{#if error}
					<Alert variant="error" dismissible={true} onDismiss={() => (error = '')} class="mb-4">
						{error}
					</Alert>
				{/if}

				<!-- Passkey Button -->
				{#if showPasskey}
					<Button
						variant="primary"
						class="w-full mb-3"
						loading={passkeyLoading}
						disabled={emailCodeLoading}
						onclick={handlePasskeyReauth}
					>
						<div class="i-heroicons-key h-5 w-5"></div>
						{$LL.reauth_verifyWithPasskey()}
					</Button>

					{#if emailCodeEnabled}
						<div class="auth-divider">
							<div class="auth-divider__line"></div>
							<span class="auth-divider__text">{$LL.common_or()}</span>
							<div class="auth-divider__line"></div>
						</div>
					{/if}
				{/if}

				<!-- Email Code Button -->
				{#if emailCodeEnabled}
					<Button
						variant="secondary"
						class="w-full"
						loading={emailCodeLoading}
						disabled={passkeyLoading}
						onclick={handleEmailCodeReauth}
					>
						<div class="i-heroicons-envelope h-5 w-5"></div>
						{$LL.reauth_verifyWithEmailCode()}
					</Button>
				{/if}
			</Card>
		{/if}
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

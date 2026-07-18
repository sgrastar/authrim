<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { Button, Card, Alert, Input, TurnstileWidget } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { passkeyAPI, emailCodeAPI, loginChallengeAPI, totpAPI } from '$lib/api/client';
	import { isValidRedirectUrl, isValidImageUrl } from '$lib/utils/url-validation';
	import { fetchAuthenticationMethods } from '$lib/api/authentication-methods';
	import { resolveTurnstileLanguage as resolveConfiguredTurnstileLanguage } from '$lib/turnstile-options';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { startTotpReauth, verifyTotpReauth } from './reauth-totp';
	import {
		signalUnknownCredential,
		shouldSignalUnknownCredentialAfterLoginFailure
	} from '$lib/webauthn/signal';

	const { brandingStore } = useLoginUIStores();

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
	let totpEnabled = $state(false);
	let passkeyLoading = $state(false);
	let emailCodeLoading = $state(false);
	let totpLoading = $state(false);
	let totpChallengeId = $state('');
	let totpCode = $state('');
	let totpCodeRequested = $state(false);
	let email = $state('');
	let turnstileSiteKey = $state<string | null>(null);
	let humanVerificationProvider = $state<'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom'>(
		'turnstile'
	);
	let humanVerificationMode = $state<'managed' | 'checkbox' | 'invisible' | 'score'>('managed');
	let turnstileRequired = $state(false);
	let turnstileToken = $state('');
	let activeTurnstileTarget = $state<string | null>(null);
	let pendingTurnstileTarget = $state<string | null>(null);
	const turnstileAction = 'authrim-reauth';

	let isDarkMode = $state(false);
	let turnstileLanguage = $state('en');
	const turnstileTheme = $derived(isDarkMode ? 'dark' : 'light');
	const authActionLoading = $derived(passkeyLoading || emailCodeLoading || totpLoading);

	// Derived
	const isPasskeySupported = $derived(
		typeof window !== 'undefined' &&
			window.PublicKeyCredential !== undefined &&
			typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	);

	const showPasskey = $derived(passkeyEnabled && isPasskeySupported);

	function resolveTurnstileLanguage(): string {
		return resolveConfiguredTurnstileLanguage(document.documentElement.lang, getLocale());
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(async () => {
		const checkDarkMode = () => {
			const theme = document.documentElement.getAttribute('data-theme');
			if (theme === 'dark') return true;
			if (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
			return false;
		};
		isDarkMode = checkDarkMode();
		turnstileLanguage = resolveTurnstileLanguage();

		const observer = new MutationObserver(() => {
			isDarkMode = checkDarkMode();
			turnstileLanguage = resolveTurnstileLanguage();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme', 'lang']
		});

		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		mql.addEventListener('change', () => {
			isDarkMode = checkDarkMode();
		});

		challengeId = $page.url.searchParams.get('challenge_id') || '';
		if (!challengeId) {
			error = 'Missing challenge_id parameter';
			loading = false;
			return;
		}

		await Promise.all([loadChallengeData(), loadAuthenticationMethods()]);
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

	async function loadAuthenticationMethods() {
		try {
			const { data } = await fetchAuthenticationMethods();
			if (data) {
				passkeyEnabled = data.methods.passkey.reauthEnabled ?? data.methods.passkey.enabled;
				emailCodeEnabled = data.methods.emailCode.reauthEnabled ?? data.methods.emailCode.enabled;
				totpEnabled = data.methods.totp.reauthEnabled ?? data.methods.totp.enabled;
				const humanVerificationRequired =
					data.methods.humanVerification.enabled && data.methods.humanVerification.reauthEnabled;
				humanVerificationProvider =
					data.methods.humanVerification.provider === 'hcaptcha' ||
					data.methods.humanVerification.provider === 'recaptcha' ||
					data.methods.humanVerification.provider === 'custom'
						? data.methods.humanVerification.provider
						: 'turnstile';
				humanVerificationMode = data.methods.humanVerification.widget.mode ?? 'managed';
				turnstileRequired =
					humanVerificationRequired &&
					humanVerificationProvider !== 'custom' &&
					Boolean(data.methods.humanVerification.siteKey);
				turnstileSiteKey = turnstileRequired ? data.methods.humanVerification.siteKey : null;
			}
		} catch {
			passkeyEnabled = true;
			emailCodeEnabled = true;
		}
	}

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
	function getTurnstileToken(target: string): string | undefined {
		if (!turnstileRequired) return undefined;
		if (!turnstileToken) {
			activeTurnstileTarget = target;
			pendingTurnstileTarget = target;
			return undefined;
		}
		return turnstileToken;
	}

	function showTurnstileFor(target: string): boolean {
		return turnstileRequired && Boolean(turnstileSiteKey) && activeTurnstileTarget === target;
	}

	function resumeTurnstileTarget(target: string) {
		if (target === 'passkey') {
			void handlePasskeyReauth();
			return;
		}
		if (target === 'email-code') {
			void handleEmailCodeReauth();
		}
	}

	$effect(() => {
		if (!turnstileToken || !pendingTurnstileTarget) return;
		const target = pendingTurnstileTarget;
		pendingTurnstileTarget = null;
		queueMicrotask(() => resumeTurnstileTarget(target));
	});

	async function handlePasskeyReauth() {
		if (passkeyLoading) return;
		error = '';
		passkeyLoading = true;

		try {
			const cfTurnstileResponse = getTurnstileToken('passkey');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const { data: optionsData, error: optionsError } = await passkeyAPI.getLoginOptions({
				human_verification_response: cfTurnstileResponse,
				authorizationChallengeId: challengeId || undefined
			});
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
				if (shouldSignalUnknownCredentialAfterLoginFailure(verifyError)) {
					await signalUnknownCredential(credential.id);
				}
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
			const cfTurnstileResponse = getTurnstileToken('email-code');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const { error: apiError } = await emailCodeAPI.send({
				email,
				human_verification_response: cfTurnstileResponse,
				authorizationChallengeId: challengeId || undefined
			});
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

	async function handleTotpStart() {
		if (authActionLoading) return;
		error = '';
		totpLoading = true;
		try {
			const { data, error: apiError } = await startTotpReauth(totpAPI, challengeId);
			if (apiError || !data) {
				throw new Error(apiError?.error_description || $LL.login_totpStartFailed());
			}
			totpChallengeId = data.challenge_id;
			totpCode = '';
			totpCodeRequested = true;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.login_totpStartFailed();
		} finally {
			totpLoading = false;
		}
	}

	async function handleTotpVerify() {
		if (authActionLoading) return;
		error = '';
		const code = totpCode.trim().replace(/\s+/g, '');
		if (!totpChallengeId || !/^\d{6}$|^\d{8}$/.test(code)) {
			error = $LL.login_totpCodeInvalid();
			return;
		}

		totpLoading = true;
		try {
			const { data, error: apiError } = await verifyTotpReauth(totpAPI, {
				totpChallengeId,
				code,
				authorizationChallengeId: challengeId
			});
			if (apiError || !data?.success) {
				throw new Error(apiError?.error_description || $LL.login_totpCodeInvalid());
			}
			if (data.redirect_url && isValidRedirectUrl(data.redirect_url)) {
				window.location.href = data.redirect_url;
			} else {
				window.location.href = '/';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.login_totpCodeInvalid();
		} finally {
			totpLoading = false;
		}
	}

	function handleTotpKeyPress(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		void (totpCodeRequested ? handleTotpVerify() : handleTotpStart());
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
					{#if showTurnstileFor('passkey') && turnstileSiteKey}
						<TurnstileWidget
							siteKey={turnstileSiteKey}
							provider={humanVerificationProvider}
							mode={humanVerificationMode}
							action={turnstileAction}
							theme={turnstileTheme}
							language={turnstileLanguage}
							bind:token={turnstileToken}
							disabled={authActionLoading}
							loadingLabel={$LL.login_humanVerificationLoading()}
							errorLabel={$LL.login_humanVerificationLoadFailed()}
						/>
					{/if}

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
					{#if showTurnstileFor('email-code') && turnstileSiteKey}
						<TurnstileWidget
							siteKey={turnstileSiteKey}
							provider={humanVerificationProvider}
							mode={humanVerificationMode}
							action={turnstileAction}
							theme={turnstileTheme}
							language={turnstileLanguage}
							bind:token={turnstileToken}
							disabled={authActionLoading}
							loadingLabel={$LL.login_humanVerificationLoading()}
							errorLabel={$LL.login_humanVerificationLoadFailed()}
						/>
					{/if}
				{/if}

				<!-- Authenticator App (TOTP) -->
				{#if totpEnabled}
					{#if showPasskey || emailCodeEnabled}
						<div class="auth-divider">
							<div class="auth-divider__line"></div>
							<span class="auth-divider__text">{$LL.common_or()}</span>
							<div class="auth-divider__line"></div>
						</div>
					{/if}

					{#if totpCodeRequested}
						<Input
							label={$LL.login_totpCodeLabel()}
							type="text"
							placeholder={$LL.login_totpCodePlaceholder()}
							bind:value={totpCode}
							onkeypress={handleTotpKeyPress}
							autocomplete="one-time-code"
							inputmode="numeric"
							maxlength={8}
							disabled={authActionLoading}
							required
						/>
					{/if}

					<Button
						variant="secondary"
						class="w-full"
						loading={totpLoading}
						disabled={passkeyLoading || emailCodeLoading}
						onclick={totpCodeRequested ? handleTotpVerify : handleTotpStart}
					>
						<div class="i-heroicons-device-phone-mobile h-5 w-5"></div>
						{totpCodeRequested ? $LL.login_totpVerify() : $LL.reauth_verifyWithTotp()}
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

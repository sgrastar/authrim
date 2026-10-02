<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import ReauthView, { type ChallengeData } from '$lib/views/ReauthView.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { passkeyAPI, emailCodeAPI, loginChallengeAPI, totpAPI } from '$lib/api/client';
	import { loginUiDisplayError, messageForCaughtError } from '$lib/errors/display-error';
	import { isValidRedirectUrl } from '$lib/utils/url-validation';
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
			error = $LL.error_invalid_request();
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
				throw loginUiDisplayError($LL.error_server_error());
			}
			challengeData = data as unknown as ChallengeData;
			if (challengeData?.user?.email) {
				email = challengeData.user.email;
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
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
				throw loginUiDisplayError($LL.error_server_error());
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
				throw loginUiDisplayError($LL.error_server_error());
			}

			/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
			const redirectUrl = (verifyData as any)?.redirect_url;
			if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
				window.location.href = redirectUrl;
			} else {
				window.location.href = '/';
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
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
				throw loginUiDisplayError($LL.error_server_error());
			}
			window.location.href = `/verify-email-code?email=${encodeURIComponent(email)}&challenge_id=${encodeURIComponent(challengeId)}`;
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
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
				throw loginUiDisplayError($LL.login_totpStartFailed());
			}
			totpChallengeId = data.challenge_id;
			totpCode = '';
			totpCodeRequested = true;
		} catch (err) {
			error = messageForCaughtError(err, $LL.login_totpStartFailed());
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
				throw loginUiDisplayError($LL.login_totpCodeInvalid());
			}
			if (data.redirect_url && isValidRedirectUrl(data.redirect_url)) {
				window.location.href = data.redirect_url;
			} else {
				window.location.href = '/';
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.login_totpCodeInvalid());
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

<AuthPageShell>
	<ReauthView
		{loading}
		{error}
		{challengeData}
		{showPasskey}
		{emailCodeEnabled}
		{totpEnabled}
		{passkeyLoading}
		{emailCodeLoading}
		{totpLoading}
		{authActionLoading}
		{totpCodeRequested}
		bind:totpCode
		{showTurnstileFor}
		{turnstileSiteKey}
		{humanVerificationProvider}
		{humanVerificationMode}
		{turnstileAction}
		{turnstileTheme}
		{turnstileLanguage}
		bind:turnstileToken
		onPasskey={handlePasskeyReauth}
		onEmailCode={handleEmailCodeReauth}
		onTotpStart={handleTotpStart}
		onTotpVerify={handleTotpVerify}
		onTotpKeyPress={handleTotpKeyPress}
		onDismissError={() => (error = '')}
	/>
</AuthPageShell>

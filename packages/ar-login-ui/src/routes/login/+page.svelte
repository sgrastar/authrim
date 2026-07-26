<script lang="ts">
	import { Button, Input, Card, Alert, TurnstileWidget, SanitizedHtml } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import FooterText from '$lib/components/FooterText.svelte';
	import LocalizedTagline from '$lib/components/LocalizedTagline.svelte';
	import RuntimeScreen from '$lib/components/RuntimeScreen.svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { normalizeLoginUILocale } from '$lib/i18n/locales';
	import {
		passkeyAPI,
		emailCodeAPI,
		totpAPI,
		directoryPasswordAPI,
		externalIdpAPI,
		loginChallengeAPI,
		type APIError
	} from '$lib/api/client';
	import { accountAPI } from '$lib/api/account';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import { loginUiDisplayError, messageForCaughtError } from '$lib/errors/display-error';
	import {
		isValidRedirectUrl,
		isValidReturnUrl,
		isValidImageUrl,
		isValidLinkUrl,
		sanitizeColor
	} from '$lib/utils/url-validation';
	import {
		fetchAuthenticationMethods,
		fetchAuthenticationMethodsForClient,
		type AuthenticationMethodsResponse,
		type ExternalProvider
	} from '$lib/api/authentication-methods';
	import {
		flowRuntimeAPI,
		type FlowRuntimeEmailVerificationChallenge,
		type FlowRuntimeConsentPolicyContent,
		type FlowRuntimeDestinationFieldConsentContent,
		type FlowRuntimeStartResponse,
		type FlowRuntimeStep
	} from '$lib/api/flow-runtime';
	import {
		consumeFlowRuntimeState,
		persistFlowRuntimeState
	} from '$lib/authrim/flow-runtime-state';
	import {
		isRuntimeAuthStep,
		runtimeAllowsAuthenticationHandle as runtimeStepAllowsAuthenticationHandle,
		runtimeAllowsExternalProvider as runtimeStepAllowsExternalProvider,
		type RuntimeAuthMethod
	} from '$lib/authrim/runtime-auth-handles';
	import { sanitizeRuntimeConsentHtml } from '$lib/consent/runtime-consent-html';
	import { getExternalProviderIconClass } from '$lib/login-provider-icons';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';
	import {
		signalUnknownCredential,
		shouldSignalUnknownCredentialAfterLoginFailure
	} from '$lib/webauthn/signal';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { applyAuthenticationMethodsToLoginUI } from '$lib/stores/login-ui-configuration';
	import { installPageResumeHandler } from '$lib/browser/page-resume';
	import { buildAuthSwitchHref } from '$lib/authrim/auth-switch-url';
	import { LOGIN_UI_SESSION_STORAGE_KEYS, setLoginUiSessionItem } from '$lib/authrim/storage-keys';
	import { resolveTurnstileLanguage as resolveConfiguredTurnstileLanguage } from '$lib/turnstile-options';
	import { onDestroy, onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { page } from '$app/stores';
	import type { PageData } from './$types';

	type LoginPageData = PageData & {
		authenticationMethods?: AuthenticationMethodsResponse;
		emailVerificationProtocolEnabled?: boolean;
	};

	let { data: pageData }: { data: LoginPageData } = $props();
	const emailVerificationTokenAutocomplete = 'email-verification-token' as never;
	const loginUIStores = useLoginUIStores();
	const { brandingStore, loginUIPageStore } = loginUIStores;
	const signupHref = $derived(buildAuthSwitchHref('/signup', $page.url.searchParams));
	const localizedBrandPanelTitle = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'brandPanelTitle')
	);
	const localizedBrandPanelText = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'brandPanelText')
	);
	const localizedFooterText = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'footerText')
	);
	const localizedLoginTitle = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'loginTitle') ?? $LL.login_title()
	);

	interface AuthenticationMethodsViewState {
		passkeyEnabled: boolean;
		emailCodeEnabled: boolean;
		emailCodeDigits: number;
		totpEnabled: boolean;
		totpDigits: number;
		directoryPasswordEnabled: boolean;
		directoryPasswordLabel: string;
		externalEnabled: boolean;
		externalProviders: ExternalProvider[];
		turnstileSiteKey: string | null;
		humanVerificationProvider: 'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom';
		humanVerificationMode: 'managed' | 'checkbox' | 'invisible' | 'score';
		turnstileRequired: boolean;
	}

	function normalizeSixOrEightDigits(value: unknown): number {
		return value === 8 ? 8 : 6;
	}

	type PasskeyProgressPhase = 'idle' | 'preparing' | 'waiting' | 'finishing';

	function resolveAuthenticationMethodsViewState(
		data: AuthenticationMethodsResponse
	): AuthenticationMethodsViewState {
		const humanVerificationProvider =
			data.methods.humanVerification.provider === 'hcaptcha' ||
			data.methods.humanVerification.provider === 'recaptcha' ||
			data.methods.humanVerification.provider === 'custom'
				? data.methods.humanVerification.provider
				: 'turnstile';
		const humanVerificationRequired =
			data.methods.humanVerification.enabled && data.methods.humanVerification.loginEnabled;
		const turnstileRequired =
			humanVerificationRequired &&
			humanVerificationProvider !== 'custom' &&
			Boolean(data.methods.humanVerification.siteKey);
		const externalProviders = data.methods.external.providers.filter(
			(provider) => provider.loginEnabled ?? provider.enabled !== false
		);

		return {
			passkeyEnabled: data.methods.passkey.loginEnabled ?? data.methods.passkey.enabled,
			emailCodeEnabled: data.methods.emailCode.loginEnabled ?? data.methods.emailCode.enabled,
			emailCodeDigits: normalizeSixOrEightDigits(data.methods.emailCode.digits),
			totpEnabled: data.methods.totp.loginEnabled ?? data.methods.totp.enabled,
			totpDigits: normalizeSixOrEightDigits(data.methods.totp.digits),
			directoryPasswordEnabled: data.methods.directoryPassword.enabled,
			directoryPasswordLabel: data.methods.directoryPassword.label || $LL.login_organizationId(),
			externalEnabled: data.methods.external.enabled && externalProviders.length > 0,
			externalProviders,
			turnstileSiteKey: turnstileRequired ? data.methods.humanVerification.siteKey : null,
			humanVerificationProvider,
			humanVerificationMode: data.methods.humanVerification.widget.mode ?? 'managed',
			turnstileRequired
		};
	}

	const embeddedAuthenticationMethodsState = $derived(
		pageData.authenticationMethods
			? resolveAuthenticationMethodsViewState(pageData.authenticationMethods)
			: null
	);
	const hasEmbeddedAuthenticationMethods = $derived(embeddedAuthenticationMethodsState !== null);
	const hasBrandingLogo = $derived(
		Boolean(brandingStore.logoUrl && isValidImageUrl(brandingStore.logoUrl))
	);
	const showBrandLogo = $derived(
		loginUIPageStore.logoDisplay !== 'hidden' &&
			loginUIPageStore.logoDisplay !== 'text' &&
			hasBrandingLogo
	);
	const showBrandText = $derived(
		loginUIPageStore.logoDisplay !== 'hidden' &&
			(loginUIPageStore.logoDisplay !== 'image' || !hasBrandingLogo)
	);

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let email = $state('');
	let combinedIdentifier = $state('');
	let mailOtpCode = $state('');
	let mailOtpSent = $state(false);
	let mailOtpResendRemaining = $state(0);
	let totpIdentifier = $state('');
	let totpCode = $state('');
	let totpChallengeId = $state('');
	let totpCodeRequested = $state(false);
	let directoryUsername = $state('');
	let directoryPassword = $state('');
	let error = $state('');
	let directoryMigrationNotice = $state('');
	let directoryMigrationTransaction = $state<{
		transactionId: string;
		transactionToken: string;
		userName?: string | null;
		emailFallback?: {
			transactionId: string;
			transactionToken: string;
			maskedEmail: string;
		};
	} | null>(null);
	let directoryRecoveryTransaction = $state<{
		transactionId: string;
		transactionToken: string;
		maskedEmail: string;
	} | null>(null);
	let directoryMigrationEmailChallengeId = $state('');
	let directoryMigrationEmailCode = $state('');
	let passkeyLoading = $state(false);
	let passkeyProgress = $state<PasskeyProgressPhase>('idle');
	let emailCodeLoading = $state(false);
	let totpLoading = $state(false);
	let directoryPasswordLoading = $state(false);
	let directoryMigrationPasskeyLoading = $state(false);
	let directoryMigrationEmailLoading = $state(false);
	let externalIdpLoading = $state<string | null>(null);
	let runtimeFlow = $state<FlowRuntimeStartResponse | null>(null);
	let runtimeFlowStep = $state<FlowRuntimeStep | null>(null);
	let emailVerificationChallenge = $state<FlowRuntimeEmailVerificationChallenge | null>(null);
	let emailVerificationChallengeRequestKey = '';
	let runtimeFlowLoading = $state(true);
	let runtimeFlowError = $state('');
	let runtimeFlowBlocked = $state(false);
	let runtimeAuthorizationChallengeBlocked = $state(false);
	let runtimeConsentDecisions = $state<Record<string, boolean>>({});
	let runtimeConsentSelectedValues = $state<Record<string, string>>({});
	let runtimeConsentDecisionKey = $state('');
	let runtimeDestinationFieldDecisions = $state<Record<string, boolean>>({});
	let runtimeDestinationFieldDecisionKey = $state('');
	let pendingPostAuthRedirect = $state<string | null>(null);
	const MAIL_OTP_RESEND_SECONDS = 60;
	let mailOtpResendTimer: number | null = null;
	const authActionLoading = $derived(
		passkeyLoading ||
			emailCodeLoading ||
			totpLoading ||
			directoryPasswordLoading ||
			directoryMigrationPasskeyLoading ||
			directoryMigrationEmailLoading ||
			externalIdpLoading !== null ||
			runtimeFlowLoading
	);
	const authActionDisabled = $derived(authActionLoading || runtimeAuthorizationChallengeBlocked);
	const passkeyProgressMessage = $derived(getPasskeyProgressMessage(passkeyProgress));

	// Authentication methods (from API)
	let fetchedAuthenticationMethodsState = $state<AuthenticationMethodsViewState | null>(null);
	let clientMethodsLoading = $state(false);
	let clientMethodsLoadAttempted = $state(false);
	const authenticationMethodsState = $derived(
		fetchedAuthenticationMethodsState ?? embeddedAuthenticationMethodsState
	);
	const methodsLoading = $derived(
		!authenticationMethodsState &&
			(clientMethodsLoading || (!hasEmbeddedAuthenticationMethods && !clientMethodsLoadAttempted))
	);
	let methodsError = $state('');
	let authenticationMethodsRequestSequence = 0;
	const passkeyEnabled = $derived(authenticationMethodsState?.passkeyEnabled ?? false);
	const emailCodeEnabled = $derived(authenticationMethodsState?.emailCodeEnabled ?? false);
	const emailCodeDigits = $derived(authenticationMethodsState?.emailCodeDigits ?? 6);
	const totpEnabled = $derived(authenticationMethodsState?.totpEnabled ?? false);
	const totpDigits = $derived(authenticationMethodsState?.totpDigits ?? 6);
	const directoryPasswordEnabled = $derived(
		authenticationMethodsState?.directoryPasswordEnabled ?? false
	);
	const directoryPasswordLabel = $derived(
		authenticationMethodsState?.directoryPasswordLabel ?? $LL.login_organizationId()
	);
	const externalEnabled = $derived(authenticationMethodsState?.externalEnabled ?? false);
	const externalProviders = $derived(authenticationMethodsState?.externalProviders ?? []);
	const turnstileSiteKey = $derived(authenticationMethodsState?.turnstileSiteKey ?? null);
	const humanVerificationProvider = $derived(
		authenticationMethodsState?.humanVerificationProvider ?? 'turnstile'
	);
	const humanVerificationMode = $derived(
		authenticationMethodsState?.humanVerificationMode ?? 'managed'
	);
	const turnstileRequired = $derived(authenticationMethodsState?.turnstileRequired ?? false);
	let turnstileToken = $state('');
	let turnstileResetKey = $state(0);
	let activeTurnstileTarget = $state<string | null>(null);
	let pendingTurnstileTarget = $state<string | null>(null);
	const turnstileAction = 'authrim-login';

	$effect(() => {
		const policy = getRuntimeConsentPolicy(runtimeFlowStep);
		const key =
			runtimeFlowStep?.id && policy
				? `${runtimeFlowStep.id}:${policy.items.map((item) => item.statement_id).join(',')}`
				: '';
		if (key === runtimeConsentDecisionKey) return;
		runtimeConsentDecisionKey = key;
		runtimeConsentDecisions = policy
			? Object.fromEntries(
					policy.items.map((item) => [
						item.statement_id,
						item.checkbox_mode === 'none' || item.checkbox_default_checked
					])
				)
			: {};
		runtimeConsentSelectedValues = {};
	});

	$effect(() => {
		const consent = getRuntimeDestinationFieldConsent(runtimeFlowStep);
		const key =
			runtimeFlowStep?.id && consent
				? `${runtimeFlowStep.id}:${consent.profile_version_id}:${consent.fields
						.map((field) => field.key)
						.join(',')}`
				: '';
		if (key === runtimeDestinationFieldDecisionKey) return;
		runtimeDestinationFieldDecisionKey = key;
		runtimeDestinationFieldDecisions = consent
			? Object.fromEntries(consent.fields.map((field) => [field.key, true]))
			: {};
	});

	// OAuth login challenge client info
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
	let authorizationChallengeId = $state('');
	let inviteToken = $state('');
	let samlRequestId = $state('');
	let samlSpEntityId = $state('');
	let returnTo = $state('');
	let accountReturn = $state('');
	let runtimeInteractionId = $state('');

	// External IdP error
	function getExternalIdpErrorMessage(
		code: string
	): { title: string; message: string; action?: string } | null {
		const messages: Record<string, { title: string; message: string; action?: string }> = {
			account_exists_link_required: {
				title: $LL.login_extError_accountExists_title(),
				message: $LL.login_extError_accountExists_message(),
				action: $LL.login_extError_accountExists_action()
			},
			email_not_verified: {
				title: $LL.login_extError_emailNotVerified_title(),
				message: $LL.login_extError_emailNotVerified_message()
			},
			local_email_not_verified: {
				title: $LL.login_extError_localEmailNotVerified_title(),
				message: $LL.login_extError_localEmailNotVerified_message()
			},
			jit_provisioning_disabled: {
				title: $LL.login_extError_jitDisabled_title(),
				message: $LL.login_extError_jitDisabled_message()
			},
			no_account_found: {
				title: $LL.login_extError_noAccount_title(),
				message: $LL.login_extError_noAccount_message()
			},
			provider_error: {
				title: $LL.login_extError_providerError_title(),
				message: $LL.login_extError_providerError_message()
			},
			callback_failed: {
				title: $LL.login_extError_callbackFailed_title(),
				message: $LL.login_extError_callbackFailed_message()
			}
		};
		return messages[code] || null;
	}
	let externalIdpError = $state<{ title: string; message: string; action?: string } | null>(null);

	// Dark mode detection for external provider button colors
	let isDarkMode = $state(false);
	let turnstileLanguage = $state('en');
	const turnstileTheme = $derived(isDarkMode ? 'dark' : 'light');

	// Derived: WebAuthn support check
	const isPasskeySupported = $derived(
		typeof window !== 'undefined' &&
			window.PublicKeyCredential !== undefined &&
			typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	);

	// Show passkey only if both server-enabled and browser-supported
	const showPasskey = $derived(passkeyEnabled && isPasskeySupported);
	const showRuntimePasskey = $derived(showPasskey && runtimeAllowsAuthenticationHandle('passkey'));
	const showRuntimeEmailCode = $derived(
		emailCodeEnabled && runtimeAllowsAuthenticationHandle('mail_otp', ['email_code'])
	);
	const showRuntimeTotp = $derived(
		totpEnabled && runtimeAllowsAuthenticationHandle('totp', ['otp'])
	);
	const showRuntimeDirectoryPassword = $derived(
		directoryPasswordEnabled &&
			runtimeAllowsAuthenticationHandle('directory_password', ['password'])
	);
	const visibleExternalProviders = $derived(
		externalProviders.filter((provider) => runtimeAllowsExternalProvider(provider))
	);
	const showRuntimeExternal = $derived(externalEnabled && visibleExternalProviders.length > 0);
	const hasVisibleAuthenticationMethod = $derived(
		showRuntimePasskey ||
			showRuntimeEmailCode ||
			showRuntimeTotp ||
			showRuntimeDirectoryPassword ||
			showRuntimeExternal
	);
	const runtimeScreen = $derived(getRuntimeScreen(runtimeFlowStep));
	const runtimeScreenWide = $derived(isRuntimeScreenWide(runtimeScreen));
	const useRuntimeScreenLayout = $derived(
		Boolean(runtimeScreen) &&
			runtimeFlowStep !== null &&
			runtimeFlowStep.render &&
			shouldRenderRuntimeStep(runtimeFlowStep)
	);
	const useRuntimeAuthFormLayout = $derived(
		useRuntimeScreenLayout && isRuntimeAuthStep(runtimeFlowStep)
	);
	const runtimeInitialLoading = $derived(
		runtimeFlowLoading && !runtimeFlow && !runtimeFlowStep && !runtimeFlowError
	);
	let entryMotionEnabled = $state(true);
	let runtimeStartSequence = 0;

	$effect(() => {
		if (methodsLoading || runtimeInitialLoading) return;

		const timeout = window.setTimeout(() => {
			entryMotionEnabled = false;
		}, 1600);
		return () => window.clearTimeout(timeout);
	});
	const runtimeAuthFormMissing = $derived(
		Boolean(
			runtimeFlowStep &&
			runtimeFlowStep.render &&
			isRuntimeAuthStep(runtimeFlowStep) &&
			!runtimeScreen &&
			!runtimeFlowError
		)
	);
	const blockLegacyFormLayout = $derived(
		useRuntimeScreenLayout || runtimeFlowBlocked || runtimeAuthFormMissing
	);
	const blockLegacyAuthLayout = $derived(
		useRuntimeAuthFormLayout || runtimeFlowBlocked || runtimeAuthFormMissing
	);
	const runtimeScreenFieldValues = $derived<Record<string, string>>({
		email,
		identifier: combinedIdentifier || totpIdentifier || email,
		mail_otp_code: mailOtpCode,
		mail_otp_code_length: String(emailCodeDigits),
		mail_otp_sent: mailOtpSent ? 'true' : 'false',
		mail_otp_resend_remaining: String(mailOtpResendRemaining),
		mail_otp_resend_total: String(MAIL_OTP_RESEND_SECONDS),
		code_input_method: totpCodeRequested ? 'totp' : mailOtpSent ? 'mail_otp' : '',
		totp_identifier: totpIdentifier,
		totp_code: totpCode,
		totp_code_length: String(totpDigits),
		totp_code_requested: totpCodeRequested ? 'true' : 'false',
		directory_username: directoryUsername,
		directory_password: directoryPassword
	});
	const runtimeMethodAvailability = $derived<Partial<Record<RuntimeAuthMethod, boolean>>>({
		passkey: showRuntimePasskey,
		mail_otp: showRuntimeEmailCode,
		mail_otp_totp: showRuntimeEmailCode && showRuntimeTotp,
		totp: showRuntimeTotp,
		directory_password: showRuntimeDirectoryPassword,
		external_idp: showRuntimeExternal
	});
	const runtimeMethodLoading = $derived<Partial<Record<RuntimeAuthMethod, boolean>>>({
		passkey: passkeyLoading,
		mail_otp: emailCodeLoading,
		mail_otp_totp: emailCodeLoading || totpLoading,
		totp: totpLoading,
		directory_password: directoryPasswordLoading,
		external_idp: externalIdpLoading !== null
	});
	const runtimeExternalProviders = $derived(
		visibleExternalProviders.map((provider) => {
			const safeColor =
				isDarkMode && provider.buttonColorDark
					? sanitizeColor(provider.buttonColorDark)
					: sanitizeColor(provider.buttonColor);
			return {
				id: provider.id,
				label: provider.name,
				iconUrl: provider.iconUrl && isValidImageUrl(provider.iconUrl) ? provider.iconUrl : null,
				iconClass: getProviderIcon(provider),
				style: safeColor ? `border-color: ${safeColor}; color: ${safeColor};` : ''
			};
		})
	);

	function resolveTurnstileLanguage(): string {
		return resolveConfiguredTurnstileLanguage(document.documentElement.lang, getLocale());
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(async () => {
		// Detect dark mode from data-theme attribute or prefers-color-scheme
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
		const handleMqlChange = () => {
			isDarkMode = checkDarkMode();
		};
		mql.addEventListener('change', handleMqlChange);

		// Check for external IdP error in URL
		const urlError = $page.url.searchParams.get('error');
		if (urlError) {
			const errorInfo = getExternalIdpErrorMessage(urlError);
			if (errorInfo) {
				externalIdpError = errorInfo;
			} else {
				externalIdpError = {
					title: $LL.login_extError_default_title(),
					message: $LL.login_extError_default_message()
				};
			}
			const newUrl = new URL(window.location.href);
			newUrl.searchParams.delete('error');
			newUrl.searchParams.delete('error_description');
			window.history.replaceState({}, '', newUrl.toString());
		}

		// Fetch authentication methods + challenge data in parallel
		const urlChallengeId = $page.url.searchParams.get('challenge_id');
		authorizationChallengeId = urlChallengeId || '';
		inviteToken = $page.url.searchParams.get('invite_token') || '';
		samlRequestId = $page.url.searchParams.get('saml_request_id') || '';
		samlSpEntityId = $page.url.searchParams.get('saml_sp_entity_id') || '';
		returnTo = $page.url.searchParams.get('return_to') || '';
		accountReturn = $page.url.searchParams.get('account_return') || '';
		runtimeInteractionId = $page.url.searchParams.get('runtime_interaction_id') || '';
		const urlLoginHint = $page.url.searchParams.get('login_hint');
		if (urlLoginHint) {
			email = urlLoginHint;
			totpIdentifier = urlLoginHint;
			combinedIdentifier = urlLoginHint;
		}

		const tasks: Promise<void>[] = [loadAuthenticationMethods()];
		let runtimeTargetReady: Promise<void> = Promise.resolve();
		if (urlChallengeId) {
			const challengeTask = loadChallengeData(urlChallengeId);
			tasks.push(challengeTask);
			if (!runtimeInteractionId) {
				runtimeTargetReady = challengeTask;
			}
		}
		tasks.push(runtimeTargetReady.then(() => startRuntimeFlowIfAvailable()));
		await Promise.all(tasks);
		await refreshEmailVerificationProtocolChallenge();
	});

	onDestroy(() => {
		stopMailOtpResendTimer();
	});

	onMount(() => {
		const handleLocaleChange = (event: Event) => {
			const locale = (event as CustomEvent<{ locale?: string }>).detail?.locale;
			if (locale) void refreshRuntimeLocale(locale);
		};
		window.addEventListener('authrim:locale-change', handleLocaleChange);
		return () => window.removeEventListener('authrim:locale-change', handleLocaleChange);
	});

	onMount(() =>
		installPageResumeHandler(async () => {
			const retryRuntime = runtimeInitialLoading;
			await Promise.all([
				loadAuthenticationMethods({ forceRefresh: true }),
				...(retryRuntime ? [startRuntimeFlowIfAvailable()] : [])
			]);
		})
	);

	// ---------------------------------------------------------------------------
	// Data fetchers
	// ---------------------------------------------------------------------------
	async function loadAuthenticationMethods(
		options: { forceRefresh?: boolean; clientId?: string | null } = {}
	) {
		if (pageData.authenticationMethods && !options.forceRefresh && !options.clientId) {
			clientMethodsLoadAttempted = true;
			return;
		}

		const requestSequence = ++authenticationMethodsRequestSequence;
		clientMethodsLoading = true;
		methodsError = '';
		try {
			const requestedClientId = options.clientId ?? clientInfo?.client_id ?? null;
			const result = requestedClientId
				? await fetchAuthenticationMethodsForClient(requestedClientId, {
						forceRefresh: options.forceRefresh
					})
				: await fetchAuthenticationMethods({ forceRefresh: options.forceRefresh });
			if (requestSequence !== authenticationMethodsRequestSequence) return;
			const { data, error: apiError } = result;
			if (apiError) {
				if (!authenticationMethodsState) methodsError = $LL.login_methodsLoadFailed();
				return;
			}
			if (data) {
				fetchedAuthenticationMethodsState = resolveAuthenticationMethodsViewState(data);
				applyAuthenticationMethodsToLoginUI(data, loginUIStores);
			}
		} catch {
			if (requestSequence === authenticationMethodsRequestSequence && !authenticationMethodsState) {
				methodsError = $LL.login_methodsLoadFailed();
			}
		} finally {
			if (requestSequence === authenticationMethodsRequestSequence) {
				clientMethodsLoading = false;
				clientMethodsLoadAttempted = true;
			}
		}
	}

	async function loadChallengeData(challengeId: string) {
		clientInfoLoading = true;
		try {
			const { data, error: apiError } = await loginChallengeAPI.getData(challengeId);
			if (data) {
				clientInfo = data.client;
				await applyClientLoginUIOverride(data.client.client_id);
				if (data.login_hint) {
					email = data.login_hint;
					totpIdentifier = data.login_hint;
					combinedIdentifier = data.login_hint;
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

	async function applyClientLoginUIOverride(clientId: string) {
		await loadAuthenticationMethods({ clientId });
	}

	function getRuntimeCurrentStep(flow: FlowRuntimeStartResponse | null): FlowRuntimeStep | null {
		if (!flow) return null;
		const currentStepId = flow.interaction.current_step_id;
		if (!currentStepId) return null;
		return flow.contract.ui.steps.find((step) => step.id === currentStepId) ?? null;
	}

	async function refreshEmailVerificationProtocolChallenge(force = false): Promise<void> {
		const flow = runtimeFlow;
		const step = runtimeFlowStep ?? getRuntimeCurrentStep(flow);
		const requestKey = flow && step ? `${flow.interaction.id}:${step.id}:${flow.signature}` : '';
		if (!force && requestKey && emailVerificationChallengeRequestKey === requestKey) return;
		emailVerificationChallengeRequestKey = requestKey;
		emailVerificationChallenge = null;

		if (
			!requestKey ||
			!flow ||
			!step ||
			!emailCodeEnabled ||
			pageData.emailVerificationProtocolEnabled !== true
		) {
			return;
		}

		const { data } = await flowRuntimeAPI.createEmailVerificationChallenge(flow.interaction.id, {
			step_id: step.id,
			contract_hash: flow.contract_hash,
			signature: flow.signature
		});
		if (emailVerificationChallengeRequestKey !== requestKey) return;
		if (
			data?.available === true &&
			typeof data.challenge_id === 'string' &&
			typeof data.nonce === 'string' &&
			data.interaction_id === flow.interaction.id &&
			data.step_id === step.id
		) {
			emailVerificationChallenge = data;
		}
	}

	function handleEmailVerificationProtocolSubmit(event: SubmitEvent): void {
		event.preventDefault();
		const challenge = emailVerificationChallenge;
		const form = event.currentTarget;
		if (!(form instanceof HTMLFormElement) || !challenge?.challenge_id) {
			void handleEmailCodeSend();
			return;
		}
		const token = String(new FormData(form).get('email_verification_token') ?? '').trim();
		void handleEmailCodeSend({
			emailVerification: token
				? {
						token,
						challengeId: challenge.challenge_id,
						interactionId: challenge.interaction_id ?? ''
					}
				: undefined
		});
	}

	function getRuntimeTarget() {
		if (clientInfo?.client_id) {
			return {
				target_type: 'oidc_client' as const,
				target_id: clientInfo.client_id,
				client_id: clientInfo.client_id
			};
		}
		if (samlSpEntityId) {
			return {
				target_type: 'saml_sp' as const,
				target_id: samlSpEntityId,
				saml_sp_id: samlSpEntityId
			};
		}
		return {
			target_type: 'tenant' as const,
			target_id: null
		};
	}

	function isAuthorizationChallengeRuntimeError(apiError: APIError): boolean {
		return (
			Boolean(authorizationChallengeId) &&
			(apiError.error === 'invalid_authorization_challenge' ||
				apiError.error === 'authorization_challenge_mismatch' ||
				apiError.error === 'interaction_expired' ||
				apiError.error_description?.toLowerCase().includes('authorization challenge') === true)
		);
	}

	function failRuntimeStart(
		message: string,
		options: { blockAuthorizationChallenge?: boolean } = {}
	) {
		runtimeFlow = null;
		runtimeFlowStep = null;
		runtimeFlowError = message;
		runtimeFlowBlocked = true;
		runtimeAuthorizationChallengeBlocked = options.blockAuthorizationChallenge === true;
	}

	function ensureAuthorizationChallengeCanContinue(): boolean {
		if (!runtimeAuthorizationChallengeBlocked) return true;
		error = runtimeFlowError || $LL.error_invalid_request();
		return false;
	}

	async function startRuntimeFlowIfAvailable() {
		const startSequence = ++runtimeStartSequence;
		runtimeFlowLoading = true;
		runtimeFlowError = '';
		runtimeFlowBlocked = false;
		runtimeAuthorizationChallengeBlocked = false;
		try {
			if (runtimeInteractionId) {
				const storedRuntime = consumeFlowRuntimeState(runtimeInteractionId);
				if (!storedRuntime) {
					failRuntimeStart($LL.error_invalid_request());
					return;
				}
				pendingPostAuthRedirect = storedRuntime.post_auth_redirect ?? null;
				const { data, error: apiError } = await flowRuntimeAPI.start({
					resume_interaction_id: storedRuntime.interaction_id,
					contract_hash: storedRuntime.contract_hash,
					signature: storedRuntime.signature
				});
				if (startSequence !== runtimeStartSequence) return;
				if (apiError) {
					failRuntimeStart(getApiErrorMessage(apiError), {
						blockAuthorizationChallenge: isAuthorizationChallengeRuntimeError(apiError)
					});
					return;
				}
				if (!data) return;
				runtimeFlow = data;
				runtimeAuthorizationChallengeBlocked = false;
				runtimeFlowStep = getRuntimeCurrentStep(data);
				if (
					data.interaction.state !== 'completed' &&
					data.interaction.current_step_id &&
					!runtimeFlowStep
				) {
					failRuntimeStart($LL.error_invalid_request());
					return;
				}
				if (!persistFlowRuntimeState(data, { postAuthRedirect: pendingPostAuthRedirect })) {
					failRuntimeStart($LL.error_invalid_request());
					return;
				}
				await advanceRuntimePastNonRenderedSteps();
				await redirectIfCompletedRuntime();
				return;
			}

			const { data, error: apiError } = await flowRuntimeAPI.start({
				flow_kind: 'login',
				locale: getLocale(),
				authorization_challenge_id: authorizationChallengeId || undefined,
				saml_request_id: samlRequestId || undefined,
				saml_sp_entity_id: samlSpEntityId || undefined,
				return_to: returnTo || undefined,
				...getRuntimeTarget()
			});
			if (startSequence !== runtimeStartSequence) return;
			if (apiError) {
				failRuntimeStart(getApiErrorMessage(apiError), {
					blockAuthorizationChallenge: isAuthorizationChallengeRuntimeError(apiError)
				});
				return;
			}
			if (!data) return;
			runtimeFlow = data;
			runtimeAuthorizationChallengeBlocked = false;
			runtimeFlowStep = getRuntimeCurrentStep(data);
			if (
				data.interaction.state !== 'completed' &&
				data.interaction.current_step_id &&
				!runtimeFlowStep
			) {
				failRuntimeStart($LL.error_invalid_request());
				return;
			}
			await advanceRuntimePastNonRenderedSteps();
			await redirectIfCompletedRuntime();
		} catch {
			if (startSequence !== runtimeStartSequence) return;
			failRuntimeStart($LL.error_server_error());
		} finally {
			if (startSequence === runtimeStartSequence) runtimeFlowLoading = false;
		}
	}

	async function refreshRuntimeLocale(locale: string) {
		const flow = runtimeFlow;
		if (!flow || flow.interaction.state === 'completed') return;
		const normalizedLocale = normalizeLoginUILocale(locale);
		if (!normalizedLocale) return;
		const { data } = await flowRuntimeAPI.start({
			resume_interaction_id: flow.interaction.id,
			contract_hash: flow.contract_hash,
			signature: flow.signature,
			locale: normalizedLocale
		});
		if (!data) return;
		runtimeFlow = data;
		runtimeFlowStep = getRuntimeCurrentStep(data);
		persistFlowRuntimeState(data, { postAuthRedirect: pendingPostAuthRedirect });
	}

	async function submitRuntimeStep(selectedHandle?: string, input?: unknown): Promise<boolean> {
		const flow = runtimeFlow;
		const step = runtimeFlowStep ?? getRuntimeCurrentStep(flow);
		if (!flow || !step || flow.interaction.state === 'completed') {
			return true;
		}

		const { data, error: apiError } = await flowRuntimeAPI.submit(flow.interaction.id, {
			step_id: step.id,
			node_id: step.source_node_id,
			selected_handle: selectedHandle,
			contract_hash: flow.contract_hash,
			signature: flow.signature,
			input
		});
		if (apiError) {
			runtimeFlowError = getApiErrorMessage(apiError);
			return false;
		}
		if (!data) return false;

		runtimeFlow = {
			...flow,
			interaction: data.interaction
		};
		runtimeFlowStep = data.step ?? getRuntimeCurrentStep(runtimeFlow);
		if (data.completed) {
			runtimeFlowStep = null;
			const redirect = await resolveRuntimeCompletionRedirect(data.output);
			if (redirect) {
				pendingPostAuthRedirect = redirect;
			}
		} else if (!runtimeFlowStep) {
			runtimeFlowError = $LL.error_invalid_request();
			return false;
		}
		await advanceRuntimePastNonRenderedSteps();
		await refreshEmailVerificationProtocolChallenge();
		return true;
	}

	function hasInteractiveAccountActionUi(step: FlowRuntimeStep): boolean {
		return (
			step.config?.interaction_ui === true ||
			step.config?.render_ui === true ||
			typeof step.config?.screen_ref === 'string'
		);
	}

	function getRuntimeAutoSubmitHandle(step: FlowRuntimeStep): string | undefined | null {
		if (step.component === 'completion') return 'completed';
		if (step.component === 'account_action' && !hasInteractiveAccountActionUi(step)) {
			return 'completed';
		}
		if (step.render === false) return undefined;
		return null;
	}

	async function advanceRuntimePastNonRenderedSteps() {
		let guard = 0;
		while (runtimeFlow && runtimeFlowStep && guard < 10) {
			const autoSubmitHandle = getRuntimeAutoSubmitHandle(runtimeFlowStep);
			if (autoSubmitHandle === null) return;
			guard += 1;
			const ok = await submitRuntimeStep(autoSubmitHandle);
			if (!ok) return;
		}
	}

	async function redirectIfCompletedRuntime(): Promise<boolean> {
		if (runtimeFlow?.interaction.state !== 'completed') return false;
		const redirect = pendingPostAuthRedirect || (await buildPostAuthRedirect());
		consumeFlowRuntimeState(runtimeFlow.interaction.id);
		window.location.href = redirect;
		return true;
	}

	async function continueAfterRuntimeStep(
		selectedHandle: string,
		redirectUrl?: string,
		input?: unknown
	): Promise<boolean> {
		if (!runtimeFlow) return true;
		const ok = await submitRuntimeStep(selectedHandle, input);
		if (!ok) return false;
		if (runtimeFlow?.interaction.state !== 'completed') {
			pendingPostAuthRedirect = await buildPostAuthRedirect(redirectUrl);
			return false;
		}
		return true;
	}

	async function completeRuntimeOnlyStep(selectedHandle: string, input?: unknown) {
		if (!runtimeFlow || authActionLoading) return;
		runtimeFlowLoading = true;
		try {
			const ok = await submitRuntimeStep(selectedHandle, input);
			if (!ok) return;
			await redirectIfCompletedRuntime();
		} finally {
			runtimeFlowLoading = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
	function validateEmail(value: string): boolean {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	}

	function stopMailOtpResendTimer() {
		if (mailOtpResendTimer !== null) {
			window.clearInterval(mailOtpResendTimer);
			mailOtpResendTimer = null;
		}
	}

	function startMailOtpResendTimer() {
		stopMailOtpResendTimer();
		mailOtpResendRemaining = MAIL_OTP_RESEND_SECONDS;
		mailOtpResendTimer = window.setInterval(() => {
			mailOtpResendRemaining = Math.max(0, mailOtpResendRemaining - 1);
			if (mailOtpResendRemaining <= 0) {
				stopMailOtpResendTimer();
			}
		}, 1000);
	}

	function runtimeStepHasCodeInputWidget(step: FlowRuntimeStep | null): boolean {
		const screen = getRuntimeScreen(step);
		const fields = screen?.fields;
		return (
			Array.isArray(fields) &&
			fields.some(
				(field) =>
					field &&
					typeof field === 'object' &&
					(field as Record<string, unknown>).block_type === 'code_input_widget'
			)
		);
	}

	function getRuntimeCodeInputSuccessHandle(step: FlowRuntimeStep | null): string {
		if (step?.component === 'email_verification') return 'verified';
		if (step?.component === 'screen') return 'submitted';
		return getRuntimeScreenContinueHandle(step);
	}

	function getRuntimeCodeInputBackHandle(step: FlowRuntimeStep | null): string {
		if (step?.component === 'email_verification') return 'failed';
		if (step?.component === 'screen') return 'skipped';
		return 'failed';
	}

	function getApiErrorMessage(apiError: Parameters<typeof messageForApiError>[0]): string {
		return messageForApiError(apiError, {
			unknown: () => $LL.error_unknown(),
			invalidRequest: () => $LL.error_invalid_request(),
			accessDenied: () => $LL.error_access_denied(),
			unauthorizedClient: () => $LL.error_unauthorized_client(),
			unsupportedResponseType: () => $LL.error_unsupported_response_type(),
			invalidScope: () => $LL.error_invalid_scope(),
			serverError: () => $LL.error_server_error(),
			temporarilyUnavailable: () => $LL.error_temporarily_unavailable(),
			loginRequired: () => $LL.error_login_required(),
			emailCodeInvalid: () => $LL.emailCode_errorInvalid()
		});
	}

	function getTurnstileToken(target: string): string | undefined {
		if (!turnstileRequired) return undefined;
		if (!turnstileToken) {
			activeTurnstileTarget = target;
			pendingTurnstileTarget = target;
			return undefined;
		}
		activeTurnstileTarget = null;
		pendingTurnstileTarget = null;
		return turnstileToken;
	}

	function resetHumanVerificationToken() {
		if (!turnstileRequired) return;
		turnstileToken = '';
		pendingTurnstileTarget = null;
		activeTurnstileTarget = null;
		turnstileResetKey += 1;
	}

	function markHumanVerificationTokenSubmitted(token: string | undefined) {
		if (!token) return;
		resetHumanVerificationToken();
	}

	function showTurnstileFor(target: string): boolean {
		return turnstileRequired && Boolean(turnstileSiteKey) && activeTurnstileTarget === target;
	}

	function resumeTurnstileTarget(target: string) {
		if (target === 'passkey') {
			void handlePasskeyLogin();
			return;
		}
		if (target === 'email-code') {
			void handleEmailCodeSend();
			return;
		}
		if (target === 'directory-password') {
			void handleDirectoryPasswordLogin();
			return;
		}
		if (target.startsWith('external:')) {
			const providerId = target.slice('external:'.length);
			const provider = externalProviders.find((candidate) => candidate.id === providerId);
			if (provider) {
				void handleExternalLogin(provider);
			}
		}
	}

	$effect(() => {
		if (!turnstileToken || !pendingTurnstileTarget) return;
		const target = pendingTurnstileTarget;
		pendingTurnstileTarget = null;
		queueMicrotask(() => resumeTurnstileTarget(target));
	});

	async function resolveAccountReturnRedirect(): Promise<string | null> {
		if (!accountReturn) return null;
		const result = await accountAPI.consumeAccountReturn(accountReturn);
		const redirectUrl = result.data?.redirect_url;
		return redirectUrl && isValidReturnUrl(redirectUrl) ? redirectUrl : null;
	}

	async function buildPostAuthRedirect(redirectUrl?: string): Promise<string> {
		if (returnTo === 'saml_sso' && samlRequestId && samlSpEntityId) {
			const params = new SvelteURLSearchParams({
				saml_request_id: samlRequestId,
				saml_sp_entity_id: samlSpEntityId,
				return_to: 'saml_sso'
			});
			return `/saml/idp/sso?${params.toString()}`;
		}

		const accountReturnRedirect = await resolveAccountReturnRedirect();
		if (accountReturnRedirect) {
			return accountReturnRedirect;
		}

		if (returnTo && isValidReturnUrl(returnTo)) {
			return returnTo;
		}

		if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
			return redirectUrl;
		}

		return '/';
	}

	function shouldDeferAuthorizationContinuation(): boolean {
		return Boolean(runtimeFlow && runtimeFlow.interaction.state !== 'completed');
	}

	async function buildCompletedAuthRedirect(redirectUrl?: string): Promise<string> {
		return pendingPostAuthRedirect || (await buildPostAuthRedirect(redirectUrl));
	}

	function readRuntimeContinuationString(
		continuation: Record<string, unknown> | undefined,
		key: string
	): string {
		const value = continuation?.[key];
		return typeof value === 'string' ? value : '';
	}

	async function resolveRuntimeCompletionRedirect(
		output: {
			action: string;
			protocol_continuation?: Record<string, unknown>;
			redirect_url?: string;
		} | null
	): Promise<string | null> {
		if (output?.redirect_url && isValidRedirectUrl(output.redirect_url)) {
			return output.redirect_url;
		}
		const continuation = output?.protocol_continuation;
		const protocol = readRuntimeContinuationString(continuation, 'protocol');
		if (protocol === 'saml') {
			const requestId =
				readRuntimeContinuationString(continuation, 'saml_request_id') || samlRequestId;
			const spEntityId =
				readRuntimeContinuationString(continuation, 'saml_sp_entity_id') ||
				readRuntimeContinuationString(continuation, 'saml_sp_id') ||
				samlSpEntityId;
			if (requestId && spEntityId) {
				const params = new SvelteURLSearchParams({
					saml_request_id: requestId,
					saml_sp_entity_id: spEntityId,
					return_to: 'saml_sso'
				});
				return `/saml/idp/sso?${params.toString()}`;
			}
		}
		if (protocol === 'direct' || output?.action === 'complete') {
			return buildPostAuthRedirect();
		}
		return null;
	}

	function getPasskeyProgressMessage(phase: PasskeyProgressPhase): string {
		switch (phase) {
			case 'preparing':
				return $LL.login_passkeyPreparing();
			case 'waiting':
				return $LL.login_passkeyPrompt();
			case 'finishing':
				return $LL.login_passkeyVerifying();
			default:
				return '';
		}
	}

	async function handlePasskeyLogin() {
		if (authActionLoading) return;
		error = '';
		if (!ensureAuthorizationChallengeCanContinue()) return;
		passkeyLoading = true;
		passkeyProgress = 'preparing';

		try {
			const cfTurnstileResponse = getTurnstileToken('passkey');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const { data: optionsData, error: optionsError } = await passkeyAPI.getLoginOptions({
				authorizationChallengeId: authorizationChallengeId || undefined,
				human_verification_response: cfTurnstileResponse
			});
			if (optionsError) {
				throw loginUiDisplayError(getApiErrorMessage(optionsError));
			}
			if (!optionsData?.options) {
				throw loginUiDisplayError($LL.error_server_error());
			}
			markHumanVerificationTokenSubmitted(cfTurnstileResponse);

			passkeyProgress = 'waiting';
			const credential = await startAuthentication({ optionsJSON: optionsData.options });

			passkeyProgress = 'finishing';
			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyLogin({
				challengeId: optionsData.challengeId,
				credential,
				authorizationChallengeId: authorizationChallengeId || undefined,
				deferAuthorizationContinuation: shouldDeferAuthorizationContinuation()
			});

			if (verifyError) {
				if (shouldSignalUnknownCredentialAfterLoginFailure(verifyError)) {
					await signalUnknownCredential(credential.id);
				}
				throw loginUiDisplayError(getApiErrorMessage(verifyError));
			}

			await auth.refreshFromSession();

			const continueRedirect = await continueAfterRuntimeStep(
				'passkey',
				verifyData?.redirect_url,
				getRuntimeStepSubmitInputForAuthenticatedAction()
			);
			if (!continueRedirect) return;
			window.location.href = await buildCompletedAuthRedirect(verifyData?.redirect_url);
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			passkeyLoading = false;
			passkeyProgress = 'idle';
		}
	}

	async function handleEmailCodeSend(
		options: {
			genericInvalidEmail?: boolean;
			skipRuntimeStep?: boolean;
			emailVerification?: {
				token: string;
				challengeId: string;
				interactionId: string;
			};
		} = {}
	) {
		if (authActionLoading) return;
		error = '';
		if (!ensureAuthorizationChallengeCanContinue()) return;

		if (!email.trim()) {
			error = options.genericInvalidEmail
				? $LL.error_invalid_request()
				: $LL.login_errorEmailRequired();
			return;
		}
		if (!validateEmail(email)) {
			error = options.genericInvalidEmail
				? $LL.error_invalid_request()
				: $LL.login_errorEmailInvalid();
			return;
		}

		emailCodeLoading = true;
		try {
			const cfTurnstileResponse = options.skipRuntimeStep ? '' : getTurnstileToken('email-code');
			if (turnstileRequired && !cfTurnstileResponse && !options.skipRuntimeStep) return;
			const { data: sendData, error: apiError } = await emailCodeAPI.send({
				email,
				authorizationChallengeId: authorizationChallengeId || undefined,
				human_verification_response: cfTurnstileResponse || undefined,
				deferAuthorizationContinuation: shouldDeferAuthorizationContinuation(),
				runtimeInteractionId: runtimeFlow?.interaction.id,
				emailVerification: options.emailVerification
			});
			if (apiError) {
				throw loginUiDisplayError(getApiErrorMessage(apiError));
			}
			if (cfTurnstileResponse) markHumanVerificationTokenSubmitted(cfTurnstileResponse);
			if (sendData && 'verified' in sendData && sendData.verified) {
				const verifiedRedirectUrl =
					'redirect_url' in sendData && typeof sendData.redirect_url === 'string'
						? sendData.redirect_url
						: undefined;
				emailVerificationChallenge = null;
				await auth.refreshFromSession();
				if (runtimeFlow && !options.skipRuntimeStep) {
					if (
						runtimeFlowStep?.component === 'authentication_method_selector' ||
						runtimeFlowStep?.component === 'registration_method_selector'
					) {
						if (!(await submitRuntimeStep('mail_otp'))) return;
					}
					if (runtimeFlowStep?.component === 'email_verification') {
						if (!(await submitRuntimeStep('verified'))) return;
					}
					if (runtimeFlow?.interaction.state !== 'completed') {
						pendingPostAuthRedirect = await buildPostAuthRedirect(verifiedRedirectUrl);
						return;
					}
				}
				window.location.href = await buildCompletedAuthRedirect(verifiedRedirectUrl);
				return;
			}
			emailVerificationChallenge = null;
			mailOtpSent = true;
			mailOtpCode = '';
			startMailOtpResendTimer();
			const params = new SvelteURLSearchParams({ email });
			if (authorizationChallengeId) {
				params.set('challenge_id', authorizationChallengeId);
			}
			if (accountReturn) {
				params.set('account_return', accountReturn);
			}
			if (returnTo && isValidReturnUrl(returnTo)) {
				params.set('return_to', returnTo);
			}
			if (returnTo === 'saml_sso' && samlRequestId && samlSpEntityId) {
				params.set('saml_request_id', samlRequestId);
				params.set('saml_sp_entity_id', samlSpEntityId);
				params.set('return_to', 'saml_sso');
			}
			if (runtimeFlow && !options.skipRuntimeStep) {
				const ok = await submitRuntimeStep('mail_otp');
				if (!ok) return;
				if (runtimeStepHasCodeInputWidget(runtimeFlowStep)) {
					return;
				}
				const flowAfterSelection = runtimeFlow;
				if (!flowAfterSelection || !persistFlowRuntimeState(flowAfterSelection)) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				params.set('runtime_interaction_id', flowAfterSelection.interaction.id);
				params.set('runtime_flow_kind', 'login');
			}
			window.location.href = `/verify-email-code?${params.toString()}`;
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			emailCodeLoading = false;
		}
	}

	async function handleMailOtpInlineVerify() {
		if (authActionLoading) return;
		error = '';
		if (!ensureAuthorizationChallengeCanContinue()) return;
		const code = mailOtpCode.trim().replace(/\s+/g, '');
		if (!/^\d{6}$/.test(code)) {
			error = $LL.emailCode_errorInvalid();
			return;
		}
		if (!email.trim() || !validateEmail(email)) {
			error = $LL.error_invalid_request();
			return;
		}

		emailCodeLoading = true;
		try {
			const { data, error: apiError } = await emailCodeAPI.verify({
				code,
				email,
				authorizationChallengeId: authorizationChallengeId || undefined,
				deferAuthorizationContinuation: shouldDeferAuthorizationContinuation()
			});
			if (apiError) {
				error = getApiErrorMessage(apiError);
				mailOtpCode = '';
				return;
			}
			await auth.refreshFromSession();
			const continueRedirect = await continueAfterRuntimeStep(
				getRuntimeCodeInputSuccessHandle(runtimeFlowStep),
				data?.redirect_url,
				getRuntimeStepSubmitInputForAuthenticatedAction()
			);
			if (!continueRedirect) return;
			window.location.href = await buildCompletedAuthRedirect(data?.redirect_url);
		} catch (err) {
			error = messageForCaughtError(err, $LL.emailCode_errorInvalid());
			mailOtpCode = '';
		} finally {
			emailCodeLoading = false;
		}
	}

	async function handleMailOtpInlineResend() {
		if (mailOtpResendRemaining > 0) return;
		await handleEmailCodeSend({ genericInvalidEmail: true, skipRuntimeStep: true });
	}

	async function handleCodeInputBack() {
		if (authActionLoading) return;
		error = '';
		mailOtpCode = '';
		mailOtpSent = false;
		totpCode = '';
		totpChallengeId = '';
		totpCodeRequested = false;
		stopMailOtpResendTimer();
		if (runtimeFlow && runtimeFlowStep) {
			const ok = await submitRuntimeStep(getRuntimeCodeInputBackHandle(runtimeFlowStep));
			if (!ok) return;
			await refreshEmailVerificationProtocolChallenge(true);
		}
	}

	async function handleTotpStart() {
		if (authActionLoading) return;
		error = '';
		if (!ensureAuthorizationChallengeCanContinue()) return;

		const identifier = totpIdentifier.trim();
		if (!identifier) {
			error = $LL.login_totpIdentifierRequired();
			return;
		}

		totpLoading = true;
		try {
			const { data, error: apiError } = await totpAPI.startLogin({ identifier });
			if (apiError || !data) {
				throw loginUiDisplayError(apiError ? getApiErrorMessage(apiError) : $LL.error_unknown());
			}
			totpChallengeId = data.challenge_id;
			totpCode = '';
			totpCodeRequested = true;
			if (runtimeFlow) {
				const ok = await submitRuntimeStep('totp');
				if (!ok) return;
				if (!runtimeStepHasCodeInputWidget(runtimeFlowStep)) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.login_totpStartFailed());
		} finally {
			totpLoading = false;
		}
	}

	async function handleTotpVerify() {
		if (authActionLoading) return;
		error = '';
		if (!ensureAuthorizationChallengeCanContinue()) return;

		const code = totpCode.trim().replace(/\s+/g, '');
		if (!totpChallengeId) {
			totpCodeRequested = false;
			error = $LL.login_totpIdentifierRequired();
			return;
		}
		if (!/^\d{6}$|^\d{8}$/.test(code)) {
			error = $LL.login_totpCodeInvalid();
			return;
		}

		totpLoading = true;
		try {
			const { data, error: apiError } = await totpAPI.verifyLogin({
				challengeId: totpChallengeId,
				code,
				authorizationChallengeId: authorizationChallengeId || undefined,
				deferAuthorizationContinuation: shouldDeferAuthorizationContinuation()
			});
			if (apiError || !data?.success) {
				throw loginUiDisplayError(
					apiError ? getApiErrorMessage(apiError) : $LL.login_totpCodeInvalid()
				);
			}
			await auth.refreshFromSession();
			const redirectUrl = data.redirect_url;
			const continueRedirect = await continueAfterRuntimeStep(
				runtimeStepHasCodeInputWidget(runtimeFlowStep)
					? getRuntimeCodeInputSuccessHandle(runtimeFlowStep)
					: 'totp',
				redirectUrl,
				getRuntimeStepSubmitInputForAuthenticatedAction()
			);
			if (!continueRedirect) return;
			window.location.href = await buildCompletedAuthRedirect(redirectUrl);
		} catch (err) {
			error = messageForCaughtError(err, $LL.login_totpCodeInvalid());
		} finally {
			totpLoading = false;
		}
	}

	async function handleDirectoryPasswordLogin() {
		if (authActionLoading) return;
		error = '';
		if (!ensureAuthorizationChallengeCanContinue()) return;
		directoryMigrationNotice = '';
		directoryMigrationTransaction = null;
		directoryRecoveryTransaction = null;

		const username = directoryUsername.trim();
		if (!username) {
			error = $LL.login_errorDirectoryUsernameRequired();
			return;
		}
		if (!directoryPassword) {
			error = $LL.login_errorDirectoryPasswordRequired();
			return;
		}

		directoryPasswordLoading = true;
		try {
			const cfTurnstileResponse = getTurnstileToken('directory-password');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const { data, error: apiError } = await directoryPasswordAPI.login({
				username,
				password: directoryPassword,
				inviteToken: inviteToken || undefined,
				authorizationChallengeId: authorizationChallengeId || undefined,
				deferAuthorizationContinuation: shouldDeferAuthorizationContinuation(),
				human_verification_response: cfTurnstileResponse
			});
			if (apiError) {
				if (apiError.error === 'invalid_credentials') {
					throw loginUiDisplayError($LL.login_errorDirectoryInvalidCredentials());
				}
				if (apiError.error === 'connector_unavailable') {
					throw loginUiDisplayError($LL.login_errorDirectoryUnavailable());
				}
				if (apiError.error === 'directory_identity_unmapped') {
					throw loginUiDisplayError($LL.login_errorDirectoryUnmapped());
				}
				throw loginUiDisplayError(getApiErrorMessage(apiError));
			}
			markHumanVerificationTokenSubmitted(cfTurnstileResponse);
			if (data && 'migration' in data && data.migration?.required) {
				directoryPassword = '';
				directoryMigrationEmailChallengeId = '';
				directoryMigrationEmailCode = '';
				directoryMigrationTransaction =
					data.migration.transaction_id && data.migration.transaction_token
						? {
								transactionId: data.migration.transaction_id,
								transactionToken: data.migration.transaction_token,
								userName: data.user?.name || data.user?.email,
								emailFallback: data.migration.email_code_fallback
									? {
											transactionId: data.migration.email_code_fallback.transaction_id,
											transactionToken: data.migration.email_code_fallback.transaction_token,
											maskedEmail: data.migration.email_code_fallback.masked_email
										}
									: undefined
							}
						: null;
				directoryMigrationNotice = $LL.login_directoryMigrationPasskeyRequired();
				return;
			}
			if (data && 'recovery' in data && data.recovery?.required) {
				directoryPassword = '';
				directoryMigrationEmailChallengeId = '';
				directoryMigrationEmailCode = '';
				directoryMigrationTransaction = null;
				directoryRecoveryTransaction = {
					transactionId: data.recovery.transaction_id,
					transactionToken: data.recovery.transaction_token,
					maskedEmail: data.recovery.masked_email
				};
				directoryMigrationNotice = $LL.login_directoryRecoveryRequired();
				return;
			}

			await auth.refreshFromSession();
			const redirectUrl = data && 'redirect_url' in data ? data.redirect_url : undefined;
			const continueRedirect = await continueAfterRuntimeStep(
				'directory_password',
				redirectUrl,
				getRuntimeStepSubmitInputForAuthenticatedAction()
			);
			if (!continueRedirect) return;
			window.location.href = await buildCompletedAuthRedirect(redirectUrl);
		} catch (err) {
			error = messageForCaughtError(err, $LL.login_errorDirectoryFailed());
		} finally {
			directoryPasswordLoading = false;
		}
	}

	async function handleDirectoryMigrationPasskeyRegistration() {
		if (!directoryMigrationTransaction || authActionLoading) return;
		error = '';
		directoryMigrationPasskeyLoading = true;
		try {
			const { data: optionsData, error: optionsError } =
				await directoryPasswordAPI.migrationPasskeyOptions({
					transactionId: directoryMigrationTransaction.transactionId,
					transactionToken: directoryMigrationTransaction.transactionToken,
					displayName: directoryMigrationTransaction.userName || undefined
				});
			if (optionsError || !optionsData) {
				throw loginUiDisplayError(
					optionsError ? getApiErrorMessage(optionsError) : $LL.error_unknown()
				);
			}
			const credential = await startRegistration({ optionsJSON: optionsData.options });
			const { data, error: verifyError } = await directoryPasswordAPI.migrationPasskeyVerify({
				transactionId: directoryMigrationTransaction.transactionId,
				transactionToken: directoryMigrationTransaction.transactionToken,
				challengeId: optionsData.challenge_id,
				credential,
				deviceName: $LL.login_directoryMigrationPasskeyName()
			});
			if (verifyError || !data) {
				throw loginUiDisplayError(
					verifyError ? getApiErrorMessage(verifyError) : $LL.error_unknown()
				);
			}
			directoryMigrationTransaction = null;
			directoryMigrationEmailChallengeId = '';
			directoryMigrationEmailCode = '';
			directoryMigrationNotice = '';
			await auth.refreshFromSession();
			const redirectUrl = 'redirect_url' in data ? data.redirect_url : undefined;
			window.location.href = await buildPostAuthRedirect(redirectUrl);
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			directoryMigrationPasskeyLoading = false;
		}
	}

	async function handleDirectoryMigrationEmailCodeSend() {
		const fallback = directoryMigrationTransaction?.emailFallback ?? directoryRecoveryTransaction;
		if (!fallback || authActionLoading) return;
		error = '';
		directoryMigrationEmailLoading = true;
		try {
			const { data, error: apiError } = await directoryPasswordAPI.migrationEmailCodeSend({
				transactionId: fallback.transactionId,
				transactionToken: fallback.transactionToken
			});
			if (apiError || !data) {
				throw loginUiDisplayError(apiError ? getApiErrorMessage(apiError) : $LL.error_unknown());
			}
			directoryMigrationEmailChallengeId = data.challenge_id;
			directoryMigrationEmailCode = '';
			directoryMigrationNotice = $LL.login_directoryVerificationCodeSent({
				email: data.masked_email
			});
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			directoryMigrationEmailLoading = false;
		}
	}

	async function handleDirectoryMigrationEmailCodeVerify() {
		const fallback = directoryMigrationTransaction?.emailFallback ?? directoryRecoveryTransaction;
		if (!fallback || !directoryMigrationEmailChallengeId || authActionLoading) return;
		const code = directoryMigrationEmailCode.trim();
		if (!/^\d{6}$/.test(code)) {
			error = $LL.emailCode_errorInvalid();
			return;
		}
		error = '';
		directoryMigrationEmailLoading = true;
		try {
			const { data, error: apiError } = await directoryPasswordAPI.migrationEmailCodeVerify({
				transactionId: fallback.transactionId,
				transactionToken: fallback.transactionToken,
				challengeId: directoryMigrationEmailChallengeId,
				code
			});
			if (apiError || !data) {
				throw loginUiDisplayError(apiError ? getApiErrorMessage(apiError) : $LL.error_unknown());
			}
			directoryMigrationTransaction = null;
			directoryRecoveryTransaction = null;
			directoryMigrationEmailChallengeId = '';
			directoryMigrationEmailCode = '';
			directoryMigrationNotice = '';
			await auth.refreshFromSession();
			const redirectUrl = 'redirect_url' in data ? data.redirect_url : undefined;
			window.location.href = await buildPostAuthRedirect(redirectUrl);
		} catch (err) {
			error = messageForCaughtError(err, $LL.emailCode_errorInvalid());
		} finally {
			directoryMigrationEmailLoading = false;
		}
	}

	async function handleExternalLogin(provider: ExternalProvider) {
		const providerId = provider.id;
		if (authActionLoading) return;
		if (!ensureAuthorizationChallengeCanContinue()) return;
		const cfTurnstileResponse = getTurnstileToken(`external:${providerId}`);
		if (turnstileRequired && !cfTurnstileResponse) return;
		externalIdpLoading = providerId;
		try {
			const accountReturnRedirect = await resolveAccountReturnRedirect();
			if (accountReturnRedirect && provider.startMode !== 'saml_sp') {
				setLoginUiSessionItem(
					LOGIN_UI_SESSION_STORAGE_KEYS.externalReturnUrl,
					accountReturnRedirect
				);
			}
			let runtimeResumeUrl: string | null = null;
			if (runtimeFlow) {
				const ok = await submitRuntimeStep(providerId);
				if (!ok) return;
				const flowAfterSelection = runtimeFlow;
				const postAuthRedirect =
					provider.startMode === 'saml_sp'
						? accountReturnRedirect || (await buildPostAuthRedirect())
						: null;
				if (
					!flowAfterSelection ||
					!persistFlowRuntimeState(flowAfterSelection, { postAuthRedirect })
				) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				runtimeResumeUrl = `/login?runtime_interaction_id=${encodeURIComponent(
					flowAfterSelection.interaction.id
				)}`;
				setLoginUiSessionItem(
					LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId,
					flowAfterSelection.interaction.id
				);
				setLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeKind, 'login');
			}
			const redirectUri =
				provider.startMode === 'saml_sp' && runtimeResumeUrl
					? `${window.location.origin}${runtimeResumeUrl}`
					: provider.startMode === 'saml_sp'
						? `${window.location.origin}/`
						: `${window.location.origin}/callback`;
			const { url } = await externalIdpAPI.startLogin(
				providerId,
				redirectUri,
				provider.startUrl,
				provider.startMode,
				turnstileRequired ? { token: cfTurnstileResponse } : undefined
			);

			if (!isValidRedirectUrl(url)) {
				throw loginUiDisplayError($LL.error_invalid_request());
			}
			markHumanVerificationTokenSubmitted(cfTurnstileResponse);

			// Provider ID is diagnostic-only; the managed LoginUI flow does not store PKCE secrets.
			try {
				setLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId, providerId);
			} catch (storageError) {
				console.warn('Failed to store external provider diagnostic state:', storageError);
			}

			// Redirect to external IdP
			window.location.href = url;
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
			externalIdpLoading = null;
		}
	}

	function getProviderIcon(provider: ExternalProvider): string {
		return getExternalProviderIconClass(provider);
	}

	function getProviderButtonText(provider: ExternalProvider): string {
		if (provider.buttonText) return provider.buttonText;
		return $LL.login_continueWith({ provider: provider.name });
	}

	function getRuntimeStepTitle(step: FlowRuntimeStep): string {
		const title = step.content?.title ?? step.config?.title;
		return typeof title === 'string' && title.trim() ? title : step.component.replace(/_/g, ' ');
	}

	function getRuntimeStepDescription(step: FlowRuntimeStep): string {
		const description = step.content?.description ?? step.config?.description;
		return typeof description === 'string' ? description : '';
	}

	function getRuntimeScreen(step: FlowRuntimeStep | null): Record<string, unknown> | null {
		const screen = step?.config?.screen ?? step?.content?.screen;
		return screen && typeof screen === 'object' && !Array.isArray(screen)
			? (screen as Record<string, unknown>)
			: null;
	}

	function isRuntimeScreenWide(screen: Record<string, unknown> | null): boolean {
		const settings = screen?.settings;
		return (
			settings !== null &&
			typeof settings === 'object' &&
			!Array.isArray(settings) &&
			(settings as Record<string, unknown>).canvas_layout === 'wide'
		);
	}

	function getRuntimeConsentPolicy(
		step: FlowRuntimeStep | null
	): FlowRuntimeConsentPolicyContent | null {
		const policy = step?.content?.consent_policy;
		if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
		const items = (policy as FlowRuntimeConsentPolicyContent).items;
		return Array.isArray(items) ? (policy as FlowRuntimeConsentPolicyContent) : null;
	}

	function getRuntimeDestinationFieldConsent(
		step: FlowRuntimeStep | null
	): FlowRuntimeDestinationFieldConsentContent | null {
		const consent = step?.content?.destination_field_consent;
		if (!consent || typeof consent !== 'object' || Array.isArray(consent)) return null;
		const fields = (consent as FlowRuntimeDestinationFieldConsentContent).fields;
		return Array.isArray(fields) ? (consent as FlowRuntimeDestinationFieldConsentContent) : null;
	}

	function getRuntimeConsentItemDecisionPayload() {
		const policy = getRuntimeConsentPolicy(runtimeFlowStep);
		return {
			consent_item_decisions: Object.fromEntries(
				(policy?.items ?? []).map((item) => [
					item.statement_id,
					item.content_mode === 'radio'
						? runtimeConsentSelectedValues[item.statement_id]
							? 'selected'
							: 'denied'
						: item.checkbox_mode === 'none' || runtimeConsentDecisions[item.statement_id]
							? 'granted'
							: 'denied'
				])
			),
			consent_item_selected_values: Object.fromEntries(
				(policy?.items ?? [])
					.filter((item) => item.content_mode === 'radio')
					.map((item) => [item.statement_id, runtimeConsentSelectedValues[item.statement_id] || ''])
			),
			destination_field_decisions: runtimeDestinationFieldDecisions
		};
	}

	function getRuntimeStepSubmitInputForAuthenticatedAction() {
		return getRuntimeConsentPolicy(runtimeFlowStep) ||
			getRuntimeDestinationFieldConsent(runtimeFlowStep)
			? getRuntimeConsentItemDecisionPayload()
			: undefined;
	}

	function getRuntimeConsentItemHtml(
		item: FlowRuntimeConsentPolicyContent['items'][number]
	): string {
		if (item.inline_content) return sanitizeRuntimeConsentHtml(item.inline_content);
		const fallback = item.description
			? `<strong>${item.title}</strong><br>${item.description}`
			: item.title;
		return sanitizeRuntimeConsentHtml(fallback);
	}

	function getRuntimeConsentOptionHtml(
		option: NonNullable<FlowRuntimeConsentPolicyContent['items'][number]['options']>[number]
	): string {
		const body = option.description || option.label || option.value;
		return sanitizeRuntimeConsentHtml(body);
	}

	function canSubmitRuntimeConsent(): boolean {
		const policy = getRuntimeConsentPolicy(runtimeFlowStep);
		const policyReady =
			!policy ||
			policy.items.every(
				(item) =>
					!item.is_required ||
					(item.content_mode === 'radio' &&
						Boolean(runtimeConsentSelectedValues[item.statement_id])) ||
					item.checkbox_mode === 'none' ||
					runtimeConsentDecisions[item.statement_id] === true
			);
		const destinationConsent = getRuntimeDestinationFieldConsent(runtimeFlowStep);
		const destinationReady =
			!destinationConsent ||
			destinationConsent.fields.every(
				(field) => !field.required || runtimeDestinationFieldDecisions[field.key] === true
			);
		return policyReady && destinationReady;
	}

	function shouldRenderRuntimeStep(step: FlowRuntimeStep): boolean {
		return !isRuntimeAuthStep(step) || Boolean(getRuntimeScreen(step));
	}

	function getRuntimeScreenContinueHandle(step: FlowRuntimeStep | null): string {
		if (step?.component === 'consent_policy') return 'accepted';
		if (step?.component === 'screen') return 'submitted';
		return 'completed';
	}

	function runtimeAllowsAuthenticationHandle(handle: string, aliases: string[] = []): boolean {
		return runtimeStepAllowsAuthenticationHandle(runtimeFlowStep, handle, aliases);
	}

	function runtimeAllowsExternalProvider(provider: ExternalProvider): boolean {
		return runtimeStepAllowsExternalProvider(runtimeFlowStep, provider);
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			if (emailVerificationChallenge) return;
			handleEmailCodeSend();
		}
	}

	function handleDirectoryKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			handleDirectoryPasswordLogin();
		}
	}

	function handleTotpKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			if (totpCodeRequested) {
				handleTotpVerify();
			} else {
				handleTotpStart();
			}
		}
	}

	function handleRuntimeScreenFieldValueChange(field: string, value: string | boolean) {
		const stringValue = typeof value === 'string' ? value : value ? 'true' : 'false';
		const normalized = field.toLowerCase();
		if (normalized === 'email' || normalized.endsWith('.email')) {
			email = stringValue;
			combinedIdentifier = stringValue;
			return;
		}
		if (normalized === 'totp_identifier' || normalized === 'identifier') {
			totpIdentifier = stringValue;
			email = stringValue;
			combinedIdentifier = stringValue;
			return;
		}
		if (normalized === 'mail_otp_code') {
			mailOtpCode = stringValue;
			return;
		}
		if (normalized === 'totp_code') {
			totpCode = stringValue;
			return;
		}
		if (normalized === 'directory_username' || normalized === 'username') {
			directoryUsername = stringValue;
			return;
		}
		if (normalized === 'directory_password' || normalized === 'password') {
			directoryPassword = stringValue;
		}
	}

	function handleRuntimeScreenAuthAction(method: RuntimeAuthMethod, action?: string) {
		if (action === 'back') {
			void handleCodeInputBack();
			return;
		}
		if (method === 'passkey') {
			void handlePasskeyLogin();
			return;
		}
		if (method === 'mail_otp') {
			if (action === 'verify_code') {
				void handleMailOtpInlineVerify();
				return;
			}
			if (action === 'resend_mail_otp') {
				void handleMailOtpInlineResend();
				return;
			}
			void handleEmailCodeSend({ genericInvalidEmail: action === 'send_mail_otp' });
			return;
		}
		if (method === 'totp') {
			if (action === 'verify_code' || (totpCodeRequested && action !== 'start_totp')) {
				void handleTotpVerify();
			} else {
				void handleTotpStart();
			}
			return;
		}
		if (method === 'directory_password') {
			void handleDirectoryPasswordLogin();
		}
	}

	function handleRuntimeExternalProviderAction(providerId: string) {
		const provider = visibleExternalProviders.find((candidate) => candidate.id === providerId);
		if (provider) {
			void handleExternalLogin(provider);
		}
	}

	function setRuntimeConsentDecision(statementId: string, checked: boolean) {
		runtimeConsentDecisions = {
			...runtimeConsentDecisions,
			[statementId]: checked
		};
	}

	function setRuntimeConsentSelectedValue(statementId: string, value: string) {
		runtimeConsentSelectedValues = {
			...runtimeConsentSelectedValues,
			[statementId]: value
		};
	}

	function setRuntimeDestinationFieldDecision(fieldKey: string, checked: boolean) {
		runtimeDestinationFieldDecisions = {
			...runtimeDestinationFieldDecisions,
			[fieldKey]: checked
		};
	}
</script>

<svelte:head>
	<title
		>{localizedLoginTitle || $LL.login_title()} - {brandingStore.brandName ||
			$LL.app_title()}</title
	>
	<meta name="description" content={$LL.login_metaDescription()} />
</svelte:head>

<div
	class="auth-page"
	class:auth-page--entry-motion={entryMotionEnabled}
	class:auth-page--has-footer={loginUIPageStore.footerEnabled}
>
	<div class="auth-main">
		{#if loginUIPageStore.showTopbar && loginUIPageStore.topbarPosition !== 'in_card'}
			<LanguageSwitcher
				showThemeToggle={loginUIPageStore.themeToggleEnabled}
				showLanguageSelect={loginUIPageStore.languageSelectEnabled}
			/>
		{/if}

		{#if loginUIPageStore.showBrandPanel}
			<aside class="auth-brand-panel" aria-hidden="true">
				<div class="auth-brand-panel__content">
					{#if showBrandLogo && brandingStore.logoUrl}
						<img
							src={brandingStore.logoUrl}
							alt=""
							class="auth-brand-panel__logo"
							onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
						/>
					{/if}
					{#if loginUIPageStore.brandContentMode === 'logo_copy'}
						<p class="auth-brand-panel__eyebrow">{brandingStore.brandName || $LL.app_title()}</p>
						{#if localizedBrandPanelTitle}
							<h2>{localizedBrandPanelTitle}</h2>
						{/if}
						{#if localizedBrandPanelText}
							<p>{localizedBrandPanelText}</p>
						{/if}
					{:else if !showBrandLogo}
						<h2>{brandingStore.brandName || $LL.app_title()}</h2>
					{/if}
				</div>
			</aside>
		{/if}

		<div class="auth-container" class:auth-container--wide={runtimeScreenWide}>
			{#if loginUIPageStore.headerEnabled}
				<header class="auth-header">
					{#if showBrandLogo && brandingStore.logoUrl}
						<img
							src={brandingStore.logoUrl}
							alt={brandingStore.brandName || $LL.common_logoAlt()}
							class="auth-header__logo"
							onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
						/>
					{/if}
					{#if showBrandText}
						<h1 class="auth-header__title">
							{brandingStore.brandName || $LL.app_title()}
						</h1>
					{/if}
					{#if loginUIPageStore.subtitleEnabled}
						<p class="auth-header__subtitle">
							<LocalizedTagline />
						</p>
					{/if}
				</header>
			{/if}

			{#if loginUIPageStore.showTopbar && loginUIPageStore.topbarPosition === 'in_card'}
				<LanguageSwitcher
					showThemeToggle={loginUIPageStore.themeToggleEnabled}
					showLanguageSelect={loginUIPageStore.languageSelectEnabled}
				/>
			{/if}

			<!-- Client Info Section (OIDC Dynamic OP) -->
			{#if clientInfoLoading}
				<div class="auth-client-card animate-pulse">
					<div class="auth-client-card__row">
						<div
							class="flex-shrink-0 h-12 w-12 rounded-lg"
							style="background: var(--bg-subtle);"
						></div>
						<div class="flex-1">
							<div class="h-3 rounded w-20 mb-2" style="background: var(--bg-subtle);"></div>
							<div class="h-4 rounded w-32" style="background: var(--bg-subtle);"></div>
						</div>
					</div>
				</div>
			{:else if clientInfo}
				<div class="auth-client-card">
					<div class="auth-client-card__row">
						{#if clientInfo.logo_uri && isValidImageUrl(clientInfo.logo_uri)}
							<img
								src={clientInfo.logo_uri}
								alt="{clientInfo.client_name} logo"
								class="auth-client-card__logo"
								onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
							/>
						{/if}
						<div class="flex-1 min-w-0">
							<p class="auth-client-card__label">{$LL.login_signingInTo()}</p>
							{#if clientInfo.client_uri && isValidLinkUrl(clientInfo.client_uri)}
								<p class="auth-client-card__name">
									<a
										href={clientInfo.client_uri}
										target="_blank"
										rel="noopener noreferrer"
										class="truncate block"
									>
										{clientInfo.client_name}
									</a>
								</p>
							{:else}
								<p class="auth-client-card__name truncate">
									{clientInfo.client_name}
								</p>
							{/if}
							{#if clientInfo.policy_uri || clientInfo.tos_uri}
								<div class="auth-client-card__links">
									{#if clientInfo.policy_uri && isValidLinkUrl(clientInfo.policy_uri)}
										<a
											href={clientInfo.policy_uri}
											target="_blank"
											rel="noopener noreferrer"
											class="auth-client-card__link"
										>
											{$LL.consent_privacyPolicy()}
										</a>
									{/if}
									{#if clientInfo.tos_uri && isValidLinkUrl(clientInfo.tos_uri)}
										<a
											href={clientInfo.tos_uri}
											target="_blank"
											rel="noopener noreferrer"
											class="auth-client-card__link"
										>
											{$LL.consent_termsOfService()}
										</a>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			<!-- Loading State -->
			{#if methodsLoading}
				<div class="auth-initial-loading" role="status">
					<span class="auth-initial-loading__spinner" aria-hidden="true"></span>
					<span class="sr-only">{$LL.common_loading()}</span>
				</div>
			{:else if methodsError}
				<!-- Methods Error -->
				<Card class="mb-6">
					<Alert variant="error" class="mb-0">
						{methodsError}
					</Alert>
				</Card>
			{:else}
				<!-- Login Card -->
				<form class="auth-entry-form" onsubmit={handleEmailVerificationProtocolSubmit}>
					{#if emailVerificationChallenge?.nonce}
						<input
							type="hidden"
							name="email_verification_token"
							nonce={emailVerificationChallenge.nonce}
							autocomplete={emailVerificationTokenAutocomplete}
						/>
					{/if}
					<Card class="mb-6">
						{#if !blockLegacyFormLayout}
							<div class="mb-6">
								<h2 class="auth-section-title">
									{localizedLoginTitle}
								</h2>
								<p class="auth-section-subtitle">
									{$LL.login_subtitle()}
								</p>
							</div>
						{/if}

						<!-- External IdP Error Alert -->
						{#if externalIdpError}
							<Alert
								variant="warning"
								dismissible={true}
								onDismiss={() => (externalIdpError = null)}
								class="mb-4"
							>
								<div class="space-y-1">
									<p class="font-semibold">{externalIdpError.title}</p>
									<p class="text-sm">{externalIdpError.message}</p>
									{#if externalIdpError.action}
										<p class="text-sm mt-2" style="color: var(--text-secondary);">
											{externalIdpError.action}
										</p>
									{/if}
								</div>
							</Alert>
						{/if}

						<!-- Error Alert -->
						{#if error}
							<Alert variant="error" dismissible={true} onDismiss={() => (error = '')} class="mb-4">
								{error}
							</Alert>
						{/if}

						{#if runtimeFlowError}
							<Alert
								variant="error"
								dismissible={true}
								onDismiss={() => (runtimeFlowError = '')}
								class="mb-4"
							>
								{runtimeFlowError}
							</Alert>
						{/if}

						{#if runtimeAuthFormMissing}
							<Alert variant="error" class="mb-4">
								{$LL.runtime_screenUnavailable()}
							</Alert>
						{/if}

						{#if passkeyProgressMessage}
							<div class="auth-progress mb-4" role="status" aria-live="polite">
								<span class="auth-progress__spinner" aria-hidden="true"></span>
								<span>{passkeyProgressMessage}</span>
							</div>
						{/if}

						{#if runtimeFlowStep && runtimeFlowStep.render && shouldRenderRuntimeStep(runtimeFlowStep)}
							{#if runtimeScreen}
								<div class="runtime-screen-step mb-4">
									<RuntimeScreen
										screen={runtimeScreen}
										headingOverride={localizedLoginTitle}
										disabled={authActionDisabled}
										authMethodMode="login"
										fieldValues={runtimeScreenFieldValues}
										methodAvailability={runtimeMethodAvailability}
										methodLoading={runtimeMethodLoading}
										externalProviders={runtimeExternalProviders}
										consentPolicy={getRuntimeConsentPolicy(runtimeFlowStep)}
										destinationFieldConsent={getRuntimeDestinationFieldConsent(runtimeFlowStep)}
										consentDecisions={runtimeConsentDecisions}
										destinationFieldDecisions={runtimeDestinationFieldDecisions}
										consentSelectedValues={runtimeConsentSelectedValues}
										consentReady={canSubmitRuntimeConsent()}
										humanVerificationRequired={useRuntimeAuthFormLayout && turnstileRequired}
										humanVerificationSiteKey={turnstileSiteKey}
										{humanVerificationProvider}
										{humanVerificationMode}
										humanVerificationAction={turnstileAction}
										humanVerificationTheme={turnstileTheme}
										humanVerificationLanguage={turnstileLanguage}
										bind:humanVerificationToken={turnstileToken}
										humanVerificationResetKey={turnstileResetKey}
										humanVerificationVisible={Boolean(activeTurnstileTarget)}
										humanVerificationLoadingLabel={$LL.login_humanVerificationLoading()}
										humanVerificationErrorLabel={$LL.login_humanVerificationLoadFailed()}
										emailVerificationProtocolEnabled={Boolean(emailVerificationChallenge)}
										onFieldValueChange={handleRuntimeScreenFieldValueChange}
										onAuthAction={handleRuntimeScreenAuthAction}
										onExternalProviderAction={handleRuntimeExternalProviderAction}
										onConsentDecisionChange={setRuntimeConsentDecision}
										onDestinationFieldDecisionChange={setRuntimeDestinationFieldDecision}
										onConsentSelectedValueChange={setRuntimeConsentSelectedValue}
									/>
									{#if !isRuntimeAuthStep(runtimeFlowStep)}
										<Button
											variant="primary"
											class="w-full"
											loading={runtimeFlowLoading}
											disabled={authActionLoading || !canSubmitRuntimeConsent()}
											onclick={() =>
												completeRuntimeOnlyStep(
													getRuntimeScreenContinueHandle(runtimeFlowStep),
													getRuntimeConsentItemDecisionPayload()
												)}
										>
											{$LL.common_continue()}
										</Button>
									{/if}
								</div>
							{:else}
								<Alert variant="info" class="mb-4">
									<div class="space-y-3">
										<div>
											<p class="font-semibold">{getRuntimeStepTitle(runtimeFlowStep)}</p>
											{#if getRuntimeStepDescription(runtimeFlowStep)}
												<p class="text-sm mt-1" style="color: var(--text-secondary);">
													{getRuntimeStepDescription(runtimeFlowStep)}
												</p>
											{/if}
										</div>
										{#if runtimeFlowStep.component === 'consent_policy'}
											{@const consentPolicy = getRuntimeConsentPolicy(runtimeFlowStep)}
											{@const destinationFieldConsent =
												getRuntimeDestinationFieldConsent(runtimeFlowStep)}
											{#if destinationFieldConsent?.fields.length}
												<div class="space-y-3">
													{#each destinationFieldConsent.fields as destinationField (destinationField.key)}
														<label class="runtime-consent-choice">
															<input
																type="checkbox"
																checked={destinationField.required ||
																	runtimeDestinationFieldDecisions[destinationField.key] === true}
																required={destinationField.required}
																disabled={destinationField.required}
																onchange={(event) =>
																	setRuntimeDestinationFieldDecision(
																		destinationField.key,
																		(event.currentTarget as HTMLInputElement).checked
																	)}
															/>
															<span
																>{destinationField.label}{destinationField.required
																	? ' *'
																	: ''}</span
															>
														</label>
													{/each}
												</div>
											{/if}
											{#if consentPolicy?.items.length}
												<div class="space-y-3">
													{#each consentPolicy.items as item (item.statement_id)}
														<div class="runtime-consent-item">
															{#if item.content_mode === 'radio' && item.options?.length}
																<fieldset class="runtime-consent-options">
																	<legend class="sr-only">{item.title}</legend>
																	{#each item.options as option (option.id)}
																		<label class="runtime-consent-choice">
																			<input
																				type="radio"
																				name={`runtime-consent-${item.statement_id}`}
																				value={option.value}
																				checked={runtimeConsentSelectedValues[item.statement_id] ===
																					option.value}
																				required={item.is_required}
																				onchange={() => {
																					runtimeConsentSelectedValues = {
																						...runtimeConsentSelectedValues,
																						[item.statement_id]: option.value
																					};
																				}}
																			/>
																			<SanitizedHtml
																				class="runtime-consent-content"
																				sanitizedHtml={getRuntimeConsentOptionHtml(option)}
																			/>
																		</label>
																	{/each}
																</fieldset>
															{:else if item.checkbox_mode === 'none' || item.content_mode === 'display_only'}
																<SanitizedHtml
																	tag="div"
																	class="runtime-consent-content"
																	sanitizedHtml={getRuntimeConsentItemHtml(item)}
																/>
															{:else}
																<label class="runtime-consent-choice">
																	<input
																		type="checkbox"
																		bind:checked={runtimeConsentDecisions[item.statement_id]}
																		required={item.is_required || item.checkbox_mode === 'required'}
																	/>
																	<SanitizedHtml
																		class="runtime-consent-content"
																		sanitizedHtml={getRuntimeConsentItemHtml(item)}
																	/>
																</label>
															{/if}
															{#if item.document_url && isValidLinkUrl(item.document_url)}
																<a
																	class="runtime-consent-link"
																	href={item.document_url}
																	target="_blank"
																	rel="noopener noreferrer"
																>
																	{item.document_url}
																</a>
															{/if}
														</div>
													{/each}
												</div>
											{:else}
												<p class="text-sm" style="color: var(--text-secondary);">
													{getRuntimeStepDescription(runtimeFlowStep)}
												</p>
											{/if}
											<Button
												variant="primary"
												class="w-full"
												loading={runtimeFlowLoading}
												disabled={authActionLoading || !canSubmitRuntimeConsent()}
												onclick={() =>
													completeRuntimeOnlyStep(
														'accepted',
														getRuntimeConsentItemDecisionPayload()
													)}
											>
												{$LL.common_continue()}
											</Button>
										{:else if runtimeFlowStep.component === 'completion'}
											<Button
												variant="primary"
												class="w-full"
												loading={runtimeFlowLoading}
												disabled={authActionDisabled}
												onclick={() => completeRuntimeOnlyStep('completed')}
											>
												{$LL.common_continue()}
											</Button>
										{:else}
											<Button
												variant="secondary"
												class="w-full"
												loading={runtimeFlowLoading}
												disabled={authActionDisabled}
												onclick={() => completeRuntimeOnlyStep('completed')}
											>
												{$LL.common_continue()}
											</Button>
										{/if}
									</div>
								</Alert>
							{/if}
						{/if}

						{#if directoryMigrationNotice && (directoryMigrationTransaction || directoryRecoveryTransaction)}
							<Alert variant="info" class="mb-4">
								<div class="space-y-3">
									<p>{directoryMigrationNotice}</p>
									{#if directoryMigrationTransaction}
										<Button
											variant="primary"
											class="w-full"
											loading={directoryMigrationPasskeyLoading}
											disabled={passkeyLoading ||
												emailCodeLoading ||
												directoryPasswordLoading ||
												directoryMigrationEmailLoading ||
												externalIdpLoading !== null}
											onclick={handleDirectoryMigrationPasskeyRegistration}
										>
											<div class="i-heroicons-key h-5 w-5"></div>
											{$LL.register_createWithPasskey()}
										</Button>
									{/if}
									{#if directoryMigrationTransaction?.emailFallback || directoryRecoveryTransaction}
										<div class="space-y-2">
											<Button
												variant="secondary"
												class="w-full"
												loading={directoryMigrationEmailLoading &&
													!directoryMigrationEmailChallengeId}
												disabled={passkeyLoading ||
													emailCodeLoading ||
													directoryPasswordLoading ||
													directoryMigrationPasskeyLoading ||
													externalIdpLoading !== null}
												onclick={handleDirectoryMigrationEmailCodeSend}
											>
												<div class="i-heroicons-envelope h-5 w-5"></div>
												{$LL.login_sendCode()}
											</Button>
											{#if directoryMigrationEmailChallengeId}
												<div class="space-y-2">
													<input
														type="text"
														inputmode="numeric"
														autocomplete="one-time-code"
														maxlength={6}
														placeholder={$LL.account_reauthEmailCodePlaceholder()}
														bind:value={directoryMigrationEmailCode}
														class="input w-full"
													/>
													<Button
														variant="primary"
														class="w-full"
														loading={directoryMigrationEmailLoading}
														disabled={directoryMigrationEmailCode.trim().length !== 6 ||
															passkeyLoading ||
															emailCodeLoading ||
															directoryPasswordLoading ||
															directoryMigrationPasskeyLoading ||
															externalIdpLoading !== null}
														onclick={handleDirectoryMigrationEmailCodeVerify}
													>
														<div class="i-heroicons-check h-5 w-5"></div>
														{$LL.emailCode_verifyButton()}
													</Button>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							</Alert>
						{/if}

						{#if !blockLegacyAuthLayout && !hasVisibleAuthenticationMethod}
							<Alert variant="error" class="mb-4">
								{$LL.login_noMethodsAvailable()}
							</Alert>
						{/if}

						<!-- Passkey Button -->
						{#if !blockLegacyAuthLayout && showRuntimePasskey}
							<Button
								variant="primary"
								class="w-full mb-4"
								loading={passkeyLoading}
								disabled={authActionDisabled}
								onclick={handlePasskeyLogin}
							>
								<div class="i-heroicons-key h-5 w-5"></div>
								{$LL.login_signInWithPasskey()}
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
									resetKey={turnstileResetKey}
									disabled={authActionDisabled}
									loadingLabel={$LL.login_humanVerificationLoading()}
									errorLabel={$LL.login_humanVerificationLoadFailed()}
								/>
							{/if}

							{#if showRuntimeDirectoryPassword || showRuntimeEmailCode}
								<div class="auth-divider">
									<div class="auth-divider__line"></div>
									<span class="auth-divider__text">{$LL.common_or()}</span>
									<div class="auth-divider__line"></div>
								</div>
							{/if}
						{/if}

						<!-- Directory Password -->
						{#if !blockLegacyAuthLayout && showRuntimeDirectoryPassword}
							<div class="mb-4">
								<Input
									label={directoryPasswordLabel}
									type="text"
									placeholder={$LL.login_directoryUsernamePlaceholder()}
									bind:value={directoryUsername}
									onkeypress={handleDirectoryKeyPress}
									autocomplete="username"
									disabled={authActionDisabled}
									required
								/>
							</div>

							<div class="mb-4">
								<Input
									label={$LL.login_directoryPasswordLabel()}
									type="password"
									placeholder={$LL.login_directoryPasswordPlaceholder()}
									bind:value={directoryPassword}
									onkeypress={handleDirectoryKeyPress}
									autocomplete="current-password"
									disabled={authActionDisabled}
									required
								/>
							</div>

							<Button
								variant="secondary"
								class="w-full"
								loading={directoryPasswordLoading}
								disabled={authActionDisabled}
								onclick={handleDirectoryPasswordLogin}
							>
								<div class="i-heroicons-identification h-5 w-5"></div>
								{$LL.login_signInWithDirectory({ label: directoryPasswordLabel })}
							</Button>
							{#if showTurnstileFor('directory-password') && turnstileSiteKey}
								<TurnstileWidget
									siteKey={turnstileSiteKey}
									provider={humanVerificationProvider}
									mode={humanVerificationMode}
									action={turnstileAction}
									theme={turnstileTheme}
									language={turnstileLanguage}
									bind:token={turnstileToken}
									resetKey={turnstileResetKey}
									disabled={authActionDisabled}
									loadingLabel={$LL.login_humanVerificationLoading()}
									errorLabel={$LL.login_humanVerificationLoadFailed()}
								/>
							{/if}

							{#if showRuntimeEmailCode}
								<div class="auth-divider">
									<div class="auth-divider__line"></div>
									<span class="auth-divider__text">{$LL.common_or()}</span>
									<div class="auth-divider__line"></div>
								</div>
							{/if}
						{/if}

						<!-- Email Input + Email Code -->
						{#if !blockLegacyAuthLayout && showRuntimeEmailCode}
							<div class="mb-4">
								<Input
									label={$LL.common_email()}
									type="email"
									name="email"
									placeholder={$LL.common_emailPlaceholder()}
									bind:value={email}
									onkeypress={handleKeyPress}
									autocomplete="email"
									disabled={authActionDisabled}
									required
								/>
							</div>

							<Button
								variant="secondary"
								class="w-full"
								type={emailVerificationChallenge ? 'submit' : 'button'}
								loading={emailCodeLoading}
								disabled={authActionDisabled}
								onclick={emailVerificationChallenge ? undefined : () => handleEmailCodeSend()}
							>
								<div class="i-heroicons-envelope h-5 w-5"></div>
								{$LL.login_sendCode()}
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
									resetKey={turnstileResetKey}
									disabled={authActionDisabled}
									loadingLabel={$LL.login_humanVerificationLoading()}
									errorLabel={$LL.login_humanVerificationLoadFailed()}
								/>
							{/if}
						{/if}

						<!-- TOTP -->
						{#if !blockLegacyAuthLayout && showRuntimeTotp}
							{#if showRuntimeEmailCode}
								<div class="auth-divider">
									<div class="auth-divider__line"></div>
									<span class="auth-divider__text">{$LL.common_or()}</span>
									<div class="auth-divider__line"></div>
								</div>
							{/if}

							{#if !totpCodeRequested}
								<div class="mb-4">
									<Input
										label={$LL.login_totpIdentifierLabel()}
										type="text"
										placeholder={$LL.login_totpIdentifierPlaceholder()}
										bind:value={totpIdentifier}
										onkeypress={handleTotpKeyPress}
										autocomplete="username"
										disabled={authActionDisabled}
										required
									/>
								</div>
							{:else}
								<div class="mb-4">
									<Input
										label={$LL.login_totpCodeLabel()}
										type="text"
										placeholder={$LL.login_totpCodePlaceholder()}
										bind:value={totpCode}
										onkeypress={handleTotpKeyPress}
										autocomplete="one-time-code"
										inputmode="numeric"
										maxlength={8}
										disabled={authActionDisabled}
										required
									/>
									<Button
										variant="ghost"
										size="sm"
										disabled={authActionDisabled}
										onclick={() => {
											totpCodeRequested = false;
											totpChallengeId = '';
											totpCode = '';
										}}
									>
										{$LL.common_backToLogin()}
									</Button>
								</div>
							{/if}

							<Button
								variant="secondary"
								class="w-full"
								loading={totpLoading}
								disabled={authActionDisabled}
								onclick={totpCodeRequested ? handleTotpVerify : handleTotpStart}
							>
								<div class="i-heroicons-key h-5 w-5"></div>
								{totpCodeRequested ? $LL.login_totpVerify() : $LL.login_totpContinue()}
							</Button>
						{/if}

						<!-- External Login Section -->
						{#if !blockLegacyAuthLayout && showRuntimeExternal}
							<div class="auth-divider" style="margin: 24px 0;">
								<div class="auth-divider__line"></div>
								<span class="auth-divider__text">{$LL.login_orContinueWith()}</span>
								<div class="auth-divider__line"></div>
							</div>

							<div class="auth-provider-stack space-y-3">
								{#each visibleExternalProviders as provider (provider.id)}
									{@const safeColor =
										isDarkMode && provider.buttonColorDark
											? sanitizeColor(provider.buttonColorDark)
											: sanitizeColor(provider.buttonColor)}
									<Button
										variant="secondary"
										class="w-full justify-center"
										loading={externalIdpLoading === provider.id}
										disabled={authActionDisabled}
										onclick={() => handleExternalLogin(provider)}
										style={safeColor ? `border-color: ${safeColor}; color: ${safeColor};` : ''}
									>
										{#if provider.iconUrl && isValidImageUrl(provider.iconUrl)}
											<img
												src={provider.iconUrl}
												alt=""
												loading="lazy"
												style="width: 20px; height: 20px; object-fit: contain; flex: 0 0 20px;"
											/>
										{:else if getProviderIcon(provider)}
											<div class="{getProviderIcon(provider)} h-5 w-5"></div>
										{/if}
										{getProviderButtonText(provider)}
									</Button>
									{#if showTurnstileFor(`external:${provider.id}`) && turnstileSiteKey}
										<TurnstileWidget
											siteKey={turnstileSiteKey}
											provider={humanVerificationProvider}
											mode={humanVerificationMode}
											action={turnstileAction}
											theme={turnstileTheme}
											language={turnstileLanguage}
											bind:token={turnstileToken}
											resetKey={turnstileResetKey}
											disabled={authActionDisabled}
											loadingLabel={$LL.login_humanVerificationLoading()}
											errorLabel={$LL.login_humanVerificationLoadFailed()}
										/>
									{/if}
								{/each}
							</div>
						{/if}
					</Card>
				</form>
			{/if}

			<!-- Create Account Link -->
			{#if loginUIPageStore.authSwitchLinkEnabled}
				<p class="auth-bottom-link">
					<a href={signupHref} data-sveltekit-reload>
						{$LL.login_createAccount()}
					</a>
				</p>
			{/if}
		</div>
	</div>

	<!-- Footer -->
	{#if loginUIPageStore.footerEnabled}
		<footer class="auth-footer auth-page-footer">
			{#if loginUIPageStore.footerLinks.length > 0}
				<nav class="auth-footer__links" aria-label={$LL.common_footerLinks()}>
					{#each loginUIPageStore.footerLinks as link (link.url)}
						<a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>
					{/each}
				</nav>
			{/if}
			{#if loginUIPageStore.poweredByEnabled}
				<FooterText value={localizedFooterText ?? $LL.footer_stack()} />
			{/if}
		</footer>
	{/if}
</div>

<style>
	.auth-progress {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border: 1px solid var(--border-color, var(--border));
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-color, var(--bg-glass)) 88%, transparent);
		color: var(--text-secondary);
		font-size: 0.9rem;
		line-height: 1.45;
	}

	.auth-progress__spinner {
		width: 16px;
		height: 16px;
		flex: 0 0 16px;
		border: 2px solid color-mix(in srgb, currentColor 24%, transparent);
		border-top-color: currentColor;
		border-radius: 999px;
		animation: auth-progress-spin 0.8s linear infinite;
	}

	.auth-initial-loading {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 190px;
	}

	.auth-initial-loading__spinner {
		width: 30px;
		height: 30px;
		border: 3px solid color-mix(in srgb, var(--text-primary) 18%, transparent);
		border-top-color: var(--accent-color, var(--primary));
		border-radius: 999px;
		animation: auth-progress-spin 0.8s linear infinite;
	}

	@keyframes auth-progress-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.runtime-consent-item {
		display: grid;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--border-color, var(--border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-color, var(--bg-glass)) 88%, transparent);
	}

	.runtime-consent-choice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		font-size: 0.92rem;
		line-height: 1.45;
	}

	.runtime-consent-options {
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.runtime-consent-choice input {
		margin-top: 3px;
		flex: 0 0 auto;
	}

	.runtime-consent-content {
		display: block;
		color: var(--text-secondary, var(--text-muted));
		font-size: 0.9rem;
		line-height: 1.5;
		min-width: 0;
	}

	.runtime-consent-content :global(p) {
		margin: 0;
	}

	.runtime-consent-content :global(p + p) {
		margin-top: 6px;
	}

	.runtime-consent-content :global(strong) {
		color: var(--text-primary);
	}

	.runtime-consent-content :global(a) {
		color: var(--accent-color, var(--primary));
		text-decoration: underline;
		text-underline-offset: 2px;
		overflow-wrap: anywhere;
	}

	.runtime-consent-link {
		color: var(--accent-color, var(--primary));
		font-size: 0.82rem;
		overflow-wrap: anywhere;
	}
</style>

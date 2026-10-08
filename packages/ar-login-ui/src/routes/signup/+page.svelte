<script lang="ts">
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import SignupView, {
		type RegistrationFieldView,
		type TotpSetupView
	} from '$lib/views/SignupView.svelte';
	import type { ExternalProviderButton, RuntimeStepView } from '$lib/views/auth-entry-types';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { normalizeLoginUILocale } from '$lib/i18n/locales';
	import {
		passkeyAPI,
		emailCodeAPI,
		totpAPI,
		externalIdpAPI,
		loginChallengeAPI,
		type APIError
	} from '$lib/api/client';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import { loginUiDisplayError, messageForCaughtError } from '$lib/errors/display-error';
	import { fetchRegistrationFields, type RegistrationField } from '$lib/api/registration-fields';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { isValidImageUrl, isValidRedirectUrl, sanitizeColor } from '$lib/utils/url-validation';
	import {
		fetchAuthenticationMethods,
		fetchAuthenticationMethodsForClient,
		type AuthenticationMethodsResponse,
		type ExternalProvider
	} from '$lib/api/authentication-methods';
	import { applyAuthenticationMethodsToLoginUI } from '$lib/stores/login-ui-configuration';
	import { installPageResumeHandler } from '$lib/browser/page-resume';
	import { buildAuthSwitchHref } from '$lib/authrim/auth-switch-url';
	import {
		flowRuntimeAPI,
		type FlowRuntimeEmailVerificationChallenge,
		type FlowRuntimeConsentPolicyContent,
		type FlowRuntimeDestinationFieldConsentContent,
		type FlowRuntimeStartResponse,
		type FlowRuntimeSubmitResponse,
		type FlowRuntimeStep
	} from '$lib/api/flow-runtime';
	import {
		clearExternalFlowRuntimeHandoff,
		consumeFlowRuntimeState,
		peekFlowRuntimeState,
		recordExternalFlowRuntimeHandoff,
		persistFlowRuntimeState
	} from '$lib/authrim/flow-runtime-state';
	import { consentInputKey, destinationInputKey } from '$lib/authrim/runtime-consent-key';
	import {
		isRuntimeAuthStep,
		runtimeAllowsAuthenticationHandle as runtimeStepAllowsAuthenticationHandle,
		runtimeAllowsExternalProvider as runtimeStepAllowsExternalProvider,
		type RuntimeAuthMethod
	} from '$lib/authrim/runtime-auth-handles';
	import { getExternalProviderIconClass } from '$lib/login-provider-icons';
	import { startRegistration } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';
	import {
		signalUnknownCredential,
		shouldSignalUnknownCredentialAfterRegistrationFailure
	} from '$lib/webauthn/signal';
	import {
		LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS,
		LOGIN_UI_SESSION_STORAGE_KEYS,
		removeLoginUiSessionItems,
		setLoginUiSessionItem
	} from '$lib/authrim/storage-keys';
	import { resolveTurnstileLanguage as resolveConfiguredTurnstileLanguage } from '$lib/turnstile-options';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/stores';
	import type { PageData } from './$types';

	type SignupPageData = PageData & {
		authenticationMethods?: AuthenticationMethodsResponse;
		emailVerificationProtocolEnabled?: boolean;
	};

	let { data: pageData }: { data: SignupPageData } = $props();
	const initialAuthenticationMethods = untrack(() => pageData.authenticationMethods);

	const loginUIStores = useLoginUIStores();
	const { brandingStore, loginUIPageStore } = loginUIStores;
	const loginHref = $derived(buildAuthSwitchHref('/login', $page.url.searchParams));
	const localizedRegistrationTitle = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'registrationTitle') ?? $LL.register_title()
	);

	type PasskeyProgressPhase = 'idle' | 'preparing' | 'waiting' | 'finishing';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let email = $state('');
	let name = $state('');
	let inviteToken = $state('');
	let inviteTenantName = $state('');
	let runtimeInteractionId = $state('');
	let authorizationChallengeId = $state('');
	let clientInfo = $state<{ client_id: string } | null>(null);

	let registrationFields = $state<RegistrationField[]>([]);
	let customFieldValues = $state<Record<string, string>>({});
	let customFieldErrors = $state<Record<string, string>>({});
	let error = $state('');
	let methodsError = $state('');
	let passkeyLoading = $state(false);
	let passkeyProgress = $state<PasskeyProgressPhase>('idle');
	let emailCodeLoading = $state(false);
	let totpLoading = $state(false);
	let totpCode = $state('');
	let totpQrDataUrl = $state('');
	/**
	 * Set once the authenticator app is activated: the account and the session exist then, and the
	 * backup codes are shown only once. If the sign-up Flow cannot be finished just then (the terms
	 * changed and are asked again, a moment's failure), activating again would fail, so what is
	 * left to do is submit the Flow's selection again, with this kept.
	 */
	let totpActivated = $state<{ backupCodes: string[]; redirectUrl: string } | null>(null);
	let totpSignup = $state<{
		challengeId: string;
		secret: string;
		otpauthUri: string;
		backupCodes: string[];
		redirectUrl: string;
	} | null>(null);
	let emailError = $state('');
	let nameError = $state('');
	let externalIdpLoading = $state<string | null>(null);
	let runtimeFlow = $state<FlowRuntimeStartResponse | null>(null);
	let runtimeFlowStep = $state<FlowRuntimeStep | null>(null);
	let emailVerificationChallenge = $state<FlowRuntimeEmailVerificationChallenge | null>(null);
	let emailVerificationChallengeRequestKey = '';
	let runtimeFlowLoading = $state(true);
	let runtimeFlowError = $state('');
	let runtimeFlowBlocked = $state(false);
	let runtimeConsentDecisions = $state<Record<string, boolean>>({});
	let runtimeConsentSelectedValues = $state<Record<string, string>>({});
	let runtimeConsentDecisionKey = $state('');
	let runtimeDestinationFieldDecisions = $state<Record<string, boolean>>({});
	let runtimeDestinationFieldDecisionKey = $state('');
	let pendingPostAuthRedirect = $state<string | null>(null);
	const authActionLoading = $derived(
		passkeyLoading ||
			emailCodeLoading ||
			totpLoading ||
			externalIdpLoading !== null ||
			runtimeFlowLoading
	);
	const passkeyProgressMessage = $derived(getPasskeyProgressMessage(passkeyProgress));
	const emailCodeProgressMessage = $derived(
		emailCodeLoading ? `${$LL.register_sendCode()} — ${$LL.common_loading()}` : ''
	);

	// Authentication methods (from API)
	let methodsLoading = $state(!initialAuthenticationMethods);
	let hasAuthenticationMethodsResponse = $state(Boolean(initialAuthenticationMethods));
	let authenticationMethodsRequestSequence = 0;
	let passkeyEnabled = $state(false);
	let emailCodeEnabled = $state(false);
	let emailCodeDigits = $state(6);
	let totpEnabled = $state(false);
	let totpDigits = $state(6);
	let externalEnabled = $state(false);
	let externalProviders = $state<ExternalProvider[]>([]);
	let turnstileSiteKey = $state<string | null>(null);
	let humanVerificationProvider = $state<'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom'>(
		'turnstile'
	);
	let humanVerificationMode = $state<'managed' | 'checkbox' | 'invisible' | 'score'>('managed');
	let turnstileRequired = $state(false);
	let turnstileToken = $state('');
	let turnstileResetKey = $state(0);
	let activeTurnstileTarget = $state<string | null>(null);
	let pendingTurnstileTarget = $state<string | null>(null);
	const turnstileAction = 'authrim-signup';

	function normalizeSixOrEightDigits(value: unknown): number {
		return value === 8 ? 8 : 6;
	}

	$effect(() => {
		const policy = getRuntimeConsentPolicy(runtimeFlowStep);
		const key = runtimeFlowStep?.id && policy ? consentInputKey(runtimeFlowStep.id, policy) : '';
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
			runtimeFlowStep?.id && consent ? destinationInputKey(runtimeFlowStep.id, consent) : '';
		if (key === runtimeDestinationFieldDecisionKey) return;
		runtimeDestinationFieldDecisionKey = key;
		runtimeDestinationFieldDecisions = consent
			? Object.fromEntries(consent.fields.map((field) => [field.key, true]))
			: {};
	});

	$effect(() => {
		const signup = totpSignup;
		const uri = signup?.otpauthUri;
		if (!uri || signup.backupCodes.length > 0) {
			totpQrDataUrl = '';
			return;
		}
		import('qrcode')
			.then(({ toDataURL }) => toDataURL(uri, { margin: 1, width: 192 }))
			.then((value) => {
				if (totpSignup?.otpauthUri === uri) {
					totpQrDataUrl = value;
				}
			})
			.catch(() => {
				if (totpSignup?.otpauthUri === uri) {
					totpQrDataUrl = '';
				}
			});
	});

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

	const showPasskey = $derived(passkeyEnabled && isPasskeySupported);
	const showRuntimePasskey = $derived(showPasskey && runtimeAllowsAuthenticationHandle('passkey'));
	const showRuntimeEmailCode = $derived(
		emailCodeEnabled && runtimeAllowsAuthenticationHandle('mail_otp', ['email_code'])
	);
	const showRuntimeTotp = $derived(
		totpEnabled && runtimeAllowsAuthenticationHandle('totp', ['otp'])
	);
	const visibleExternalProviders = $derived(
		externalProviders.filter((provider) => runtimeAllowsExternalProvider(provider))
	);
	const showRuntimeExternal = $derived(externalEnabled && visibleExternalProviders.length > 0);
	const hasVisibleSignupMethod = $derived(
		showRuntimePasskey || showRuntimeEmailCode || showRuntimeTotp || showRuntimeExternal
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
	let initialRuntimeBootstrapPending = $state(true);
	const initialAuthUiLoading = $derived(methodsLoading || initialRuntimeBootstrapPending);
	let entryMotionEnabled = $state(true);
	let runtimeStartSequence = 0;

	$effect(() => {
		if (initialAuthUiLoading) return;

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
	const runtimeFormHasHumanVerificationField = $derived(
		hasRuntimeScreenHumanVerificationField(runtimeScreen)
	);
	const showRuntimeFallbackHumanVerification = $derived(
		useRuntimeAuthFormLayout &&
			turnstileRequired &&
			Boolean(turnstileSiteKey) &&
			Boolean(activeTurnstileTarget) &&
			!runtimeFormHasHumanVerificationField
	);
	const blockLegacyFormLayout = $derived(
		useRuntimeScreenLayout || runtimeFlowBlocked || runtimeAuthFormMissing
	);
	const blockLegacyAuthLayout = $derived(
		useRuntimeAuthFormLayout || runtimeFlowBlocked || runtimeAuthFormMissing
	);
	const runtimeScreenFieldValues = $derived<Record<string, string>>({
		...customFieldValues,
		email,
		name,
		mail_otp_code_length: String(emailCodeDigits),
		totp_code_length: String(totpDigits)
	});
	const runtimeMethodAvailability = $derived<Partial<Record<RuntimeAuthMethod, boolean>>>({
		passkey: showRuntimePasskey,
		mail_otp: showRuntimeEmailCode,
		mail_otp_totp: showRuntimeEmailCode || showRuntimeTotp,
		totp: showRuntimeTotp,
		external_idp: showRuntimeExternal,
		directory_password: false
	});
	const runtimeMethodLoading = $derived<Partial<Record<RuntimeAuthMethod, boolean>>>({
		passkey: passkeyLoading,
		mail_otp: emailCodeLoading,
		mail_otp_totp: emailCodeLoading || totpLoading,
		totp: totpLoading,
		external_idp: externalIdpLoading !== null,
		directory_password: false
	});
	const runtimeExternalProviders = $derived<ExternalProviderButton[]>(
		visibleExternalProviders.map((provider) => {
			const safeColor =
				isDarkMode && provider.buttonColorDark
					? sanitizeColor(provider.buttonColorDark)
					: sanitizeColor(provider.buttonColor);
			return {
				id: provider.id,
				label: provider.name,
				text: getProviderButtonText(provider),
				iconUrl: provider.iconUrl && isValidImageUrl(provider.iconUrl) ? provider.iconUrl : null,
				iconClass: getProviderIcon(provider),
				style: safeColor ? `border-color: ${safeColor}; color: ${safeColor};` : ''
			};
		})
	);
	const runtimeStepView = $derived<RuntimeStepView | null>(
		runtimeFlowStep && runtimeFlowStep.render && shouldRenderRuntimeStep(runtimeFlowStep)
			? {
					component: runtimeFlowStep.component,
					isAuthStep: isRuntimeAuthStep(runtimeFlowStep),
					screen: runtimeScreen,
					title: getRuntimeStepTitle(runtimeFlowStep),
					description: getRuntimeStepDescription(runtimeFlowStep),
					consentPolicy: getRuntimeConsentPolicy(runtimeFlowStep),
					destinationFieldConsent: getRuntimeDestinationFieldConsent(runtimeFlowStep)
				}
			: null
	);
	const registrationFieldViews = $derived<RegistrationFieldView[]>(
		registrationFields.map((field) => ({
			key: field.field_key,
			kind: isNameRegistrationField(field)
				? 'name'
				: isEmailRegistrationField(field)
					? 'email'
					: field.field_type === 'boolean' ||
						  field.field_type === 'enum' ||
						  field.field_type === 'date' ||
						  field.field_type === 'number'
						? field.field_type
						: 'text',
			label: getFieldLabel(field),
			placeholder: field.placeholder,
			required: field.required,
			options: field.field_type === 'enum' ? getEnumOptions(field) : []
		}))
	);
	const totpSetupView = $derived<TotpSetupView | null>(
		totpSignup
			? {
					secret: totpSignup.secret,
					qrDataUrl: totpQrDataUrl,
					backupCodes: totpSignup.backupCodes
				}
			: null
	);
	const NAME_REGISTRATION_FIELD_KEYS = new Set(['name', 'field.canonical.name']);
	const EMAIL_REGISTRATION_FIELD_KEYS = new Set(['email', 'field.canonical.email']);
	const GIVEN_NAME_REGISTRATION_FIELD_KEYS = new Set([
		'given_name',
		'first_name',
		'field.canonical.given_name',
		'field.canonical.first_name'
	]);
	const FAMILY_NAME_REGISTRATION_FIELD_KEYS = new Set([
		'family_name',
		'last_name',
		'field.canonical.family_name',
		'field.canonical.last_name'
	]);
	const FIXED_REGISTRATION_FIELD_KEYS = new Set([
		...NAME_REGISTRATION_FIELD_KEYS,
		...EMAIL_REGISTRATION_FIELD_KEYS,
		'email_verified',
		'field.canonical.email_verified'
	]);

	function resolveTurnstileLanguage(): string {
		return resolveConfiguredTurnstileLanguage(document.documentElement.lang, getLocale());
	}

	function hasMissingRequiredRegistrationFields(apiError: APIError | null | undefined): boolean {
		const missingRequiredFields = apiError?.extensions?.missing_required_fields;
		return Array.isArray(missingRequiredFields) && missingRequiredFields.length > 0;
	}

	function getMissingRequiredRegistrationFieldsMessage(): string {
		return $LL.register_requiredFieldsMissing();
	}

	function getApiErrorMessage(apiError: APIError | null | undefined): string {
		if (hasMissingRequiredRegistrationFields(apiError)) {
			return getMissingRequiredRegistrationFieldsMessage();
		}

		return messageForApiError(apiError, {
			unknown: () => $LL.error_unknown(),
			invalidRequest: () => $LL.error_invalid_request(),
			accessDenied: () => $LL.error_access_denied(),
			unauthorizedClient: () => $LL.error_unauthorized_client(),
			unsupportedResponseType: () => $LL.error_unsupported_response_type(),
			invalidScope: () => $LL.error_invalid_scope(),
			serverError: () => $LL.error_server_error(),
			temporarilyUnavailable: () => $LL.error_temporarily_unavailable(),
			requestExpired: () => $LL.error_authorizationRequestExpired(),
			loginRequired: () => $LL.error_login_required(),
			emailCodeInvalid: () => $LL.emailCode_errorInvalid()
		});
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
		mql.addEventListener('change', () => {
			isDarkMode = checkDarkMode();
		});

		// Read invite context from URL params
		const params = new URLSearchParams(window.location.search);
		const token = params.get('invite_token');
		const prefilledEmail = params.get('email');
		const tenant = params.get('tenant');
		runtimeInteractionId = params.get('runtime_interaction_id') || '';
		authorizationChallengeId = params.get('challenge_id') || '';

		if (token) {
			inviteToken = token;
		}
		if (prefilledEmail) {
			email = prefilledEmail;
		}
		if (tenant) {
			inviteTenantName = tenant;
		}

		const tasks: Promise<void>[] = [loadAuthenticationMethods(), loadRegistrationFields()];
		let runtimeTargetReady: Promise<void> = Promise.resolve();
		if (authorizationChallengeId) {
			const challengeTask = loadChallengeData(authorizationChallengeId);
			tasks.push(challengeTask);
			if (!runtimeInteractionId) {
				runtimeTargetReady = challengeTask;
			}
		}
		tasks.push(
			runtimeTargetReady
				.then(() => startRuntimeFlowIfAvailable())
				.finally(() => {
					initialRuntimeBootstrapPending = false;
				})
		);
		await Promise.all(tasks);
		await refreshEmailVerificationProtocolChallenge();
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

	function applySignupAuthenticationMethods(data: AuthenticationMethodsResponse) {
		passkeyEnabled = data.methods.passkey.signupEnabled ?? data.methods.passkey.enabled;
		emailCodeEnabled = data.methods.emailCode.signupEnabled ?? data.methods.emailCode.enabled;
		emailCodeDigits = normalizeSixOrEightDigits(data.methods.emailCode.digits);
		totpEnabled = data.methods.totp.signupEnabled ?? data.methods.totp.enabled;
		totpDigits = normalizeSixOrEightDigits(data.methods.totp.digits);
		const humanVerificationRequired =
			data.methods.humanVerification.enabled && data.methods.humanVerification.signupEnabled;
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
		externalProviders = data.methods.external.providers.filter(
			(provider) => provider.signupEnabled ?? provider.enabled !== false
		);
		externalEnabled = data.methods.external.enabled && externalProviders.length > 0;
	}

	if (initialAuthenticationMethods) {
		applySignupAuthenticationMethods(initialAuthenticationMethods);
	}

	async function loadAuthenticationMethods(
		options: { forceRefresh?: boolean; clientId?: string | null } = {}
	) {
		if (pageData.authenticationMethods && !options.forceRefresh && !options.clientId) {
			methodsLoading = false;
			return;
		}

		const requestSequence = ++authenticationMethodsRequestSequence;
		const showLoading = !hasAuthenticationMethodsResponse;
		if (showLoading) methodsLoading = true;
		methodsError = '';
		try {
			const requestedClientId = options.clientId ?? clientInfo?.client_id ?? null;
			const result = requestedClientId
				? await fetchAuthenticationMethodsForClient(requestedClientId, {
						forceRefresh: options.forceRefresh
					})
				: await fetchAuthenticationMethods({ forceRefresh: options.forceRefresh });
			if (requestSequence !== authenticationMethodsRequestSequence) return;
			const { data } = result;
			if (data) {
				applySignupAuthenticationMethods(data);
				hasAuthenticationMethodsResponse = true;
				applyAuthenticationMethodsToLoginUI(data, loginUIStores);
			} else {
				if (!hasVisibleSignupMethod) methodsError = $LL.register_noMethodsAvailable();
			}
		} catch {
			if (requestSequence === authenticationMethodsRequestSequence && !hasVisibleSignupMethod) {
				methodsError = $LL.register_noMethodsAvailable();
			}
		} finally {
			if (requestSequence === authenticationMethodsRequestSequence && showLoading) {
				methodsLoading = false;
			}
		}
	}

	async function loadRegistrationFields() {
		registrationFields = await fetchRegistrationFields();
		customFieldValues = {};
		customFieldErrors = {};
		for (const f of registrationFields) {
			if (!isFixedRegistrationField(f)) {
				customFieldValues[f.field_key] = f.field_type === 'boolean' ? 'false' : '';
			}
		}
	}

	async function loadChallengeData(challengeId: string) {
		try {
			const { data } = await loginChallengeAPI.getData(challengeId);
			if (data?.client?.client_id) {
				clientInfo = { client_id: data.client.client_id };
				await loadAuthenticationMethods({ clientId: data.client.client_id });
			}
			if (data?.login_hint && !email) {
				email = data.login_hint;
			}
		} catch {
			// Non-fatal. The runtime falls back to the tenant registration Flow.
		}
	}

	function getRuntimeTarget() {
		if (clientInfo?.client_id) {
			return {
				target_type: 'oidc_client' as const,
				target_id: clientInfo.client_id,
				client_id: clientInfo.client_id
			};
		}
		return {
			target_type: 'tenant' as const,
			target_id: null
		};
	}

	function getRuntimeCurrentStep(flow: FlowRuntimeStartResponse | null): FlowRuntimeStep | null {
		if (!flow?.interaction.current_step_id) return null;
		return (
			flow.contract.ui.steps.find((step) => step.id === flow.interaction.current_step_id) ?? null
		);
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
			void handleEmailCodeSignup();
			return;
		}
		const token = String(new FormData(form).get('email_verification_token') ?? '').trim();
		void handleEmailCodeSignup(
			token
				? {
						token,
						challengeId: challenge.challenge_id,
						interactionId: challenge.interaction_id ?? ''
					}
				: undefined
		);
	}

	function failRuntimeStart(message: string) {
		runtimeFlow = null;
		runtimeFlowStep = null;
		runtimeFlowError = message;
		runtimeFlowBlocked = true;
	}

	async function startRuntimeFlowIfAvailable() {
		const startSequence = ++runtimeStartSequence;
		runtimeFlowLoading = true;
		runtimeFlowError = '';
		runtimeFlowBlocked = false;
		try {
			if (runtimeInteractionId) {
				const storedRuntime = peekFlowRuntimeState(runtimeInteractionId);
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
					failRuntimeStart(getApiErrorMessage(apiError));
					return;
				}
				if (!data) return;
				runtimeFlow = data;
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
				redirectIfCompletedRuntime();
				return;
			}

			const { data, error: apiError } = await flowRuntimeAPI.start({
				flow_kind: 'registration',
				locale: getLocale(),
				authorization_challenge_id: authorizationChallengeId || undefined,
				...getRuntimeTarget()
			});
			if (startSequence !== runtimeStartSequence) return;
			if (apiError) {
				failRuntimeStart(getApiErrorMessage(apiError));
				return;
			}
			if (!data) return;
			runtimeFlow = data;
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

	async function submitRuntimeStep(
		selectedHandle?: string,
		input?: unknown,
		options: { awaitingSignIn?: boolean } = {}
	): Promise<boolean> {
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
			if (apiError.error === 'consent_changed') {
				// The terms changed after they were accepted: the interaction is back at the step that
				// asks for them. This same interaction is resumed here, with the id and signature
				// held in memory (a new one, which a signed-in browser would pass through without
				// the terms, is never started), which draws that step with the terms as they are now.
				const { data: resumed, error: resumeError } = await flowRuntimeAPI.start({
					resume_interaction_id: flow.interaction.id,
					contract_hash: flow.contract_hash,
					signature: flow.signature
				});
				if (resumed) {
					runtimeFlow = resumed;
					runtimeFlowStep = getRuntimeCurrentStep(resumed);
					persistFlowRuntimeState(resumed, { postAuthRedirect: pendingPostAuthRedirect });
				} else {
					runtimeFlowError = getApiErrorMessage(resumeError ?? apiError);
				}
				return false;
			}
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
			const redirect = resolveRuntimeCompletionRedirect(data.output);
			if (redirect) {
				pendingPostAuthRedirect = redirect;
			}
		} else if (!runtimeFlowStep) {
			runtimeFlowError = $LL.error_invalid_request();
			return false;
		}
		// A method chosen before its sign-in (an emailed code, an external provider) leaves the
		// completion waiting: it is submitted once the sign-in has given a session.
		await advanceRuntimePastNonRenderedSteps({ stopAtCompletion: options.awaitingSignIn === true });
		await refreshEmailVerificationProtocolChallenge();
		return true;
	}

	function resolveRuntimeCompletionRedirect(
		output: FlowRuntimeSubmitResponse['output']
	): string | null {
		return output?.redirect_url && isValidRedirectUrl(output.redirect_url)
			? output.redirect_url
			: null;
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

	async function advanceRuntimePastNonRenderedSteps(options: { stopAtCompletion?: boolean } = {}) {
		let guard = 0;
		while (runtimeFlow && runtimeFlowStep && guard < 10) {
			if (options.stopAtCompletion && runtimeFlowStep.component === 'completion') return;
			const autoSubmitHandle = getRuntimeAutoSubmitHandle(runtimeFlowStep);
			if (autoSubmitHandle === null) return;
			guard += 1;
			const ok = await submitRuntimeStep(autoSubmitHandle);
			if (!ok) return;
		}
	}

	function redirectIfCompletedRuntime(): boolean {
		if (runtimeFlow?.interaction.state !== 'completed') return false;
		consumeFlowRuntimeState(runtimeFlow.interaction.id);
		window.location.href = pendingPostAuthRedirect || '/';
		return true;
	}

	async function completeRuntimeOnlyStep(selectedHandle: string, input?: unknown) {
		if (!runtimeFlow || authActionLoading) return;
		runtimeFlowLoading = true;
		try {
			const ok = await submitRuntimeStep(selectedHandle, input);
			if (!ok) return;
			redirectIfCompletedRuntime();
		} finally {
			runtimeFlowLoading = false;
		}
	}

	function getRuntimeStepTitle(step: FlowRuntimeStep): string {
		const title = step.content?.title;
		if (typeof title === 'string' && title.trim()) return title;
		if (step.component === 'consent_policy') return $LL.common_consent();
		if (step.component === 'completion') return $LL.common_complete();
		return $LL.common_continue();
	}

	function getRuntimeStepDescription(step: FlowRuntimeStep): string {
		const description = step.content?.description;
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

	function hasRuntimeScreenHumanVerificationField(screen: Record<string, unknown> | null): boolean {
		const fields = Array.isArray(screen?.fields) ? screen.fields : [];
		return fields.some((field) => {
			if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
			const record = field as Record<string, unknown>;
			const blockType = typeof record.block_type === 'string' ? record.block_type : '';
			const fieldName = typeof record.field === 'string' ? record.field.toLowerCase() : '';
			return (
				blockType === 'security_verification' ||
				fieldName === 'security_verification' ||
				fieldName.startsWith('security.')
			);
		});
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

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
	function validateEmail(value: string): boolean {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	}

	function normalizeRegistrationFieldKey(fieldKey: string): string {
		return fieldKey.trim().toLowerCase();
	}

	function isNameRegistrationField(field: RegistrationField): boolean {
		return NAME_REGISTRATION_FIELD_KEYS.has(normalizeRegistrationFieldKey(field.field_key));
	}

	function isEmailRegistrationField(field: RegistrationField): boolean {
		return EMAIL_REGISTRATION_FIELD_KEYS.has(normalizeRegistrationFieldKey(field.field_key));
	}

	function isFixedRegistrationField(field: RegistrationField): boolean {
		return FIXED_REGISTRATION_FIELD_KEYS.has(normalizeRegistrationFieldKey(field.field_key));
	}

	function getRegistrationFieldValue(field: RegistrationField): string {
		if (isNameRegistrationField(field)) return name;
		if (isEmailRegistrationField(field)) return email;
		return customFieldValues[field.field_key] ?? '';
	}

	function getCustomFieldValueByKeys(keys: Set<string>): string {
		for (const [fieldKey, value] of Object.entries(customFieldValues)) {
			if (keys.has(normalizeRegistrationFieldKey(fieldKey)) && value.trim()) {
				return value.trim();
			}
		}
		return '';
	}

	function getSubmittedDisplayName(): string {
		const explicitName = name.trim();
		if (explicitName) return explicitName;
		const givenName = getCustomFieldValueByKeys(GIVEN_NAME_REGISTRATION_FIELD_KEYS);
		const familyName = getCustomFieldValueByKeys(FAMILY_NAME_REGISTRATION_FIELD_KEYS);
		const compositeName = [givenName, familyName].filter(Boolean).join(' ').trim();
		if (compositeName) return compositeName;
		return email.trim() ? email.trim().split('@')[0] : '';
	}

	function getFieldLabel(field: RegistrationField): string {
		return field.required ? `${field.display_label} *` : field.display_label;
	}

	function getEnumOptions(field: RegistrationField): string[] {
		const enumValues = field.validation_rules?.enum_values;
		if (!Array.isArray(enumValues)) {
			return [];
		}

		return enumValues.filter((value): value is string => typeof value === 'string');
	}

	function setCustomFieldValue(fieldKey: string, value: string) {
		customFieldValues[fieldKey] = value;
		if (customFieldErrors[fieldKey]) {
			customFieldErrors[fieldKey] = '';
		}
	}

	function validateCustomFields(): boolean {
		customFieldErrors = {};

		for (const field of registrationFields) {
			const value = getRegistrationFieldValue(field);
			if (field.required && value.trim() === '') {
				const message = $LL.common_requiredField({ field: field.display_label });
				if (isNameRegistrationField(field)) {
					nameError = message;
				} else if (isEmailRegistrationField(field)) {
					emailError = message;
				} else {
					customFieldErrors[field.field_key] = message;
				}
			}
		}

		return !nameError && !emailError && Object.values(customFieldErrors).every((value) => !value);
	}

	function getSubmittedCustomFields(): Record<string, string> {
		return Object.fromEntries(
			Object.entries(customFieldValues).filter(([fieldKey, value]) => {
				if (FIXED_REGISTRATION_FIELD_KEYS.has(normalizeRegistrationFieldKey(fieldKey))) {
					return false;
				}
				return value !== '';
			})
		);
	}

	function getRuntimeProfileFields(): Array<{
		field: string;
		label: string;
		required: boolean;
		block_type: string;
	}> {
		const screen = getRuntimeScreen(runtimeFlowStep);
		const fields = Array.isArray(screen?.fields) ? screen.fields : [];
		return fields
			.filter(
				(field): field is Record<string, unknown> => Boolean(field) && typeof field === 'object'
			)
			.map((field) => ({
				field: typeof field.field === 'string' ? field.field : '',
				label:
					typeof field.label === 'string' && field.label.trim()
						? field.label
						: typeof field.field === 'string'
							? field.field
							: $LL.common_field(),
				required: field.required === true,
				block_type: typeof field.block_type === 'string' ? field.block_type : 'identity_field'
			}))
			.filter((field) => field.field);
	}

	function getRuntimeScreenFieldValue(field: string): string {
		const normalized = field.toLowerCase();
		if (normalized === 'email' || normalized.endsWith('.email')) return email;
		if (normalized === 'name' || normalized.endsWith('.name')) return name;
		return customFieldValues[field] ?? '';
	}

	function setRuntimeScreenFieldError(field: string, message: string) {
		const normalized = field.toLowerCase();
		if (normalized === 'email' || normalized.endsWith('.email')) {
			emailError = message;
			return;
		}
		if (normalized === 'name' || normalized.endsWith('.name')) {
			nameError = message;
			return;
		}
		customFieldErrors[field] = message;
	}

	function validateRuntimeScreenFields(): boolean {
		if (!useRuntimeAuthFormLayout) return true;
		for (const field of getRuntimeProfileFields()) {
			if (field.block_type !== 'identity_field' || !field.required) continue;
			if (getRuntimeScreenFieldValue(field.field).trim()) continue;
			setRuntimeScreenFieldError(field.field, $LL.common_requiredField({ field: field.label }));
		}
		return !nameError && !emailError && Object.values(customFieldErrors).every((value) => !value);
	}

	function validateForm(): boolean {
		emailError = '';
		nameError = '';
		customFieldErrors = {};

		if (!validateCustomFields()) {
			return false;
		}
		if (!validateRuntimeScreenFields()) {
			return false;
		}
		if (email.trim() && !validateEmail(email)) {
			emailError = $LL.login_errorEmailInvalid();
			return false;
		}
		return true;
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
			void handlePasskeyRegister();
			return;
		}
		if (target === 'email-code') {
			void handleEmailCodeSignup();
			return;
		}
		if (target === 'totp') {
			void handleTotpSignupStart();
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

	function getPasskeyProgressMessage(phase: PasskeyProgressPhase): string {
		switch (phase) {
			case 'preparing':
				return $LL.register_passkeyPreparing();
			case 'waiting':
				return $LL.register_passkeyPrompt();
			case 'finishing':
				return $LL.register_passkeyVerifying();
			default:
				return '';
		}
	}

	async function handlePasskeyRegister() {
		if (authActionLoading) return;
		error = '';
		if (!validateForm()) return;

		passkeyLoading = true;
		passkeyProgress = 'preparing';

		try {
			const cfTurnstileResponse = getTurnstileToken('passkey');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const submittedCustomFields = getSubmittedCustomFields();
			const { data: optionsData, error: optionsError } = await passkeyAPI.getRegisterOptions({
				email,
				name: getSubmittedDisplayName(),
				custom_fields: submittedCustomFields,
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
			/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
			const credential = await startRegistration({ optionsJSON: optionsData.options as any });

			passkeyProgress = 'finishing';
			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyRegistration({
				userId: optionsData.userId,
				credential,
				deviceName: navigator.userAgent.includes('Mobile')
					? $LL.register_mobileDevice()
					: $LL.register_desktopDevice(),
				authorizationChallengeId: authorizationChallengeId || undefined
			});

			if (verifyError) {
				if (shouldSignalUnknownCredentialAfterRegistrationFailure(verifyError)) {
					await signalUnknownCredential(credential.id);
				}
				throw loginUiDisplayError(getApiErrorMessage(verifyError));
			}

			// Restore authenticated state from the HttpOnly managed session cookie.
			await auth.refreshFromSession();

			// Apply invitation if present (passkey flow: server doesn't see invite_token during registration)
			if (inviteToken && verifyData?.userId) {
				try {
					const inviteRes = await fetch('/api/v1/invitations/use', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ token: inviteToken, user_id: verifyData.userId })
					});
					if (!inviteRes.ok) {
						console.warn('[signup] Failed to apply invitation:', inviteRes.status);
					}
				} catch (inviteErr) {
					console.warn('[signup] Failed to apply invitation:', inviteErr);
				}
			}

			try {
				removeLoginUiSessionItems([
					LOGIN_UI_SESSION_STORAGE_KEYS.signupCustomFields,
					LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.signupCustomFields
				]);
			} catch {
				// Non-fatal
			}

			if (runtimeFlow) {
				const ok = await submitRuntimeStep(
					'passkey',
					getRuntimeStepSubmitInputForAuthenticatedAction()
				);
				if (!ok) return;
				if (runtimeFlow?.interaction.state !== 'completed') {
					pendingPostAuthRedirect = '/';
					return;
				}
			}
			window.location.href = '/';
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			passkeyLoading = false;
			passkeyProgress = 'idle';
		}
	}

	async function handleEmailCodeSignup(emailVerification?: {
		token: string;
		challengeId: string;
		interactionId: string;
	}) {
		if (authActionLoading) return;
		error = '';
		if (!validateForm()) return;
		if (!email.trim()) {
			emailError = $LL.login_errorEmailRequired();
			return;
		}

		emailCodeLoading = true;

		try {
			const cfTurnstileResponse = getTurnstileToken('email-code');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const submittedCustomFields = getSubmittedCustomFields();
			const { data: sendData, error: apiError } = await emailCodeAPI.send({
				email,
				name: getSubmittedDisplayName(),
				invite_token: inviteToken || undefined,
				authorizationChallengeId: authorizationChallengeId || undefined,
				custom_fields: submittedCustomFields,
				human_verification_response: cfTurnstileResponse,
				humanVerificationScreen: 'signup',
				deferAuthorizationContinuation: Boolean(runtimeFlow),
				runtimeInteractionId: runtimeFlow?.interaction.id,
				emailVerification
			});
			if (apiError) {
				throw loginUiDisplayError(getApiErrorMessage(apiError));
			}
			markHumanVerificationTokenSubmitted(cfTurnstileResponse);
			if (sendData && 'verified' in sendData && sendData.verified) {
				const verifiedRedirectUrl =
					'redirect_url' in sendData && typeof sendData.redirect_url === 'string'
						? sendData.redirect_url
						: undefined;
				emailVerificationChallenge = null;
				removeLoginUiSessionItems([
					LOGIN_UI_SESSION_STORAGE_KEYS.signupCustomFields,
					LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.signupCustomFields
				]);
				await auth.refreshFromSession();
				if (runtimeFlow) {
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
						pendingPostAuthRedirect = getCompletedSignupRedirect(verifiedRedirectUrl);
						return;
					}
				}
				window.location.href = getCompletedSignupRedirect(verifiedRedirectUrl);
				return;
			}
			emailVerificationChallenge = null;
			// Persist custom field values for post-verification saving
			if (Object.keys(submittedCustomFields).length > 0) {
				try {
					setLoginUiSessionItem(
						LOGIN_UI_SESSION_STORAGE_KEYS.signupCustomFields,
						JSON.stringify(submittedCustomFields)
					);
				} catch {
					// Non-fatal
				}
			} else {
				removeLoginUiSessionItems([
					LOGIN_UI_SESSION_STORAGE_KEYS.signupCustomFields,
					LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.signupCustomFields
				]);
			}
			let verifyQs = `email=${encodeURIComponent(email)}`;
			if (inviteToken) verifyQs += `&invite_token=${encodeURIComponent(inviteToken)}`;
			if (authorizationChallengeId) {
				verifyQs += `&challenge_id=${encodeURIComponent(authorizationChallengeId)}`;
			}
			if (runtimeFlow) {
				const ok = await submitRuntimeStep(
					'mail_otp',
					getRuntimeStepSubmitInputForAuthenticatedAction(),
					{ awaitingSignIn: true }
				);
				if (!ok) return;
				const flowAfterSelection = runtimeFlow;
				if (!flowAfterSelection) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				if (flowAfterSelection.interaction.state === 'completed') {
					// A session the authorization request accepts already existed, so the Flow is
					// complete and there is no code to verify.
					window.location.href = pendingPostAuthRedirect || '/';
					return;
				}
				if (!persistFlowRuntimeState(flowAfterSelection)) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				verifyQs += `&runtime_interaction_id=${encodeURIComponent(flowAfterSelection.interaction.id)}`;
				verifyQs += '&runtime_flow_kind=registration';
			}
			window.location.href = `/verify-email-code?${verifyQs}`;
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			emailCodeLoading = false;
		}
	}

	function getCompletedSignupRedirect(redirectUrl?: string): string {
		if (pendingPostAuthRedirect) return pendingPostAuthRedirect;
		if (redirectUrl && isValidRedirectUrl(redirectUrl)) return redirectUrl;
		return '/';
	}

	async function handleTotpSignupStart() {
		if (authActionLoading) return;
		error = '';
		if (!validateForm()) return;
		if (!email.trim()) {
			emailError = $LL.login_errorEmailRequired();
			return;
		}

		totpLoading = true;
		try {
			const cfTurnstileResponse = getTurnstileToken('totp');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const submittedCustomFields = getSubmittedCustomFields();
			const { data, error: apiError } = await totpAPI.createSignupOptions({
				email,
				name: getSubmittedDisplayName(),
				custom_fields: submittedCustomFields,
				authorizationChallengeId: authorizationChallengeId || undefined,
				human_verification_response: cfTurnstileResponse
			});
			if (apiError || !data) {
				throw loginUiDisplayError(apiError ? getApiErrorMessage(apiError) : $LL.error_unknown());
			}
			markHumanVerificationTokenSubmitted(cfTurnstileResponse);
			totpActivated = null;
			totpSignup = {
				challengeId: data.challenge_id,
				secret: data.secret,
				otpauthUri: data.otpauth_uri,
				backupCodes: [],
				redirectUrl: ''
			};
			totpCode = '';
		} catch (err) {
			error = messageForCaughtError(err, $LL.register_totpStartFailed());
		} finally {
			totpLoading = false;
		}
	}

	async function handleTotpSignupActivate() {
		if (authActionLoading || !totpSignup) return;
		error = '';
		const code = totpCode.trim().replace(/\s+/g, '');
		if (!/^\d{6}$|^\d{8}$/.test(code)) {
			error = $LL.login_totpCodeInvalid();
			return;
		}

		totpLoading = true;
		try {
			if (!totpActivated) {
				const { data, error: apiError } = await totpAPI.activateSignup({
					challengeId: totpSignup.challengeId,
					code,
					deferAuthorizationContinuation: Boolean(
						runtimeFlow && runtimeFlow.interaction.state !== 'completed'
					)
				});
				if (apiError || !data?.success) {
					throw loginUiDisplayError(
						apiError ? getApiErrorMessage(apiError) : $LL.login_totpCodeInvalid()
					);
				}

				await auth.refreshFromSession();
				totpActivated = {
					backupCodes: data.backup_codes ?? [],
					redirectUrl: getCompletedSignupRedirect(data.redirect_url)
				};
			}
			const { backupCodes, redirectUrl } = totpActivated;
			if (runtimeFlow) {
				const ok = await submitRuntimeStep(
					'totp',
					getRuntimeStepSubmitInputForAuthenticatedAction()
				);
				if (!ok) return;
				if (runtimeFlow?.interaction.state !== 'completed') {
					pendingPostAuthRedirect = redirectUrl;
					return;
				}
			}
			totpSignup = {
				...totpSignup,
				backupCodes,
				redirectUrl
			};
			totpCode = '';
		} catch (err) {
			error = messageForCaughtError(err, $LL.login_totpCodeInvalid());
		} finally {
			totpLoading = false;
		}
	}

	function continueAfterTotpBackupCodes() {
		window.location.href = getCompletedSignupRedirect(totpSignup?.redirectUrl);
	}

	async function handleExternalLogin(provider: ExternalProvider) {
		const providerId = provider.id;
		if (authActionLoading) return;
		const cfTurnstileResponse = getTurnstileToken(`external:${providerId}`);
		if (turnstileRequired && !cfTurnstileResponse) return;
		externalIdpLoading = providerId;
		try {
			// Whatever an earlier, abandoned external sign-in left must not be resumed by this one.
			clearExternalFlowRuntimeHandoff();
			let runtimeResumeUrl: string | null = null;
			if (runtimeFlow) {
				const ok = await submitRuntimeStep(
					providerId,
					getRuntimeStepSubmitInputForAuthenticatedAction(),
					{ awaitingSignIn: true }
				);
				if (!ok) return;
				const flowAfterSelection = runtimeFlow;
				if (!flowAfterSelection) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				if (flowAfterSelection.interaction.state === 'completed') {
					// A session the authorization request accepts already existed: the Flow is
					// complete, and the browser does not need the provider.
					window.location.href = pendingPostAuthRedirect || '/';
					return;
				}
				if (
					!persistFlowRuntimeState(flowAfterSelection, {
						postAuthRedirect: provider.startMode === 'saml_sp' ? '/' : null
					}) ||
					!recordExternalFlowRuntimeHandoff(flowAfterSelection, 'registration')
				) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				runtimeResumeUrl = `/signup?runtime_interaction_id=${encodeURIComponent(
					flowAfterSelection.interaction.id
				)}`;
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

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter' && showRuntimeEmailCode) {
			if (emailVerificationChallenge) return;
			handleEmailCodeSignup();
		}
	}

	function handleRuntimeScreenFieldValueChange(field: string, value: string | boolean) {
		const stringValue = typeof value === 'string' ? value : value ? 'true' : 'false';
		const normalized = field.toLowerCase();
		if (normalized === 'email' || normalized.endsWith('.email')) {
			email = stringValue;
			return;
		}
		if (normalized === 'name' || normalized.endsWith('.name')) {
			name = stringValue;
			return;
		}
		setCustomFieldValue(field, stringValue);
	}

	function handleRuntimeScreenAuthAction(method: RuntimeAuthMethod, _action?: string) {
		if (method === 'passkey') {
			void handlePasskeyRegister();
			return;
		}
		if (method === 'mail_otp') {
			void handleEmailCodeSignup();
			return;
		}
		if (method === 'totp') {
			void handleTotpSignupStart();
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
		>{localizedRegistrationTitle || $LL.register_title()} - {brandingStore.brandName ||
			$LL.app_title()}</title
	>
	<meta name="description" content={$LL.register_metaDescription()} />
</svelte:head>

<AuthPageShell wide={runtimeScreenWide} entryMotion={entryMotionEnabled}>
	<SignupView
		initialLoading={initialAuthUiLoading}
		{methodsLoading}
		{methodsError}
		title={localizedRegistrationTitle}
		{inviteTenantName}
		legacyHeading={!blockLegacyFormLayout}
		legacyMethods={!blockLegacyAuthLayout}
		alerts={{
			error,
			runtimeFlow: runtimeFlowError,
			runtimeScreenMissing: runtimeAuthFormMissing,
			passkeyProgress: passkeyProgressMessage,
			emailCodeProgress: emailCodeProgressMessage
		}}
		runtimeStep={runtimeStepView}
		runtime={{
			fieldValues: runtimeScreenFieldValues,
			methodAvailability: runtimeMethodAvailability,
			methodLoading: runtimeMethodLoading,
			destinationFieldDecisions: runtimeDestinationFieldDecisions,
			consentSelectedValues: runtimeConsentSelectedValues,
			consentReady: canSubmitRuntimeConsent(),
			loading: runtimeFlowLoading
		}}
		runtimeHumanVerification={showRuntimeFallbackHumanVerification}
		methods={{
			passkey: showRuntimePasskey,
			emailCode: showRuntimeEmailCode,
			totp: showRuntimeTotp,
			external: showRuntimeExternal,
			any: hasVisibleSignupMethod
		}}
		loading={{
			passkey: passkeyLoading,
			emailCode: emailCodeLoading,
			totp: totpLoading,
			externalIdp: externalIdpLoading
		}}
		busy={authActionLoading}
		registrationFields={registrationFieldViews}
		{nameError}
		{emailError}
		{customFieldErrors}
		totpSetup={totpSetupView}
		externalProviders={runtimeExternalProviders}
		emailVerification={{
			enabled: Boolean(emailVerificationChallenge),
			nonce: emailVerificationChallenge?.nonce ?? null
		}}
		humanVerification={{
			siteKey: turnstileSiteKey,
			provider: humanVerificationProvider,
			mode: humanVerificationMode,
			action: turnstileAction,
			theme: turnstileTheme,
			language: turnstileLanguage,
			resetKey: turnstileResetKey,
			runtimeRequired: useRuntimeAuthFormLayout && turnstileRequired,
			runtimeVisible: Boolean(activeTurnstileTarget)
		}}
		{showTurnstileFor}
		loginHref={loginUIPageStore.authSwitchLinkEnabled ? loginHref : null}
		bind:name
		bind:email
		bind:customFieldValues
		bind:totpCode
		bind:turnstileToken
		bind:consentDecisions={runtimeConsentDecisions}
		onSubmit={handleEmailVerificationProtocolSubmit}
		onDismissError={() => (error = '')}
		onDismissRuntimeFlowError={() => (runtimeFlowError = '')}
		onRuntimeFieldValueChange={handleRuntimeScreenFieldValueChange}
		onRuntimeAuthAction={handleRuntimeScreenAuthAction}
		onConsentDecisionChange={setRuntimeConsentDecision}
		onDestinationFieldDecisionChange={setRuntimeDestinationFieldDecision}
		onConsentSelectedValueChange={setRuntimeConsentSelectedValue}
		onRuntimeContinue={() =>
			completeRuntimeOnlyStep(
				getRuntimeScreenContinueHandle(runtimeFlowStep),
				getRuntimeConsentItemDecisionPayload()
			)}
		onRuntimeAccept={() =>
			completeRuntimeOnlyStep('accepted', getRuntimeConsentItemDecisionPayload())}
		onRuntimeComplete={() => completeRuntimeOnlyStep('completed')}
		onCustomFieldChange={setCustomFieldValue}
		onPasskey={handlePasskeyRegister}
		onEmailCode={() => handleEmailCodeSignup()}
		onEmailKeyPress={handleKeyPress}
		onTotpStart={handleTotpSignupStart}
		onTotpActivate={handleTotpSignupActivate}
		onTotpCancel={() => {
			totpSignup = null;
			totpActivated = null;
			totpCode = '';
		}}
		onTotpDone={continueAfterTotpBackupCodes}
		onExternalProvider={handleRuntimeExternalProviderAction}
	/>
</AuthPageShell>

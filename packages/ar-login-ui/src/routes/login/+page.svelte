<script lang="ts">
	import { Button, Input, Card, Alert, TurnstileWidget } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import {
		passkeyAPI,
		emailCodeAPI,
		directoryPasswordAPI,
		externalIdpAPI,
		loginChallengeAPI
	} from '$lib/api/client';
	import { accountAPI } from '$lib/api/account';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import {
		isValidRedirectUrl,
		isValidReturnUrl,
		isValidImageUrl,
		isValidLinkUrl,
		sanitizeColor
	} from '$lib/utils/url-validation';
	import {
		fetchAuthenticationMethods,
		type ExternalProvider
	} from '$lib/api/authentication-methods';
	import {
		flowRuntimeAPI,
		type FlowRuntimeConsentPolicyContent,
		type FlowRuntimeStartResponse,
		type FlowRuntimeStep
	} from '$lib/api/flow-runtime';
	import {
		consumeFlowRuntimeState,
		persistFlowRuntimeState
	} from '$lib/authrim/flow-runtime-state';
	import { getExternalProviderIconClass } from '$lib/login-provider-icons';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';
	import {
		signalUnknownCredential,
		shouldSignalUnknownCredentialAfterLoginFailure
	} from '$lib/webauthn/signal';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { LOGIN_UI_SESSION_STORAGE_KEYS, setLoginUiSessionItem } from '$lib/authrim/storage-keys';
	import { resolveTurnstileLanguage as resolveConfiguredTurnstileLanguage } from '$lib/turnstile-options';
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { page } from '$app/stores';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let email = $state('');
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
	let emailCodeLoading = $state(false);
	let directoryPasswordLoading = $state(false);
	let directoryMigrationPasskeyLoading = $state(false);
	let directoryMigrationEmailLoading = $state(false);
	let externalIdpLoading = $state<string | null>(null);
	let runtimeFlow = $state<FlowRuntimeStartResponse | null>(null);
	let runtimeFlowStep = $state<FlowRuntimeStep | null>(null);
	let runtimeFlowLoading = $state(false);
	let runtimeFlowError = $state('');
	let runtimeConsentDecisions = $state<Record<string, boolean>>({});
	let runtimeConsentDecisionKey = $state('');
	let pendingPostAuthRedirect = $state<string | null>(null);
	const authActionLoading = $derived(
		passkeyLoading ||
			emailCodeLoading ||
			directoryPasswordLoading ||
			directoryMigrationPasskeyLoading ||
			directoryMigrationEmailLoading ||
			externalIdpLoading !== null ||
			runtimeFlowLoading
	);

	// Authentication methods (from API)
	let methodsLoading = $state(true);
	let methodsError = $state('');
	let passkeyEnabled = $state(false);
	let emailCodeEnabled = $state(false);
	let directoryPasswordEnabled = $state(false);
	let directoryPasswordLabel = $state('Organization ID');
	let externalEnabled = $state(false);
	let externalProviders = $state<ExternalProvider[]>([]);
	let turnstileSiteKey = $state<string | null>(null);
	let humanVerificationProvider = $state<'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom'>(
		'turnstile'
	);
	let humanVerificationMode = $state<'managed' | 'checkbox' | 'invisible' | 'score'>('managed');
	let turnstileRequired = $state(false);
	let turnstileToken = $state('');
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
	const showRuntimeDirectoryPassword = $derived(
		directoryPasswordEnabled &&
			runtimeAllowsAuthenticationHandle('directory_password', ['password'])
	);
	const visibleExternalProviders = $derived(
		externalProviders.filter((provider) =>
			runtimeAllowsAuthenticationHandle(provider.id, [`external:${provider.id}`])
		)
	);
	const showRuntimeExternal = $derived(externalEnabled && visibleExternalProviders.length > 0);
	const hasVisibleAuthenticationMethod = $derived(
		showRuntimePasskey ||
			showRuntimeEmailCode ||
			showRuntimeDirectoryPassword ||
			showRuntimeExternal
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
				const errorDescription = $page.url.searchParams.get('error_description');
				externalIdpError = {
					title: $LL.login_extError_default_title(),
					message: errorDescription || $LL.login_extError_default_message()
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
		}

		const tasks: Promise<void>[] = [loadAuthenticationMethods()];
		if (urlChallengeId) {
			tasks.push(loadChallengeData(urlChallengeId));
		}
		await Promise.all(tasks);
		await startRuntimeFlowIfAvailable();
	});

	// ---------------------------------------------------------------------------
	// Data fetchers
	// ---------------------------------------------------------------------------
	async function loadAuthenticationMethods() {
		methodsLoading = true;
		methodsError = '';
		try {
			const { data, error: apiError } = await fetchAuthenticationMethods();
			if (apiError) {
				methodsError = apiError.error.message;
				return;
			}
			if (data) {
				passkeyEnabled = data.methods.passkey.loginEnabled ?? data.methods.passkey.enabled;
				emailCodeEnabled = data.methods.emailCode.loginEnabled ?? data.methods.emailCode.enabled;
				directoryPasswordEnabled = data.methods.directoryPassword.enabled;
				directoryPasswordLabel = data.methods.directoryPassword.label || 'Organization ID';
				const humanVerificationRequired =
					data.methods.humanVerification.enabled && data.methods.humanVerification.loginEnabled;
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
					(provider) => provider.loginEnabled ?? provider.enabled !== false
				);
				externalEnabled = data.methods.external.enabled && externalProviders.length > 0;
			}
		} catch {
			methodsError = 'Failed to load authentication methods';
		} finally {
			methodsLoading = false;
		}
	}

	async function loadChallengeData(challengeId: string) {
		clientInfoLoading = true;
		try {
			const { data, error: apiError } = await loginChallengeAPI.getData(challengeId);
			if (data) {
				clientInfo = data.client;
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

	function getRuntimeCurrentStep(flow: FlowRuntimeStartResponse | null): FlowRuntimeStep | null {
		if (!flow) return null;
		const currentStepId = flow.interaction.current_step_id;
		if (!currentStepId) return null;
		return flow.contract.ui.steps.find((step) => step.id === currentStepId) ?? null;
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

	function shouldFallbackToLegacyRuntime(errorCode: string): boolean {
		return errorCode === 'flow_runtime_disabled';
	}

	async function startRuntimeFlowIfAvailable() {
		runtimeFlowLoading = true;
		runtimeFlowError = '';
		try {
			if (runtimeInteractionId) {
				const storedRuntime = consumeFlowRuntimeState(runtimeInteractionId);
				if (!storedRuntime) {
					runtimeFlow = null;
					runtimeFlowStep = null;
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				pendingPostAuthRedirect = storedRuntime.post_auth_redirect ?? null;
				const { data, error: apiError } = await flowRuntimeAPI.start({
					resume_interaction_id: storedRuntime.interaction_id,
					contract_hash: storedRuntime.contract_hash,
					signature: storedRuntime.signature
				});
				if (apiError) {
					runtimeFlow = null;
					runtimeFlowStep = null;
					runtimeFlowError = apiError.error_description || apiError.error;
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
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				if (!persistFlowRuntimeState(data, { postAuthRedirect: pendingPostAuthRedirect })) {
					runtimeFlowError = $LL.error_invalid_request();
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
			if (apiError) {
				runtimeFlow = null;
				runtimeFlowStep = null;
				if (!shouldFallbackToLegacyRuntime(apiError.error)) {
					runtimeFlowError = apiError.error_description || apiError.error;
				}
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
				runtimeFlowError = $LL.error_invalid_request();
				return;
			}
			await advanceRuntimePastNonRenderedSteps();
		} finally {
			runtimeFlowLoading = false;
		}
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
			runtimeFlowError = apiError.error_description || apiError.error;
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
		return true;
	}

	async function advanceRuntimePastNonRenderedSteps() {
		let guard = 0;
		while (runtimeFlow && runtimeFlowStep && runtimeFlowStep.render === false && guard < 10) {
			guard += 1;
			const ok = await submitRuntimeStep();
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
		redirectUrl?: string
	): Promise<boolean> {
		if (!runtimeFlow) return true;
		const ok = await submitRuntimeStep(selectedHandle);
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

	function getApiErrorMessage(apiError: Parameters<typeof messageForApiError>[0]): string {
		return messageForApiError(apiError, {
			unknown: () => $LL.error_unknown(),
			invalidRequest: () => $LL.error_invalid_request(),
			accessDenied: () => $LL.error_access_denied(),
			serverError: () => $LL.error_server_error(),
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
		return turnstileToken;
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

	async function handlePasskeyLogin() {
		if (authActionLoading) return;
		error = '';
		passkeyLoading = true;

		try {
			const cfTurnstileResponse = getTurnstileToken('passkey');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const { data: optionsData, error: optionsError } = await passkeyAPI.getLoginOptions({
				human_verification_response: cfTurnstileResponse
			});
			if (optionsError) {
				throw new Error(getApiErrorMessage(optionsError));
			}

			const credential = await startAuthentication({ optionsJSON: optionsData!.options });

			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyLogin({
				challengeId: optionsData!.challengeId,
				credential,
				authorizationChallengeId: authorizationChallengeId || undefined
			});

			if (verifyError) {
				if (shouldSignalUnknownCredentialAfterLoginFailure(verifyError)) {
					await signalUnknownCredential(credential.id);
				}
				throw new Error(getApiErrorMessage(verifyError));
			}

			await auth.refreshFromSession();

			const continueRedirect = await continueAfterRuntimeStep('passkey', verifyData?.redirect_url);
			if (!continueRedirect) return;
			window.location.href = await buildPostAuthRedirect(verifyData?.redirect_url);
		} catch (err) {
			error =
				err instanceof Error ? err.message : 'An error occurred during passkey authentication';
		} finally {
			passkeyLoading = false;
		}
	}

	async function handleEmailCodeSend() {
		if (authActionLoading) return;
		error = '';

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
			const cfTurnstileResponse = getTurnstileToken('email-code');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const { error: apiError } = await emailCodeAPI.send({
				email,
				human_verification_response: cfTurnstileResponse
			});
			if (apiError) {
				throw new Error(getApiErrorMessage(apiError));
			}
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
			if (runtimeFlow) {
				const ok = await submitRuntimeStep('mail_otp');
				if (!ok) return;
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
			error =
				err instanceof Error ? err.message : 'An error occurred while sending verification code';
		} finally {
			emailCodeLoading = false;
		}
	}

	async function handleDirectoryPasswordLogin() {
		if (authActionLoading) return;
		error = '';
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
				human_verification_response: cfTurnstileResponse
			});
			if (apiError) {
				if (apiError.error === 'invalid_credentials') {
					throw new Error($LL.login_errorDirectoryInvalidCredentials());
				}
				if (apiError.error === 'connector_unavailable') {
					throw new Error($LL.login_errorDirectoryUnavailable());
				}
				if (apiError.error === 'directory_identity_unmapped') {
					throw new Error($LL.login_errorDirectoryUnmapped());
				}
				throw new Error(getApiErrorMessage(apiError));
			}
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
				directoryMigrationNotice = 'Passkey registration is required before completing this login.';
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
				directoryMigrationNotice =
					'Directory is temporarily unavailable. Use Email Code recovery to continue.';
				return;
			}

			await auth.refreshFromSession();
			const redirectUrl = data && 'redirect_url' in data ? data.redirect_url : undefined;
			const continueRedirect = await continueAfterRuntimeStep('directory_password', redirectUrl);
			if (!continueRedirect) return;
			window.location.href = await buildPostAuthRedirect(redirectUrl);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.login_errorDirectoryFailed();
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
				throw new Error(optionsError ? getApiErrorMessage(optionsError) : $LL.error_unknown());
			}
			const credential = await startRegistration({ optionsJSON: optionsData.options });
			const { data, error: verifyError } = await directoryPasswordAPI.migrationPasskeyVerify({
				transactionId: directoryMigrationTransaction.transactionId,
				transactionToken: directoryMigrationTransaction.transactionToken,
				challengeId: optionsData.challenge_id,
				credential,
				deviceName: 'Directory Migration Passkey'
			});
			if (verifyError || !data) {
				throw new Error(verifyError ? getApiErrorMessage(verifyError) : $LL.error_unknown());
			}
			directoryMigrationTransaction = null;
			directoryMigrationEmailChallengeId = '';
			directoryMigrationEmailCode = '';
			directoryMigrationNotice = '';
			await auth.refreshFromSession();
			const redirectUrl = 'redirect_url' in data ? data.redirect_url : undefined;
			window.location.href = await buildPostAuthRedirect(redirectUrl);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Passkey registration failed';
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
				throw new Error(apiError ? getApiErrorMessage(apiError) : $LL.error_unknown());
			}
			directoryMigrationEmailChallengeId = data.challenge_id;
			directoryMigrationEmailCode = '';
			directoryMigrationNotice = `Verification code sent to ${data.masked_email}.`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to send verification code';
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
				throw new Error(apiError ? getApiErrorMessage(apiError) : $LL.error_unknown());
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
			error = err instanceof Error ? err.message : $LL.emailCode_errorInvalid();
		} finally {
			directoryMigrationEmailLoading = false;
		}
	}

	async function handleExternalLogin(provider: ExternalProvider) {
		const providerId = provider.id;
		if (authActionLoading) return;
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
				throw new Error('Invalid redirect URL from identity provider');
			}

			// Provider ID is diagnostic-only; the managed LoginUI flow does not store PKCE secrets.
			try {
				setLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId, providerId);
			} catch (storageError) {
				console.warn('Failed to store external provider diagnostic state:', storageError);
			}

			// Redirect to external IdP
			window.location.href = url;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start external login';
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

	function getRuntimeConsentPolicy(
		step: FlowRuntimeStep | null
	): FlowRuntimeConsentPolicyContent | null {
		const policy = step?.content?.consent_policy;
		if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
		const items = (policy as FlowRuntimeConsentPolicyContent).items;
		return Array.isArray(items) ? (policy as FlowRuntimeConsentPolicyContent) : null;
	}

	function getRuntimeConsentItemDecisionPayload() {
		const policy = getRuntimeConsentPolicy(runtimeFlowStep);
		if (!policy) return { consent_item_decisions: {} };
		return {
			consent_item_decisions: Object.fromEntries(
				policy.items.map((item) => [
					item.statement_id,
					item.checkbox_mode === 'none' || runtimeConsentDecisions[item.statement_id]
						? 'granted'
						: 'denied'
				])
			)
		};
	}

	function isRuntimeAuthStep(step: FlowRuntimeStep | null): boolean {
		return (
			!step ||
			step.component === 'authentication_method_selector' ||
			step.component === 'registration_method_selector'
		);
	}

	function runtimeAllowsAuthenticationHandle(handle: string, aliases: string[] = []): boolean {
		const step = runtimeFlowStep;
		if (!isRuntimeAuthStep(step)) {
			return true;
		}
		const configured = step?.config?.output_handles;
		if (!Array.isArray(configured) || configured.length === 0) {
			return true;
		}
		const allowed = new Set(
			configured
				.map((value) => {
					if (typeof value === 'string') return value;
					if (value && typeof value === 'object' && 'id' in value) {
						const id = (value as { id?: unknown }).id;
						return typeof id === 'string' ? id : null;
					}
					return null;
				})
				.filter((value): value is string => Boolean(value))
		);
		return [handle, ...aliases].some((candidate) => allowed.has(candidate));
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			handleEmailCodeSend();
		}
	}

	function handleDirectoryKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			handleDirectoryPasswordLogin();
		}
	}
</script>

<svelte:head>
	<title>{$LL.login_title()} - {brandingStore.brandName || $LL.app_title()}</title>
	<meta
		name="description"
		content="Sign in to your account using passkey or email code authentication."
	/>
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<div class="auth-container">
		<!-- Header -->
		<div class="auth-header">
			{#if brandingStore.logoUrl && isValidImageUrl(brandingStore.logoUrl)}
				<img
					src={brandingStore.logoUrl}
					alt={brandingStore.brandName || 'Logo'}
					class="auth-header__logo"
					onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
				/>
			{/if}
			<h1 class="auth-header__title">
				{brandingStore.brandName || $LL.app_title()}
			</h1>
			<p class="auth-header__subtitle">
				{$LL.app_subtitle()}
			</p>
		</div>

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
			<Card class="mb-6">
				<div class="flex flex-col items-center justify-center py-8 gap-3">
					<div
						class="h-8 w-8 border-3 rounded-full animate-spin"
						style="border-color: var(--border); border-top-color: var(--primary);"
					></div>
					<p style="color: var(--text-muted); font-size: 0.875rem;">{$LL.common_loading()}</p>
				</div>
			</Card>
		{:else if methodsError}
			<!-- Methods Error -->
			<Card class="mb-6">
				<Alert variant="error" class="mb-0">
					{methodsError}
				</Alert>
			</Card>
		{:else}
			<!-- Login Card -->
			<Card class="mb-6">
				<div class="mb-6">
					<h2 class="auth-section-title">
						{$LL.login_title()}
					</h2>
					<p class="auth-section-subtitle">
						{$LL.login_subtitle()}
					</p>
				</div>

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

				{#if runtimeFlowStep && runtimeFlowStep.render && !isRuntimeAuthStep(runtimeFlowStep)}
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
								{#if consentPolicy?.items.length}
									<div class="space-y-3">
										{#each consentPolicy.items as item (item.statement_id)}
											<div class="runtime-consent-item">
												{#if item.checkbox_mode === 'none'}
													<div>
														<p class="font-semibold">{item.title}</p>
														{#if item.description}
															<p class="text-sm" style="color: var(--text-secondary);">
																{item.description}
															</p>
														{/if}
													</div>
												{:else}
													<label class="runtime-consent-choice">
														<input
															type="checkbox"
															bind:checked={runtimeConsentDecisions[item.statement_id]}
															required={item.is_required || item.checkbox_mode === 'required'}
														/>
														<span>
															<strong>{item.title}</strong>
															{#if item.description}
																<small>{item.description}</small>
															{/if}
														</span>
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
												{#if item.inline_content}
													<p class="runtime-consent-inline">{item.inline_content}</p>
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
									disabled={authActionLoading}
									onclick={() =>
										completeRuntimeOnlyStep('accepted', getRuntimeConsentItemDecisionPayload())}
								>
									{$LL.common_continue()}
								</Button>
							{:else if runtimeFlowStep.component === 'completion'}
								<Button
									variant="primary"
									class="w-full"
									loading={runtimeFlowLoading}
									disabled={authActionLoading}
									onclick={() => completeRuntimeOnlyStep('completed')}
								>
									{$LL.common_continue()}
								</Button>
							{:else}
								<Button
									variant="secondary"
									class="w-full"
									loading={runtimeFlowLoading}
									disabled={authActionLoading}
									onclick={() => completeRuntimeOnlyStep('completed')}
								>
									{$LL.common_continue()}
								</Button>
							{/if}
						</div>
					</Alert>
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
									Register Passkey and Continue
								</Button>
							{/if}
							{#if directoryMigrationTransaction?.emailFallback || directoryRecoveryTransaction}
								<div class="space-y-2">
									<Button
										variant="secondary"
										class="w-full"
										loading={directoryMigrationEmailLoading && !directoryMigrationEmailChallengeId}
										disabled={passkeyLoading ||
											emailCodeLoading ||
											directoryPasswordLoading ||
											directoryMigrationPasskeyLoading ||
											externalIdpLoading !== null}
										onclick={handleDirectoryMigrationEmailCodeSend}
									>
										<div class="i-heroicons-envelope h-5 w-5"></div>
										Continue with Email Code
									</Button>
									{#if directoryMigrationEmailChallengeId}
										<div class="space-y-2">
											<input
												type="text"
												inputmode="numeric"
												autocomplete="one-time-code"
												maxlength="6"
												placeholder="Verification code"
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
												Verify Code and Continue
											</Button>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</Alert>
				{/if}

				{#if !hasVisibleAuthenticationMethod}
					<Alert variant="error" class="mb-4">
						{$LL.login_noMethodsAvailable()}
					</Alert>
				{/if}

				<!-- Passkey Button -->
				{#if showRuntimePasskey}
					<Button
						variant="primary"
						class="w-full mb-4"
						loading={passkeyLoading}
						disabled={emailCodeLoading || directoryPasswordLoading || externalIdpLoading !== null}
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
							disabled={authActionLoading}
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
				{#if showRuntimeDirectoryPassword}
					<div class="mb-4">
						<Input
							label={directoryPasswordLabel}
							type="text"
							placeholder={$LL.login_directoryUsernamePlaceholder()}
							bind:value={directoryUsername}
							onkeypress={handleDirectoryKeyPress}
							autocomplete="username"
							disabled={authActionLoading}
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
							disabled={authActionLoading}
							required
						/>
					</div>

					<Button
						variant="secondary"
						class="w-full"
						loading={directoryPasswordLoading}
						disabled={passkeyLoading || emailCodeLoading || externalIdpLoading !== null}
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
							disabled={authActionLoading}
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
				{#if showRuntimeEmailCode}
					<div class="mb-4">
						<Input
							label={$LL.common_email()}
							type="email"
							placeholder={$LL.common_emailPlaceholder()}
							bind:value={email}
							onkeypress={handleKeyPress}
							autocomplete="email"
							disabled={authActionLoading}
							required
						/>
					</div>

					<Button
						variant="secondary"
						class="w-full"
						loading={emailCodeLoading}
						disabled={passkeyLoading || directoryPasswordLoading || externalIdpLoading !== null}
						onclick={handleEmailCodeSend}
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
							disabled={authActionLoading}
							loadingLabel={$LL.login_humanVerificationLoading()}
							errorLabel={$LL.login_humanVerificationLoadFailed()}
						/>
					{/if}
				{/if}

				<!-- External Login Section -->
				{#if showRuntimeExternal}
					<div class="auth-divider" style="margin: 24px 0;">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.login_orContinueWith()}</span>
						<div class="auth-divider__line"></div>
					</div>

					<div class="space-y-3">
						{#each visibleExternalProviders as provider (provider.id)}
							{@const safeColor =
								isDarkMode && provider.buttonColorDark
									? sanitizeColor(provider.buttonColorDark)
									: sanitizeColor(provider.buttonColor)}
							<Button
								variant="secondary"
								class="w-full justify-center"
								loading={externalIdpLoading === provider.id}
								disabled={passkeyLoading ||
									emailCodeLoading ||
									directoryPasswordLoading ||
									(externalIdpLoading !== null && externalIdpLoading !== provider.id)}
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
									disabled={authActionLoading}
									loadingLabel={$LL.login_humanVerificationLoading()}
									errorLabel={$LL.login_humanVerificationLoadFailed()}
								/>
							{/if}
						{/each}
					</div>
				{/if}
			</Card>
		{/if}

		<!-- Create Account Link -->
		<p class="auth-bottom-link">
			<a href="/signup">
				{$LL.login_createAccount()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

<style>
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

	.runtime-consent-choice input {
		margin-top: 3px;
		flex: 0 0 auto;
	}

	.runtime-consent-choice span,
	.runtime-consent-choice small {
		display: block;
	}

	.runtime-consent-choice small,
	.runtime-consent-inline {
		margin-top: 3px;
		color: var(--text-secondary, var(--text-muted));
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.runtime-consent-link {
		color: var(--accent-color, var(--primary));
		font-size: 0.82rem;
		overflow-wrap: anywhere;
	}
</style>

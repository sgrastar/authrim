<script lang="ts">
	import { Button, Input, Card, Alert, TurnstileWidget, SanitizedHtml } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import RuntimeFormProfile from '$lib/components/RuntimeFormProfile.svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import {
		passkeyAPI,
		emailCodeAPI,
		externalIdpAPI,
		loginChallengeAPI,
		type APIError
	} from '$lib/api/client';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import { fetchRegistrationFields, type RegistrationField } from '$lib/api/registration-fields';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import {
		isValidImageUrl,
		isValidLinkUrl,
		isValidRedirectUrl,
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
		type FlowRuntimeSubmitResponse,
		type FlowRuntimeStep
	} from '$lib/api/flow-runtime';
	import {
		consumeFlowRuntimeState,
		persistFlowRuntimeState
	} from '$lib/authrim/flow-runtime-state';
	import { sanitizeRuntimeConsentHtml } from '$lib/consent/runtime-consent-html';
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
	import { onMount } from 'svelte';

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
	let emailCodeLoading = $state(false);
	let emailError = $state('');
	let nameError = $state('');
	let externalIdpLoading = $state<string | null>(null);
	let runtimeFlow = $state<FlowRuntimeStartResponse | null>(null);
	let runtimeFlowStep = $state<FlowRuntimeStep | null>(null);
	let runtimeFlowLoading = $state(false);
	let runtimeFlowError = $state('');
	let runtimeConsentDecisions = $state<Record<string, boolean>>({});
	let runtimeConsentSelectedValues = $state<Record<string, string>>({});
	let runtimeConsentDecisionKey = $state('');
	let pendingPostAuthRedirect = $state<string | null>(null);
	const authActionLoading = $derived(
		passkeyLoading || emailCodeLoading || externalIdpLoading !== null || runtimeFlowLoading
	);

	// Authentication methods (from API)
	let methodsLoading = $state(true);
	let passkeyEnabled = $state(false);
	let emailCodeEnabled = $state(false);
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
	const turnstileAction = 'authrim-signup';

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
	const visibleExternalProviders = $derived(
		externalProviders.filter((provider) =>
			runtimeAllowsAuthenticationHandle(provider.id, [`external:${provider.id}`])
		)
	);
	const showRuntimeExternal = $derived(externalEnabled && visibleExternalProviders.length > 0);
	const hasVisibleSignupMethod = $derived(
		showRuntimePasskey || showRuntimeEmailCode || showRuntimeExternal
	);
	type RuntimeAuthMethod = 'passkey' | 'mail_otp' | 'external_idp' | 'directory_password';
	const runtimeFormProfile = $derived(getRuntimeFormProfile(runtimeFlowStep));
	const useRuntimeAuthFormLayout = $derived(
		Boolean(runtimeFormProfile) && isRuntimeAuthStep(runtimeFlowStep)
	);
	const runtimeFormFieldValues = $derived<Record<string, string>>({
		...customFieldValues,
		email,
		name
	});
	const runtimeMethodAvailability = $derived<Partial<Record<RuntimeAuthMethod, boolean>>>({
		passkey: showRuntimePasskey,
		mail_otp: showRuntimeEmailCode,
		external_idp: showRuntimeExternal,
		directory_password: false
	});
	const runtimeMethodLoading = $derived<Partial<Record<RuntimeAuthMethod, boolean>>>({
		passkey: passkeyLoading,
		mail_otp: emailCodeLoading,
		external_idp: externalIdpLoading !== null,
		directory_password: false
	});
	const runtimeExternalProviders = $derived(
		visibleExternalProviders.map((provider) => {
			const safeColor =
				isDarkMode && provider.buttonColorDark
					? sanitizeColor(provider.buttonColorDark)
					: sanitizeColor(provider.buttonColor);
			return {
				id: provider.id,
				label: getProviderButtonText(provider),
				iconUrl: provider.iconUrl && isValidImageUrl(provider.iconUrl) ? provider.iconUrl : null,
				iconClass: getProviderIcon(provider),
				style: safeColor ? `border-color: ${safeColor}; color: ${safeColor};` : ''
			};
		})
	);
	const NAME_REGISTRATION_FIELD_KEYS = new Set(['name', 'field.canonical.name']);
	const EMAIL_REGISTRATION_FIELD_KEYS = new Set(['email', 'field.canonical.email']);
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
		return getLocale() === 'ja'
			? '必須の登録項目がフォームに表示されていません。管理者に問い合わせてください。'
			: 'A required registration field is not available in this signup form. Contact your administrator.';
	}

	function getApiErrorMessage(apiError: APIError | null | undefined): string {
		if (hasMissingRequiredRegistrationFields(apiError)) {
			return getMissingRequiredRegistrationFieldsMessage();
		}

		return messageForApiError(apiError, {
			unknown: () => $LL.error_unknown(),
			invalidRequest: () => $LL.error_invalid_request(),
			accessDenied: () => $LL.error_access_denied(),
			serverError: () => $LL.error_server_error(),
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
		tasks.push(runtimeTargetReady.then(() => startRuntimeFlowIfAvailable()));
		await Promise.all(tasks);
	});

	async function loadAuthenticationMethods() {
		methodsLoading = true;
		methodsError = '';
		try {
			const { data, error: apiError } = await fetchAuthenticationMethods();
			if (data) {
				passkeyEnabled = data.methods.passkey.signupEnabled ?? data.methods.passkey.enabled;
				emailCodeEnabled = data.methods.emailCode.signupEnabled ?? data.methods.emailCode.enabled;
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
			} else {
				passkeyEnabled = false;
				emailCodeEnabled = false;
				externalEnabled = false;
				externalProviders = [];
				methodsError = apiError?.error.message || $LL.register_noMethodsAvailable();
			}
		} catch {
			passkeyEnabled = false;
			emailCodeEnabled = false;
			externalEnabled = false;
			externalProviders = [];
			methodsError = $LL.register_noMethodsAvailable();
		} finally {
			methodsLoading = false;
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
				redirectIfCompletedRuntime();
				return;
			}

			const { data, error: apiError } = await flowRuntimeAPI.start({
				flow_kind: 'registration',
				locale: getLocale(),
				authorization_challenge_id: authorizationChallengeId || undefined,
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
			const redirect = resolveRuntimeCompletionRedirect(data.output);
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
			typeof step.config?.profile_form_ref === 'string'
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
		if (step.component === 'consent_policy') return 'Consent';
		if (step.component === 'completion') return 'Complete';
		return 'Continue';
	}

	function getRuntimeStepDescription(step: FlowRuntimeStep): string {
		const description = step.content?.description;
		return typeof description === 'string' ? description : '';
	}

	function getRuntimeFormProfile(step: FlowRuntimeStep | null): Record<string, unknown> | null {
		const profile = step?.config?.form_profile;
		return profile && typeof profile === 'object' && !Array.isArray(profile)
			? (profile as Record<string, unknown>)
			: null;
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
				policy.items
					.filter((item) => item.content_mode === 'radio')
					.map((item) => [item.statement_id, runtimeConsentSelectedValues[item.statement_id] || ''])
			)
		};
	}

	function getRuntimeStepSubmitInputForAuthenticatedAction() {
		return getRuntimeConsentPolicy(runtimeFlowStep)
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

	function canSubmitRuntimeConsent(): boolean {
		const policy = getRuntimeConsentPolicy(runtimeFlowStep);
		if (!policy) return true;
		return policy.items.every(
			(item) =>
				!item.is_required ||
				(item.content_mode === 'radio' &&
					Boolean(runtimeConsentSelectedValues[item.statement_id])) ||
				item.checkbox_mode === 'none' ||
				runtimeConsentDecisions[item.statement_id] === true
		);
	}

	function shouldRenderRuntimeStep(step: FlowRuntimeStep): boolean {
		return !isRuntimeAuthStep(step) || Boolean(getRuntimeFormProfile(step));
	}

	function getRuntimeFormContinueHandle(step: FlowRuntimeStep | null): string {
		if (step?.component === 'consent_policy') return 'accepted';
		if (step?.component === 'profile_form') return 'submitted';
		return 'completed';
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
				const message = `${field.display_label} is required`;
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
		const profile = getRuntimeFormProfile(runtimeFlowStep);
		const fields = Array.isArray(profile?.fields) ? profile.fields : [];
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
							: 'Field',
				required: field.required === true,
				block_type: typeof field.block_type === 'string' ? field.block_type : 'identity_field'
			}))
			.filter((field) => field.field);
	}

	function getRuntimeFormFieldValue(field: string): string {
		const normalized = field.toLowerCase();
		if (normalized === 'email' || normalized.endsWith('.email')) return email;
		if (normalized === 'name' || normalized.endsWith('.name')) return name;
		return customFieldValues[field] ?? '';
	}

	function setRuntimeFormFieldError(field: string, message: string) {
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

	function validateRuntimeFormFields(): boolean {
		if (!useRuntimeAuthFormLayout) return true;
		for (const field of getRuntimeProfileFields()) {
			if (field.block_type !== 'identity_field' || !field.required) continue;
			if (getRuntimeFormFieldValue(field.field).trim()) continue;
			setRuntimeFormFieldError(field.field, `${field.label} is required`);
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
		if (!validateRuntimeFormFields()) {
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
		return turnstileToken;
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

	async function handlePasskeyRegister() {
		if (passkeyLoading) return;
		error = '';
		if (!validateForm()) return;

		passkeyLoading = true;

		try {
			const cfTurnstileResponse = getTurnstileToken('passkey');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const { data: optionsData, error: optionsError } = await passkeyAPI.getRegisterOptions({
				email,
				name,
				custom_fields: getSubmittedCustomFields(),
				human_verification_response: cfTurnstileResponse
			});

			if (optionsError) {
				throw new Error(getApiErrorMessage(optionsError));
			}
			if (!optionsData?.options) {
				throw new Error('Invalid response from server: missing options');
			}

			/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
			const credential = await startRegistration({ optionsJSON: optionsData.options as any });

			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyRegistration({
				userId: optionsData.userId,
				credential,
				deviceName: navigator.userAgent.includes('Mobile') ? 'Mobile Device' : 'Desktop',
				authorizationChallengeId: authorizationChallengeId || undefined
			});

			if (verifyError) {
				if (shouldSignalUnknownCredentialAfterRegistrationFailure(verifyError)) {
					await signalUnknownCredential(credential.id);
				}
				throw new Error(getApiErrorMessage(verifyError));
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
			error = err instanceof Error ? err.message : 'An error occurred during passkey registration';
		} finally {
			passkeyLoading = false;
		}
	}

	async function handleEmailCodeSignup() {
		if (emailCodeLoading) return;
		error = '';
		if (!validateForm()) return;

		emailCodeLoading = true;

		try {
			const cfTurnstileResponse = getTurnstileToken('email-code');
			if (turnstileRequired && !cfTurnstileResponse) return;
			const submittedCustomFields = getSubmittedCustomFields();
			const { error: apiError } = await emailCodeAPI.send({
				email,
				name,
				invite_token: inviteToken || undefined,
				custom_fields: submittedCustomFields,
				human_verification_response: cfTurnstileResponse
			});
			if (apiError) {
				throw new Error(getApiErrorMessage(apiError));
			}
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
				const ok = await submitRuntimeStep('mail_otp');
				if (!ok) return;
				const flowAfterSelection = runtimeFlow;
				if (!flowAfterSelection || !persistFlowRuntimeState(flowAfterSelection)) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				verifyQs += `&runtime_interaction_id=${encodeURIComponent(flowAfterSelection.interaction.id)}`;
				verifyQs += '&runtime_flow_kind=registration';
			}
			window.location.href = `/verify-email-code?${verifyQs}`;
		} catch (err) {
			error =
				err instanceof Error ? err.message : 'An error occurred while sending verification code';
		} finally {
			emailCodeLoading = false;
		}
	}

	async function handleExternalLogin(provider: ExternalProvider) {
		const providerId = provider.id;
		const cfTurnstileResponse = getTurnstileToken(`external:${providerId}`);
		if (turnstileRequired && !cfTurnstileResponse) return;
		externalIdpLoading = providerId;
		try {
			let runtimeResumeUrl: string | null = null;
			if (runtimeFlow) {
				const ok = await submitRuntimeStep(providerId);
				if (!ok) return;
				const flowAfterSelection = runtimeFlow;
				if (
					!flowAfterSelection ||
					!persistFlowRuntimeState(flowAfterSelection, {
						postAuthRedirect: provider.startMode === 'saml_sp' ? '/' : null
					})
				) {
					runtimeFlowError = $LL.error_invalid_request();
					return;
				}
				runtimeResumeUrl = `/signup?runtime_interaction_id=${encodeURIComponent(
					flowAfterSelection.interaction.id
				)}`;
				setLoginUiSessionItem(
					LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId,
					flowAfterSelection.interaction.id
				);
				setLoginUiSessionItem(
					LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeKind,
					'registration'
				);
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

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter' && showRuntimeEmailCode) {
			handleEmailCodeSignup();
		}
	}

	function handleRuntimeFormFieldValueChange(field: string, value: string | boolean) {
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

	function handleRuntimeFormAuthAction(method: RuntimeAuthMethod) {
		if (method === 'passkey') {
			void handlePasskeyRegister();
			return;
		}
		if (method === 'mail_otp') {
			void handleEmailCodeSignup();
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
</script>

<svelte:head>
	<title>{$LL.register_title()} - {brandingStore.brandName || $LL.app_title()}</title>
	<meta
		name="description"
		content="Create a new account using passkey or email code authentication."
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
		{:else}
			<!-- Registration Card -->
			<Card class="mb-6">
				<div class="mb-6">
					<h2 class="auth-section-title">
						{$LL.register_title()}
					</h2>
					{#if inviteTenantName}
						<p class="auth-section-subtitle">
							You've been invited to <strong>{inviteTenantName}</strong>. Create your account to
							continue.
						</p>
					{:else}
						<p class="auth-section-subtitle">
							{$LL.register_subtitle()}
						</p>
					{/if}
				</div>

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

				{#if runtimeFlowStep && runtimeFlowStep.render && shouldRenderRuntimeStep(runtimeFlowStep)}
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
							{#if getRuntimeFormProfile(runtimeFlowStep)}
								<RuntimeFormProfile
									profile={getRuntimeFormProfile(runtimeFlowStep)}
									disabled={authActionLoading}
									fieldValues={runtimeFormFieldValues}
									fieldErrors={{
										email: emailError,
										name: nameError,
										...customFieldErrors
									}}
									methodAvailability={runtimeMethodAvailability}
									methodLoading={runtimeMethodLoading}
									externalProviders={runtimeExternalProviders}
									consentPolicy={getRuntimeConsentPolicy(runtimeFlowStep)}
									consentDecisions={runtimeConsentDecisions}
									consentSelectedValues={runtimeConsentSelectedValues}
									consentReady={canSubmitRuntimeConsent()}
									onFieldValueChange={handleRuntimeFormFieldValueChange}
									onAuthAction={handleRuntimeFormAuthAction}
									onExternalProviderAction={handleRuntimeExternalProviderAction}
									onConsentDecisionChange={setRuntimeConsentDecision}
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
												getRuntimeFormContinueHandle(runtimeFlowStep),
												getRuntimeConsentItemDecisionPayload()
											)}
									>
										{$LL.common_continue()}
									</Button>
								{/if}
							{:else if runtimeFlowStep.component === 'consent_policy'}
								{@const consentPolicy = getRuntimeConsentPolicy(runtimeFlowStep)}
								{#if consentPolicy?.items.length}
									<div class="space-y-3">
										{#each consentPolicy.items as item (item.statement_id)}
											<div class="runtime-consent-item">
												{#if item.checkbox_mode === 'none'}
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

				{#if !useRuntimeAuthFormLayout && !methodsLoading && (methodsError || !hasVisibleSignupMethod)}
					<Alert variant="error" class="mb-4">
						{methodsError || $LL.register_noMethodsAvailable()}
					</Alert>
				{/if}

				<!-- Registration Fields -->
				{#if !useRuntimeAuthFormLayout && registrationFields.length > 0}
					{#each registrationFields as field (field.field_key)}
						<div class="mb-4">
							{#if isNameRegistrationField(field)}
								<Input
									label={getFieldLabel(field)}
									type="text"
									placeholder={field.placeholder ?? $LL.common_namePlaceholder()}
									bind:value={name}
									error={nameError}
									autocomplete="name"
									required={field.required}
								/>
							{:else if isEmailRegistrationField(field)}
								<Input
									label={getFieldLabel(field)}
									type="email"
									placeholder={field.placeholder ?? $LL.common_emailPlaceholder()}
									bind:value={email}
									error={emailError}
									onkeypress={handleKeyPress}
									autocomplete="email"
									required={field.required}
								/>
							{:else if field.field_type === 'boolean'}
								<label class="flex items-center gap-2" style="cursor: pointer;">
									<input
										type="checkbox"
										checked={customFieldValues[field.field_key] === 'true'}
										onchange={(e) => {
											setCustomFieldValue(
												field.field_key,
												(e.currentTarget as HTMLInputElement).checked ? 'true' : 'false'
											);
										}}
									/>
									<span style="font-size: 0.875rem; color: var(--text);"
										>{getFieldLabel(field)}</span
									>
								</label>
								{#if customFieldErrors[field.field_key]}
									<p class="custom-field-error">{customFieldErrors[field.field_key]}</p>
								{/if}
							{:else if field.field_type === 'enum'}
								<div class="form-group">
									<label class="form-label" for={`signup-${field.field_key}`}
										>{getFieldLabel(field)}</label
									>
									<select
										id={`signup-${field.field_key}`}
										class="custom-field-select"
										class:has-error={!!customFieldErrors[field.field_key]}
										value={customFieldValues[field.field_key]}
										onchange={(e) =>
											setCustomFieldValue(
												field.field_key,
												(e.currentTarget as HTMLSelectElement).value
											)}
									>
										<option value="">{field.placeholder ?? 'Select an option'}</option>
										{#each getEnumOptions(field) as option (option)}
											<option value={option}>{option}</option>
										{/each}
									</select>
									{#if customFieldErrors[field.field_key]}
										<p class="custom-field-error">{customFieldErrors[field.field_key]}</p>
									{/if}
								</div>
							{:else if field.field_type === 'date'}
								<Input
									label={getFieldLabel(field)}
									type="date"
									placeholder={field.placeholder ?? ''}
									bind:value={customFieldValues[field.field_key]}
									error={customFieldErrors[field.field_key]}
									oninput={() =>
										setCustomFieldValue(field.field_key, customFieldValues[field.field_key])}
									required={field.required}
								/>
							{:else if field.field_type === 'number'}
								<Input
									label={getFieldLabel(field)}
									type="number"
									placeholder={field.placeholder ?? ''}
									bind:value={customFieldValues[field.field_key]}
									error={customFieldErrors[field.field_key]}
									oninput={() =>
										setCustomFieldValue(field.field_key, customFieldValues[field.field_key])}
									required={field.required}
								/>
							{:else}
								<Input
									label={getFieldLabel(field)}
									type="text"
									placeholder={field.placeholder ?? ''}
									bind:value={customFieldValues[field.field_key]}
									error={customFieldErrors[field.field_key]}
									oninput={() =>
										setCustomFieldValue(field.field_key, customFieldValues[field.field_key])}
									required={field.required}
								/>
							{/if}
						</div>
					{/each}
				{/if}

				<!-- Passkey Button -->
				{#if !useRuntimeAuthFormLayout && showRuntimePasskey}
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

					{#if showRuntimeEmailCode}
						<div class="auth-divider">
							<div class="auth-divider__line"></div>
							<span class="auth-divider__text">{$LL.common_or()}</span>
							<div class="auth-divider__line"></div>
						</div>
					{/if}
				{/if}

				<!-- Email Code Button -->
				{#if !useRuntimeAuthFormLayout && showRuntimeEmailCode}
					<Button
						variant="secondary"
						class="w-full"
						loading={emailCodeLoading}
						disabled={passkeyLoading || externalIdpLoading !== null}
						onclick={handleEmailCodeSignup}
					>
						<div class="i-heroicons-envelope h-5 w-5"></div>
						{$LL.register_sendCode()}
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
				{#if !useRuntimeAuthFormLayout && showRuntimeExternal}
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

				<!-- Terms Agreement -->
				{#if !useRuntimeAuthFormLayout}
					<p class="mt-4 text-xs text-center" style="color: var(--text-muted);">
						{$LL.register_termsAgreement()}
					</p>
				{/if}
			</Card>
		{/if}

		<!-- Sign In Link -->
		<p class="auth-bottom-link">
			<a href="/login">
				{$LL.register_alreadyHaveAccount()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

<style>
	.form-group {
		width: 100%;
	}

	.form-label {
		display: block;
		font-family: var(--font-display);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 8px;
	}

	.custom-field-select {
		width: 100%;
		padding: 12px 16px;
		background: var(--bg-glass);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-size: 0.9375rem;
		font-family: var(--font-body);
		color: var(--text-primary);
		transition: all var(--transition-fast);
		backdrop-filter: var(--blur-sm);
		-webkit-backdrop-filter: var(--blur-sm);
	}

	.custom-field-select.has-error {
		border-color: var(--danger);
	}

	.custom-field-select:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 4px var(--primary-light);
	}

	.custom-field-error {
		font-size: 0.8125rem;
		color: var(--danger);
		margin-top: 6px;
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

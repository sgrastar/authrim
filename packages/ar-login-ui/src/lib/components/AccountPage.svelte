<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { Button } from '$lib/components';
	import {
		accountAPI,
		type AccountConsent,
		type AccountCapabilities,
		type AccountDevice,
		type AccountOperation,
		type AccountPasskey,
		type AccountProfile,
		type AccountProfileSession,
		type IdentifierReplacementOperation,
		type AccountSession,
		type AccountPageScreen,
		type AccountPageScreenField,
		type AccountTotpCredential
	} from '$lib/api/account';
	import AccountActivitySection from '$lib/components/account/AccountActivitySection.svelte';
	import AccountConsentSection from '$lib/components/account/AccountConsentSection.svelte';
	import AccountProfileSection from '$lib/components/account/AccountProfileSection.svelte';
	import AccountSecuritySection from '$lib/components/account/AccountSecuritySection.svelte';
	import ConfiguredFooter from '$lib/components/ConfiguredFooter.svelte';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import {
		fetchAuthenticationMethods,
		type AuthenticationMethods,
		type AuthenticationMethodsResponse
	} from '$lib/api/authentication-methods';
	import { auth } from '$lib/stores/auth';
	import {
		signalAllAcceptedCredentials,
		signalCurrentUserDetails,
		signalUnknownCredential,
		shouldSignalUnknownCredentialAfterRegistrationFailure
	} from '$lib/webauthn/signal';
	import { classifyPasskeyRegistrationError } from '$lib/webauthn/passkey-registration-error';
	import { buildTotpDeleteProof } from '$lib/account/totp-proof';
	import { getAuthConfig } from '$lib/auth';
	import type { APIError } from '$lib/api/client';
	import { appendApiSupportReference, messageForCaughtError } from '$lib/errors/display-error';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { Locales } from '$i18n/i18n-types';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	let {
		initialCapabilities = null,
		initialCapabilitiesResolved = false,
		initialPlacementConditions = {
			consentRecordsAvailable: null,
			multipleSessions: null
		},
		initialAuthenticationMethods = null
	} = $props<{
		initialCapabilities?: AccountCapabilities | null;
		initialCapabilitiesResolved?: boolean;
		initialPlacementConditions?: {
			consentRecordsAvailable: boolean | null;
			multipleSessions: boolean | null;
		};
		initialAuthenticationMethods?: AuthenticationMethodsResponse | null;
	}>();
	const embeddedCapabilities = untrack(() => initialCapabilities);
	const embeddedCapabilitiesResolved = untrack(() => initialCapabilitiesResolved);
	const embeddedAuthenticationMethods = untrack(() => initialAuthenticationMethods);

	const { brandingStore, languageStore, loginUIPageStore } = useLoginUIStores();
	type SecurityArea = 'devices' | 'sessions' | 'passkeys' | 'totp' | 'social';
	const ALL_SECURITY_AREAS: SecurityArea[] = ['devices', 'sessions', 'passkeys', 'totp', 'social'];

	let logoutLoading = $state(false);
	let profileLoading = $state(true);
	let devicesLoading = $state(true);
	let sessionsLoading = $state(true);
	let passkeysLoading = $state(true);
	let totpLoading = $state(true);
	let operationsLoading = $state(true);
	let consentsLoading = $state(true);
	let capabilitiesLoading = $state(!embeddedCapabilitiesResolved);
	let capabilitiesResolved = $state(embeddedCapabilitiesResolved);
	let authenticationMethodsLoading = $state(!embeddedAuthenticationMethods);
	let profile = $state<AccountProfile | null>(null);
	let devices = $state<AccountDevice[]>([]);
	let sessions = $state<AccountSession[]>([]);
	let passkeys = $state<AccountPasskey[]>([]);
	let totpCredentials = $state<AccountTotpCredential[]>([]);
	let totpBackupCodes = $state({ total: 0, remaining: 0 });
	let totpEnrollment = $state<{
		credentialId: string;
		secret: string;
		otpauthUri: string;
		backupCodes: string[];
	} | null>(null);
	let operations = $state<AccountOperation[]>([]);
	let consents = $state<AccountConsent[]>([]);
	let authenticationMethods = $state<AuthenticationMethods | null>(
		embeddedAuthenticationMethods?.methods ?? null
	);
	let accountCapabilities = $state<AccountCapabilities | null>(embeddedCapabilities);
	let accountError = $state('');
	let profileError = $state('');
	let consentError = $state('');
	let profileSaved = $state(false);
	let profileSaving = $state(false);
	let emailChangeStage = $state<'idle' | 'challenge' | 'processing' | 'completed'>('idle');
	let emailChangeLoading = $state(false);
	let emailChangeError = $state('');
	let emailChangeChallengeId = $state('');
	let emailChangeIdempotencyKey = $state('');
	let emailChangePollGeneration = 0;
	let consentLoadGeneration = 0;
	let securityErrors = $state<Partial<Record<SecurityArea, string>>>({});
	let reauthNeeded = $state(false);
	let securityRefreshingAreas = $state<SecurityArea[]>([]);
	const securityRefreshCounts = new SvelteMap<SecurityArea, number>();
	let actionLoading = $state('');
	let passkeySupported = $state(false);
	let currentLocale = $state<Locales>(getLocale());
	let reauthModalOpen = $state(false);
	let reauthLoading = $state(false);
	let reauthError = $state('');
	let emailReauthChallengeId = $state('');
	let emailReauthCode = $state('');
	let emailReauthMaskedEmail = $state('');
	let emailReauthCodeSent = $state(false);
	let totpReauthCode = $state('');
	let pendingReauthAction = $state<
		| { type: 'add-passkey'; deviceName: string }
		| { type: 'delete-passkey'; id: string }
		| { type: 'add-totp'; label: string }
		| { type: 'delete-totp'; id: string; code: string }
		| { type: 'regenerate-totp-backup-codes'; code: string }
		| { type: 'change-email'; email: string }
		| null
	>(null);

	function localizeApiError(error: APIError | null | undefined, fallback: string): string {
		if (!error) return fallback;
		let message: string;
		switch (error.error) {
			case 'invalid_request':
				message = $LL.error_invalid_request();
				break;
			case 'access_denied':
				message = $LL.error_access_denied();
				break;
			case 'temporarily_unavailable':
				message = $LL.error_temporarily_unavailable();
				break;
			case 'server_error':
				message = $LL.error_server_error();
				break;
			case 'login_required':
			case 'reauthentication_required':
				message = $LL.account_reauthRequired();
				break;
			default:
				message = fallback;
		}
		return appendApiSupportReference(message, $LL.error_errorCode(), error);
	}

	let passkeyReauthAvailable = $derived(
		Boolean(
			passkeySupported &&
			authenticationMethods?.passkey &&
			(authenticationMethods.passkey.reauthEnabled ?? authenticationMethods.passkey.enabled)
		)
	);
	let emailCodeReauthAvailable = $derived(
		Boolean(
			profile?.email &&
			profile.email_verified &&
			authenticationMethods?.emailCode &&
			(authenticationMethods.emailCode.reauthEnabled ?? authenticationMethods.emailCode.enabled)
		)
	);
	let totpReauthAvailable = $derived(
		Boolean(
			totpCredentials.some((credential) => credential.status === 'active') &&
			authenticationMethods?.totp &&
			(authenticationMethods.totp.reauthEnabled ?? authenticationMethods.totp.enabled)
		)
	);
	let hasReauthMethod = $derived(
		passkeyReauthAvailable || emailCodeReauthAvailable || totpReauthAvailable
	);
	let totpManagementEnabled = $derived(
		Boolean(
			authenticationMethods?.totp &&
			((authenticationMethods.totp.loginEnabled ?? authenticationMethods.totp.enabled) ||
				(authenticationMethods.totp.accountLinkEnabled ?? false))
		)
	);
	function initialLoadingAreas(areas: SecurityArea[]): SecurityArea[] {
		return areas.filter((area) => {
			switch (area) {
				case 'devices':
					return devicesLoading;
				case 'sessions':
					return sessionsLoading;
				case 'passkeys':
					return passkeysLoading || authenticationMethodsLoading;
				case 'totp':
					return totpLoading || authenticationMethodsLoading;
				case 'social':
					return authenticationMethodsLoading;
			}
		});
	}

	function setSecurityError(area: SecurityArea, message: string) {
		if (message) {
			securityErrors = { ...securityErrors, [area]: message };
			return;
		}
		const nextErrors = { ...securityErrors };
		delete nextErrors[area];
		securityErrors = nextErrors;
	}

	function clearSecurityErrors(areas: SecurityArea[] = ALL_SECURITY_AREAS) {
		for (const area of areas) setSecurityError(area, '');
	}

	function securityErrorFor(areas: SecurityArea[]): string {
		return areas.map((area) => securityErrors[area]).find(Boolean) ?? '';
	}

	function localizedPasskeyRegistrationError(error: unknown): string {
		switch (classifyPasskeyRegistrationError(error)) {
			case 'cancelled-or-timed-out':
				return $LL.account_passkeyRegistrationCancelled();
			case 'already-registered':
				return $LL.account_passkeyAlreadyRegistered();
			case 'interrupted':
				return $LL.account_passkeyRegistrationInterrupted();
			case 'authenticator-unsupported':
				return $LL.account_passkeyAuthenticatorUnsupported();
			case 'authenticator-unavailable':
				return $LL.account_passkeyAuthenticatorUnavailable();
			case 'configuration':
				return $LL.account_passkeyConfigurationError();
			case 'failed':
				return $LL.account_passkeyRegistrationFailed();
		}
	}

	function syncSecurityRefreshingAreas() {
		securityRefreshingAreas = ALL_SECURITY_AREAS.filter(
			(area) => (securityRefreshCounts.get(area) ?? 0) > 0
		);
	}

	function beginSecurityRefresh(areas: SecurityArea[]) {
		for (const area of areas) {
			securityRefreshCounts.set(area, (securityRefreshCounts.get(area) ?? 0) + 1);
		}
		syncSecurityRefreshingAreas();
	}

	function endSecurityRefresh(areas: SecurityArea[]) {
		for (const area of areas) {
			const nextCount = (securityRefreshCounts.get(area) ?? 0) - 1;
			if (nextCount > 0) {
				securityRefreshCounts.set(area, nextCount);
			} else {
				securityRefreshCounts.delete(area);
			}
		}
		syncSecurityRefreshingAreas();
	}

	function securityAreasRefreshing(areas: SecurityArea[]): boolean {
		return areas.some((area) => securityRefreshingAreas.includes(area));
	}

	function configuredScreen(screenKey: string): AccountPageScreen | null {
		return (
			accountCapabilities?.account_page?.screens.find(
				(screen) => screen.screen_key === screenKey
			) ?? null
		);
	}

	function localeVariants(locale: string): string[] {
		return [...new Set([locale, locale.replace('_', '-'), locale.split('-')[0]])];
	}

	function localeCandidates(locale: string): string[] {
		return [...localeVariants(locale), ...localeVariants(languageStore.defaultLocale)].filter(
			(candidate, index, values) => values.indexOf(candidate) === index
		);
	}

	function localizedPageCopy(): { title: string; description: string } {
		const definition = accountCapabilities?.account_page?.definition;
		const localizations = localeCandidates(currentLocale).map(
			(locale) => definition?.localizations?.[locale]
		);
		const themeTitle = localeCandidates(currentLocale)
			.map((locale) => loginUIPageStore.getLocalizedText(locale, 'accountTitle'))
			.find((value): value is string => Boolean(value));
		return {
			title:
				themeTitle ??
				localizations.find((entry) => Boolean(entry?.title))?.title ??
				definition?.title ??
				$LL.account_title(),
			description:
				localizations.find((entry) => Boolean(entry?.description))?.description ??
				definition?.description ??
				''
		};
	}

	function placementVisible(condition: string): boolean {
		switch (condition) {
			case 'hidden':
				return false;
			case 'passkey_enabled':
				return Boolean(authenticationMethods?.passkey?.enabled);
			case 'totp_enabled':
				return totpManagementEnabled;
			case 'external_idp_enabled':
				return Boolean(authenticationMethods?.external?.enabled);
			case 'consent_records_available':
				if (consentsLoading && initialPlacementConditions.consentRecordsAvailable !== null) {
					return initialPlacementConditions.consentRecordsAvailable;
				}
				return consents.length > 0;
			case 'multiple_sessions':
				if (sessionsLoading && initialPlacementConditions.multipleSessions !== null) {
					return initialPlacementConditions.multipleSessions;
				}
				return sessions.length > 1;
			default:
				return true;
		}
	}

	function safeHref(value: string | null | undefined): string | null {
		if (!value) return null;
		if (/^#[a-zA-Z][\w-]*$/u.test(value) || /^\/(?!\/)/u.test(value)) return value;
		try {
			const url = new URL(value);
			return url.protocol === 'https:' ? url.toString() : null;
		} catch {
			return null;
		}
	}

	function localizedScreenFields(screen: AccountPageScreen): AccountPageScreenField[] {
		const localized =
			localeVariants(currentLocale)
				.map((locale) => screen.localizations?.[locale]?.fields)
				.find((fields) => fields && Object.keys(fields).length > 0) ?? {};
		const defaultLocalized =
			localeVariants(languageStore.defaultLocale)
				.map((locale) => screen.localizations?.[locale]?.fields)
				.find((fields) => fields && Object.keys(fields).length > 0) ?? {};
		return [...screen.fields]
			.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
			.map((field, index) => {
				const key = field.block_id ?? `${field.field}-${index}`;
				const localizedField = {
					...field,
					...(defaultLocalized[key] ?? {}),
					...(localized[key] ?? {})
				};
				return screen.screen_key === 'account_overview' &&
					field.field === 'heading.account_overview'
					? { ...localizedField, text: undefined }
					: localizedField;
			})
			.filter(
				(field) =>
					screen.screen_key !== 'account_overview' || field.field !== 'link.account_security'
			);
	}

	function accountWidgetTitle(field: AccountPageScreenField): string {
		const defaultTitles: Partial<
			Record<NonNullable<AccountPageScreenField['block_type']>, string>
		> = {
			account_profile_widget: $LL.account_profileTitle(),
			account_device_list_widget: $LL.account_devices(),
			account_session_widget: $LL.account_sessions(),
			account_passkey_widget: $LL.account_passkeys(),
			account_totp_widget: $LL.account_totp(),
			account_consent_widget: $LL.account_consentTitle(),
			account_activity_widget: $LL.account_activityTitle(),
			account_social_account_widget: $LL.account_socialAccounts()
		};
		const title = defaultTitles[field.block_type ?? 'text'];
		const defaultLabels = new Set([
			'User profile',
			'Devices',
			'Connected apps and devices',
			'Sessions',
			'Signed-in devices',
			'Passkeys',
			'Authenticator app',
			'Consent information',
			'Account activity',
			'Connected accounts'
		]);
		const systemWidgetFields = new Set([
			'account.profile',
			'account.devices',
			'account.sessions',
			'account.passkeys',
			'account.totp',
			'account.consents',
			'account.activity',
			'account.social_accounts'
		]);
		return !field.label ||
			defaultLabels.has(field.label) ||
			(!field.block_id && systemWidgetFields.has(field.field))
			? (title ?? field.label)
			: field.label;
	}

	function isDedicatedLoginUiHostname(hostname: string): boolean {
		const firstLabel = hostname.split('.')[0]?.toLowerCase() ?? '';
		return firstLabel === 'login' || hostname.toLowerCase().includes('ar-login-ui');
	}

	function getCanonicalAccountUrl(): string | null {
		if (!isDedicatedLoginUiHostname(window.location.hostname)) {
			return null;
		}

		try {
			const canonicalOrigin = new URL(getAuthConfig().issuer).origin;
			if (canonicalOrigin === window.location.origin) {
				return null;
			}

			return `${canonicalOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`;
		} catch {
			return null;
		}
	}

	onMount(async () => {
		const canonicalAccountUrl = getCanonicalAccountUrl();
		if (canonicalAccountUrl) {
			window.location.replace(canonicalAccountUrl);
			return;
		}

		// Start account data immediately. WebAuthn capability detection can take noticeably
		// longer in Safari and must not hold back the composition request or widget skeletons.
		const accountLoadRequest = loadAccountPage();
		const passkeySupportRequest = detectPasskeySupport();
		const methodsRequest = embeddedAuthenticationMethods
			? Promise.resolve({ data: embeddedAuthenticationMethods })
			: fetchAuthenticationMethods();
		if (!embeddedAuthenticationMethods) {
			void methodsRequest
				.then((methodsResult) => {
					authenticationMethods = methodsResult.data?.methods ?? null;
				})
				.finally(() => {
					authenticationMethodsLoading = false;
				});
		}
		passkeySupported = await passkeySupportRequest;
		const accountLoadStatus = await accountLoadRequest;

		if (accountLoadStatus === 'unauthorized') {
			const returnTo = `${window.location.pathname}${window.location.search}`;
			const result = await accountAPI.createAccountReturn(returnTo);
			const accountReturn = result.data?.account_return;
			window.location.href = accountReturn
				? `/login?account_return=${encodeURIComponent(accountReturn)}`
				: '/login';
			return;
		}

		const methodsResult = await methodsRequest;
		if (methodsResult.data?.ui.selfService?.accountPageEnabled !== true) {
			window.location.href = '/';
			return;
		}
	});

	onMount(() => {
		const handleLocaleChange = (event: Event) => {
			const locale = (event as CustomEvent<{ locale?: string }>).detail?.locale;
			if (locale) {
				currentLocale = locale as Locales;
				void refreshLocalizedAccountData(locale);
			}
		};
		window.addEventListener('authrim:locale-change', handleLocaleChange);
		return () => window.removeEventListener('authrim:locale-change', handleLocaleChange);
	});

	onDestroy(() => {
		emailChangePollGeneration += 1;
		consentLoadGeneration += 1;
	});

	async function detectPasskeySupport(): Promise<boolean> {
		return window.isSecureContext && window.PublicKeyCredential !== undefined;
	}

	function syncAuthFromAccountProfile(
		nextProfile: AccountProfile,
		nextSession: AccountProfileSession
	) {
		auth.login(nextSession.id, {
			userId: nextProfile.user_id,
			email: nextProfile.email || '',
			name: nextProfile.name || undefined,
			authTime: nextSession.auth_time,
			acr: nextSession.acr,
			amr: nextSession.amr
		});
	}

	async function loadAccountPage(): Promise<'ok' | 'unauthorized' | 'error'> {
		accountError = '';
		securityErrors = {};
		consentError = '';
		reauthNeeded = false;
		profileLoading = true;
		devicesLoading = true;
		sessionsLoading = true;
		passkeysLoading = true;
		totpLoading = true;
		operationsLoading = true;
		consentsLoading = true;
		capabilitiesLoading = !embeddedCapabilitiesResolved;
		const profileRequest = accountAPI.getProfile();
		const passkeysRequest = accountAPI.getPasskeys();
		const initialConsentGeneration = ++consentLoadGeneration;

		void accountAPI
			.getDevices()
			.then((result) => {
				devices = result.data?.devices ?? [];
				recordSecurityLoadError('devices', result.error);
			})
			.finally(() => {
				devicesLoading = false;
			});
		void accountAPI
			.getSessions()
			.then((result) => {
				sessions = result.data?.sessions ?? [];
				recordSecurityLoadError('sessions', result.error);
			})
			.finally(() => {
				sessionsLoading = false;
			});
		void passkeysRequest
			.then((result) => {
				passkeys = result.data?.passkeys ?? [];
				recordSecurityLoadError('passkeys', result.error);
			})
			.finally(() => {
				passkeysLoading = false;
			});
		void accountAPI
			.getTotpCredentials()
			.then((result) => {
				totpCredentials = result.data?.credentials ?? [];
				totpBackupCodes = result.data?.backup_codes ?? { total: 0, remaining: 0 };
				recordSecurityLoadError('totp', result.error);
			})
			.finally(() => {
				totpLoading = false;
			});
		void accountAPI
			.getOperations()
			.then((result) => {
				operations = result.data?.operations ?? [];
			})
			.finally(() => {
				operationsLoading = false;
			});
		void accountAPI
			.getConsents(getLocale())
			.then((result) => {
				if (initialConsentGeneration !== consentLoadGeneration) return;
				consents = result.data?.consents ?? [];
				consentError = result.error ? localizeApiError(result.error, $LL.account_loadFailed()) : '';
			})
			.finally(() => {
				if (initialConsentGeneration === consentLoadGeneration) {
					consentsLoading = false;
				}
			});
		if (!embeddedCapabilitiesResolved) {
			void accountAPI
				.getCapabilities()
				.then((result) => {
					if (result.data) {
						accountCapabilities = result.data;
						capabilitiesResolved = true;
					}
				})
				.finally(() => {
					capabilitiesLoading = false;
				});
		}

		const profileResult = await profileRequest;

		if (profileResult.error) {
			if (profileResult.error.error === 'unauthorized') {
				return 'unauthorized';
			}
			profileLoading = false;
			accountError = localizeApiError(profileResult.error, $LL.account_loadFailed());
			return 'error';
		}
		profileLoading = false;
		profile = profileResult.data?.profile ?? null;
		if (profile && profileResult.data?.session) {
			syncAuthFromAccountProfile(profile, profileResult.data.session);
		}
		void passkeysRequest
			.then((result) => signalAllAcceptedCredentials(result.data?.webauthn_signal))
			.catch(() => undefined);
		void signalCurrentUserDetails(profile).catch(() => undefined);
		return 'ok';
	}

	function recordSecurityLoadError(area: SecurityArea, error: APIError | null | undefined) {
		setSecurityError(area, error ? localizeApiError(error, $LL.account_loadFailed()) : '');
	}

	async function refreshLocalizedAccountData(locale: string) {
		const generation = ++consentLoadGeneration;
		consentsLoading = true;
		const result = await accountAPI.getConsents(locale);
		if (generation !== consentLoadGeneration) return;
		if (result.data) {
			consents = result.data.consents;
			consentError = '';
		} else if (result.error) {
			consentError = localizeApiError(result.error, $LL.account_loadFailed());
		}
		consentsLoading = false;
	}

	async function refreshSecurity(areas?: SecurityArea[]) {
		const requestedAreas = areas ? [...new Set(areas)] : [...ALL_SECURITY_AREAS];
		const refreshAll = areas === undefined;
		beginSecurityRefresh(requestedAreas);
		try {
			reauthNeeded = false;
			const [devicesResult, sessionsResult, passkeysResult, totpResult, operationsResult] =
				await Promise.all([
					requestedAreas.includes('devices') ? accountAPI.getDevices() : null,
					requestedAreas.includes('sessions') ? accountAPI.getSessions() : null,
					requestedAreas.includes('passkeys') ? accountAPI.getPasskeys() : null,
					requestedAreas.includes('totp') ? accountAPI.getTotpCredentials() : null,
					refreshAll ? accountAPI.getOperations() : null
				]);
			devices = devicesResult?.data?.devices ?? devices;
			sessions = sessionsResult?.data?.sessions ?? sessions;
			passkeys = passkeysResult?.data?.passkeys ?? passkeys;
			totpCredentials = totpResult?.data?.credentials ?? totpCredentials;
			totpBackupCodes = totpResult?.data?.backup_codes ?? totpBackupCodes;
			operations = operationsResult?.data?.operations ?? operations;
			await signalAllAcceptedCredentials(passkeysResult?.data?.webauthn_signal);
			if (devicesResult) recordSecurityLoadError('devices', devicesResult.error);
			if (sessionsResult) recordSecurityLoadError('sessions', sessionsResult.error);
			if (passkeysResult) recordSecurityLoadError('passkeys', passkeysResult.error);
			if (totpResult) recordSecurityLoadError('totp', totpResult.error);
			if (requestedAreas.includes('social')) setSecurityError('social', '');
		} finally {
			endSecurityRefresh(requestedAreas);
		}
	}

	function requestReauth(action?: typeof pendingReauthAction) {
		pendingReauthAction = action ?? pendingReauthAction;
		reauthError = '';
		emailReauthChallengeId = '';
		emailReauthCode = '';
		emailReauthMaskedEmail = '';
		emailReauthCodeSent = false;
		totpReauthCode = '';
		reauthModalOpen = true;
	}

	async function finishReauth() {
		await auth.refreshFromSession();
		reauthNeeded = false;
		clearSecurityErrors();
		reauthModalOpen = false;
		emailReauthChallengeId = '';
		emailReauthCode = '';
		emailReauthMaskedEmail = '';
		emailReauthCodeSent = false;
		totpReauthCode = '';
		await refreshSecurity();

		const pending = pendingReauthAction;
		pendingReauthAction = null;
		if (pending?.type === 'add-passkey') {
			await addPasskey(pending.deviceName);
		} else if (pending?.type === 'delete-passkey') {
			await deletePasskey(pending.id);
		} else if (pending?.type === 'add-totp') {
			await startTotpEnrollment(pending.label);
		} else if (pending?.type === 'delete-totp') {
			await deleteTotpCredential(pending.id, pending.code);
		} else if (pending?.type === 'regenerate-totp-backup-codes') {
			await regenerateTotpBackupCodes(pending.code);
		} else if (pending?.type === 'change-email') {
			await startEmailChange(pending.email);
		}
	}

	async function completePasskeyReauth() {
		if (!passkeyReauthAvailable || reauthLoading) return;
		reauthLoading = true;
		reauthError = '';
		try {
			const optionsResult = await accountAPI.createPasskeyReauthOptions();
			if (optionsResult.error) {
				reauthError = localizeApiError(optionsResult.error, $LL.account_actionFailed());
				return;
			}

			const credential = await startAuthentication({
				optionsJSON: optionsResult.data!.options
			});
			const completeResult = await accountAPI.completePasskeyReauth(
				optionsResult.data!.challenge_id,
				credential
			);
			if (completeResult.error) {
				reauthError = localizeApiError(completeResult.error, $LL.account_actionFailed());
				return;
			}

			await finishReauth();
		} catch (error) {
			reauthError = messageForCaughtError(error, $LL.account_actionFailed());
		} finally {
			reauthLoading = false;
		}
	}

	async function sendEmailCodeReauth() {
		if (!emailCodeReauthAvailable || reauthLoading) return;
		reauthLoading = true;
		reauthError = '';
		try {
			const result = await accountAPI.sendEmailCodeReauth();
			if (result.error) {
				reauthError = localizeApiError(result.error, $LL.account_actionFailed());
				return;
			}
			emailReauthChallengeId = result.data!.challenge_id;
			emailReauthMaskedEmail = result.data!.masked_email;
			emailReauthCode = '';
			emailReauthCodeSent = true;
		} catch (error) {
			reauthError = messageForCaughtError(error, $LL.account_actionFailed());
		} finally {
			reauthLoading = false;
		}
	}

	async function completeEmailCodeReauth() {
		if (!emailCodeReauthAvailable || !emailReauthChallengeId || reauthLoading) return;
		reauthLoading = true;
		reauthError = '';
		try {
			const result = await accountAPI.completeEmailCodeReauth(
				emailReauthChallengeId,
				emailReauthCode
			);
			if (result.error) {
				reauthError = localizeApiError(result.error, $LL.account_actionFailed());
				return;
			}
			await finishReauth();
		} catch (error) {
			reauthError = messageForCaughtError(error, $LL.account_actionFailed());
		} finally {
			reauthLoading = false;
		}
	}

	async function completeTotpReauth() {
		if (!totpReauthAvailable || reauthLoading) return;
		reauthLoading = true;
		reauthError = '';
		try {
			const result = await accountAPI.completeTotpReauth(totpReauthCode.trim());
			if (result.error) {
				reauthError = localizeApiError(result.error, $LL.account_actionFailed());
				return;
			}
			await finishReauth();
		} catch (error) {
			reauthError = messageForCaughtError(error, $LL.account_actionFailed());
		} finally {
			reauthLoading = false;
		}
	}

	async function saveProfileName(name: string) {
		profileError = '';
		profileSaved = false;
		profileSaving = true;
		try {
			const result = await accountAPI.updateProfileName(name);
			if (result.error) {
				profileError = localizeApiError(result.error, $LL.account_saveFailed());
				return;
			}
			profile = result.data?.profile ?? profile;
			profileSaved = true;
			await auth.refreshFromSession();
			await signalCurrentUserDetails(profile);
			await refreshSecurity();
		} finally {
			profileSaving = false;
		}
	}

	async function refreshProfileAfterEmailChange() {
		const [result, operationsResult] = await Promise.all([
			accountAPI.getProfile(),
			accountAPI.getOperations()
		]);
		if (!result.data) {
			emailChangeError = localizeApiError(result.error, $LL.account_loadFailed());
			return;
		}
		profile = result.data.profile;
		operations = operationsResult.data?.operations ?? operations;
		syncAuthFromAccountProfile(result.data.profile, result.data.session);
		await signalCurrentUserDetails(profile);
	}

	async function finishEmailChangeOperation(operation: IdentifierReplacementOperation) {
		if (operation.state === 'completed') {
			await refreshProfileAfterEmailChange();
			emailChangeStage = 'completed';
			emailChangeLoading = false;
			return true;
		}
		if (operation.state === 'blocked_forward_repair' || operation.state === 'canceled') {
			emailChangeError = $LL.account_actionFailed();
			emailChangeLoading = false;
			return true;
		}
		return false;
	}

	async function pollEmailChange(operationId: string, generation: number) {
		for (let attempt = 0; attempt < 120 && generation === emailChangePollGeneration; attempt += 1) {
			await new Promise((resolve) => window.setTimeout(resolve, 1500));
			if (generation !== emailChangePollGeneration) return;
			const result = await accountAPI.getIdentifierReplacement(operationId);
			if (result.error) {
				if (attempt === 119) {
					emailChangeError = localizeApiError(result.error, $LL.account_actionFailed());
					emailChangeLoading = false;
				}
				continue;
			}
			if (result.data && (await finishEmailChangeOperation(result.data.operation))) return;
		}
		if (generation === emailChangePollGeneration) {
			emailChangeError = $LL.account_actionFailed();
			emailChangeLoading = false;
		}
	}

	async function startEmailChange(email: string) {
		emailChangeError = '';
		emailChangeLoading = true;
		const result = await accountAPI.startIdentifierReplacement(email.trim());
		if (result.error?.error === 'reauthentication_required') {
			emailChangeLoading = false;
			requestReauth({ type: 'change-email', email: email.trim() });
			return;
		}
		if (!result.data) {
			emailChangeError = localizeApiError(result.error, $LL.account_actionFailed());
			emailChangeLoading = false;
			return;
		}
		emailChangeChallengeId = result.data.challenge_id;
		emailChangeIdempotencyKey = crypto.randomUUID();
		emailChangeStage = 'challenge';
		emailChangeLoading = false;
	}

	async function completeEmailChange(code: string) {
		if (!emailChangeChallengeId || !emailChangeIdempotencyKey) return;
		emailChangeError = '';
		emailChangeLoading = true;
		const result = await accountAPI.completeIdentifierReplacement(
			emailChangeChallengeId,
			code.trim(),
			emailChangeIdempotencyKey
		);
		if (result.error?.error === 'reauthentication_required') {
			emailChangeLoading = false;
			requestReauth();
			return;
		}
		if (!result.data) {
			emailChangeError = localizeApiError(result.error, $LL.account_actionFailed());
			emailChangeLoading = false;
			return;
		}
		if (await finishEmailChangeOperation(result.data.operation)) return;
		emailChangeStage = 'processing';
		const generation = ++emailChangePollGeneration;
		void pollEmailChange(result.data.operation.id, generation);
	}

	function cancelEmailChange() {
		emailChangePollGeneration += 1;
		emailChangeStage = 'idle';
		emailChangeLoading = false;
		emailChangeError = '';
		emailChangeChallengeId = '';
		emailChangeIdempotencyKey = '';
	}

	async function revokeSession(id: string) {
		actionLoading = `session:${id}`;
		setSecurityError('sessions', '');
		try {
			const result = await accountAPI.revokeSession(id);
			if (result.error) {
				setSecurityError('sessions', localizeApiError(result.error, $LL.account_actionFailed()));
				return;
			}
			if (result.data?.session.current) {
				await auth.logout();
				window.location.href = '/';
				return;
			}
			await refreshSecurity();
		} finally {
			actionLoading = '';
		}
	}

	async function addPasskey(deviceName: string) {
		if (!passkeySupported) return;
		actionLoading = 'passkey:add';
		setSecurityError('passkeys', '');
		try {
			const optionsResult = await accountAPI.createPasskeyOptions(deviceName.trim());
			if (optionsResult.error) {
				if (optionsResult.error.error === 'reauth_required') {
					setSecurityError('passkeys', $LL.account_reauthRequired());
					reauthNeeded = true;
					requestReauth({ type: 'add-passkey', deviceName });
					return;
				}
				setSecurityError(
					'passkeys',
					localizeApiError(optionsResult.error, $LL.account_actionFailed())
				);
				return;
			}
			let credential: Awaited<ReturnType<typeof startRegistration>>;
			try {
				credential = await startRegistration({
					optionsJSON: optionsResult.data!.options
				});
			} catch (error) {
				setSecurityError('passkeys', localizedPasskeyRegistrationError(error));
				return;
			}
			const completeResult = await accountAPI.completePasskeyRegistration(
				optionsResult.data!.challenge_id,
				credential,
				deviceName.trim()
			);
			if (completeResult.error) {
				if (shouldSignalUnknownCredentialAfterRegistrationFailure(completeResult.error)) {
					await signalUnknownCredential(credential.id);
				}
				setSecurityError(
					'passkeys',
					localizeApiError(completeResult.error, $LL.account_actionFailed())
				);
				return;
			}
			await signalAllAcceptedCredentials(completeResult.data?.webauthn_signal);
			await refreshSecurity();
		} catch (error) {
			setSecurityError(
				'passkeys',
				messageForCaughtError(error, $LL.account_passkeyRegistrationFailed())
			);
		} finally {
			actionLoading = '';
		}
	}

	async function deletePasskey(id: string) {
		actionLoading = `passkey:${id}`;
		setSecurityError('passkeys', '');
		try {
			const result = await accountAPI.deletePasskey(id);
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					setSecurityError('passkeys', $LL.account_reauthRequired());
					reauthNeeded = true;
					requestReauth({ type: 'delete-passkey', id });
					return;
				}
				if (result.error.error === 'remaining_login_method_required') {
					setSecurityError('passkeys', $LL.account_remainingLoginMethodRequired());
					return;
				}
				setSecurityError('passkeys', localizeApiError(result.error, $LL.account_actionFailed()));
				return;
			}
			await signalAllAcceptedCredentials(result.data?.webauthn_signal);
			await refreshSecurity();
		} finally {
			actionLoading = '';
		}
	}

	async function startTotpEnrollment(label: string) {
		actionLoading = 'totp:add';
		setSecurityError('totp', '');
		try {
			const result = await accountAPI.createTotpOptions(label.trim());
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					setSecurityError('totp', $LL.account_reauthRequired());
					reauthNeeded = true;
					requestReauth({ type: 'add-totp', label });
					return;
				}
				setSecurityError('totp', localizeApiError(result.error, $LL.account_actionFailed()));
				return;
			}
			if (!result.data) return;
			totpEnrollment = {
				credentialId: result.data.credential.id,
				secret: result.data.secret,
				otpauthUri: result.data.otpauth_uri,
				backupCodes: []
			};
			await refreshSecurity();
		} finally {
			actionLoading = '';
		}
	}

	async function activateTotpEnrollment(code: string) {
		if (!totpEnrollment) return;
		actionLoading = `totp:activate:${totpEnrollment.credentialId}`;
		setSecurityError('totp', '');
		try {
			const result = await accountAPI.activateTotpCredential(
				totpEnrollment.credentialId,
				code.trim()
			);
			if (result.error) {
				setSecurityError('totp', localizeApiError(result.error, $LL.account_actionFailed()));
				return;
			}
			totpEnrollment = {
				...totpEnrollment,
				backupCodes: result.data?.backup_codes ?? []
			};
			await refreshSecurity();
		} finally {
			actionLoading = '';
		}
	}

	async function deleteTotpCredential(id: string, code: string) {
		actionLoading = `totp:${id}`;
		setSecurityError('totp', '');
		try {
			const result = await accountAPI.deleteTotpCredential(id, buildTotpDeleteProof(code));
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					setSecurityError('totp', $LL.account_reauthRequired());
					reauthNeeded = true;
					requestReauth({ type: 'delete-totp', id, code });
					return;
				}
				if (result.error.error === 'remaining_login_method_required') {
					setSecurityError('totp', $LL.account_remainingLoginMethodRequired());
					return;
				}
				setSecurityError('totp', localizeApiError(result.error, $LL.account_actionFailed()));
				return;
			}
			await refreshSecurity();
		} finally {
			actionLoading = '';
		}
	}

	async function regenerateTotpBackupCodes(code: string) {
		actionLoading = 'totp:backup-codes';
		setSecurityError('totp', '');
		try {
			const result = await accountAPI.regenerateTotpBackupCodes(code.trim() || undefined);
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					setSecurityError('totp', $LL.account_reauthRequired());
					reauthNeeded = true;
					requestReauth({ type: 'regenerate-totp-backup-codes', code });
					return;
				}
				setSecurityError('totp', localizeApiError(result.error, $LL.account_actionFailed()));
				return;
			}
			totpEnrollment = {
				credentialId: '',
				secret: '',
				otpauthUri: '',
				backupCodes: result.data?.backup_codes ?? []
			};
			await refreshSecurity();
		} finally {
			actionLoading = '';
		}
	}

	async function handleLogout() {
		if (logoutLoading) return;
		logoutLoading = true;
		accountError = '';
		try {
			await auth.logout();
			window.location.href = '/';
		} catch {
			accountError = $LL.account_actionFailed();
			logoutLoading = false;
		}
	}
</script>

<svelte:head>
	<title
		>{localizedPageCopy().title || $LL.account_title()} - {brandingStore.brandName ||
			$LL.app_title()}</title
	>
</svelte:head>

<div class="account-shell">
	<div class="account-layout">
		<header class="account-header">
			<div>
				<p class="account-kicker">{brandingStore.brandName || $LL.app_title()}</p>
				<h1>{localizedPageCopy().title}</h1>
				{#if localizedPageCopy().description}<p class="account-description">
						{localizedPageCopy().description}
					</p>{/if}
			</div>
			<Button variant="secondary" loading={logoutLoading} onclick={handleLogout}>
				{$LL.header_logout()}
			</Button>
		</header>

		{#if accountError}
			<p class="account-error" role="alert">{accountError}</p>
		{/if}

		<section class="account-grid" aria-busy={profileLoading || capabilitiesLoading}>
			{#if capabilitiesLoading || !capabilitiesResolved}
				<!-- Wait for the published composition so unused widgets never flash as skeletons. -->
			{:else if accountCapabilities?.account_page}
				{#each accountCapabilities.account_page.definition.screens.filter((item) => item.enabled && placementVisible(item.condition)) as placement (placement.id)}
					{@const screen = configuredScreen(placement.screen_key)}
					{#if screen}
						<section
							id={placement.id}
							class="account-screen"
							class:full={placement.width === 'full'}
							class:overview={screen.screen_key === 'account_overview'}
						>
							{#each localizedScreenFields(screen) as field, fieldIndex (`${field.block_id ?? field.field}-${fieldIndex}`)}
								{#if field.block_type !== 'layout_row'}
									<div
										class="account-screen__block"
										style={placement.width === 'full' &&
										(field.layout_column === 1 || field.layout_column === 2)
											? `grid-column: ${field.layout_column};`
											: undefined}
									>
										{#if field.block_type === 'heading'}
											<header class="account-screen__heading">
												<h2>{field.label}</h2>
												{#if field.text}<p>{field.text}</p>{/if}
											</header>
										{:else if field.block_type === 'text'}
											<p class="account-screen__text">{field.text || field.label}</p>
										{:else if field.block_type === 'link' && safeHref(field.href)}
											<a class="account-screen__link" href={safeHref(field.href) ?? '#'}
												>{field.label}</a
											>
										{:else if field.block_type === 'divider'}
											<div class="account-screen__divider"><span>{field.text ?? ''}</span></div>
										{:else if field.block_type === 'account_profile_widget'}
											<AccountProfileSection
												{profile}
												loading={profileLoading}
												title={accountWidgetTitle(field)}
												saving={profileSaving}
												error={profileError}
												saved={profileSaved}
												{emailChangeStage}
												{emailChangeLoading}
												{emailChangeError}
												onSave={saveProfileName}
												onStartEmailChange={startEmailChange}
												onCompleteEmailChange={completeEmailChange}
												onCancelEmailChange={cancelEmailChange}
											/>
										{:else if field.block_type === 'account_consent_widget'}
											<AccountConsentSection
												{consents}
												loading={consentsLoading}
												title={accountWidgetTitle(field)}
												error={consentError}
											/>
										{:else if field.block_type === 'account_activity_widget'}
											<AccountActivitySection
												{operations}
												loading={operationsLoading}
												title={accountWidgetTitle(field)}
											/>
										{:else if field.block_type === 'account_device_list_widget'}
											<AccountSecuritySection
												{devices}
												{sessions}
												{passkeys}
												{totpCredentials}
												{totpBackupCodes}
												{totpEnrollment}
												areas={['devices']}
												title={accountWidgetTitle(field)}
												showSectionHeadings={false}
												loading={securityAreasRefreshing(['devices'])}
												loadingAreas={initialLoadingAreas(['devices'])}
												{actionLoading}
												error={securityErrorFor(['devices'])}
												{reauthNeeded}
												{passkeySupported}
												{totpManagementEnabled}
												onRefresh={refreshSecurity}
												onRevokeSession={revokeSession}
												onAddPasskey={addPasskey}
												onDeletePasskey={deletePasskey}
												onStartTotpEnrollment={startTotpEnrollment}
												onActivateTotpEnrollment={activateTotpEnrollment}
												onDeleteTotpCredential={deleteTotpCredential}
												onRegenerateTotpBackupCodes={regenerateTotpBackupCodes}
												onClearTotpEnrollment={() => (totpEnrollment = null)}
												onReauth={() => requestReauth()}
											/>
										{:else if field.block_type === 'account_session_widget'}
											<AccountSecuritySection
												{devices}
												{sessions}
												{passkeys}
												{totpCredentials}
												{totpBackupCodes}
												{totpEnrollment}
												areas={['sessions']}
												title={accountWidgetTitle(field)}
												showSectionHeadings={false}
												loading={securityAreasRefreshing(['sessions'])}
												loadingAreas={initialLoadingAreas(['sessions'])}
												{actionLoading}
												error={securityErrorFor(['sessions'])}
												{reauthNeeded}
												{passkeySupported}
												{totpManagementEnabled}
												onRefresh={refreshSecurity}
												onRevokeSession={revokeSession}
												onAddPasskey={addPasskey}
												onDeletePasskey={deletePasskey}
												onStartTotpEnrollment={startTotpEnrollment}
												onActivateTotpEnrollment={activateTotpEnrollment}
												onDeleteTotpCredential={deleteTotpCredential}
												onRegenerateTotpBackupCodes={regenerateTotpBackupCodes}
												onClearTotpEnrollment={() => (totpEnrollment = null)}
												onReauth={() => requestReauth()}
											/>
										{:else if field.block_type === 'account_passkey_widget'}
											<AccountSecuritySection
												{devices}
												{sessions}
												{passkeys}
												{totpCredentials}
												{totpBackupCodes}
												{totpEnrollment}
												areas={['passkeys']}
												title={accountWidgetTitle(field)}
												showSectionHeadings={false}
												loading={securityAreasRefreshing(['passkeys'])}
												loadingAreas={initialLoadingAreas(['passkeys'])}
												{actionLoading}
												error={securityErrorFor(['passkeys'])}
												{reauthNeeded}
												{passkeySupported}
												{totpManagementEnabled}
												onRefresh={refreshSecurity}
												onRevokeSession={revokeSession}
												onAddPasskey={addPasskey}
												onDeletePasskey={deletePasskey}
												onStartTotpEnrollment={startTotpEnrollment}
												onActivateTotpEnrollment={activateTotpEnrollment}
												onDeleteTotpCredential={deleteTotpCredential}
												onRegenerateTotpBackupCodes={regenerateTotpBackupCodes}
												onClearTotpEnrollment={() => (totpEnrollment = null)}
												onReauth={() => requestReauth()}
											/>
										{:else if field.block_type === 'account_totp_widget'}
											<AccountSecuritySection
												{devices}
												{sessions}
												{passkeys}
												{totpCredentials}
												{totpBackupCodes}
												{totpEnrollment}
												areas={['totp']}
												title={accountWidgetTitle(field)}
												showSectionHeadings={false}
												loading={securityAreasRefreshing(['totp'])}
												loadingAreas={initialLoadingAreas(['totp'])}
												{actionLoading}
												error={securityErrorFor(['totp'])}
												{reauthNeeded}
												{passkeySupported}
												{totpManagementEnabled}
												onRefresh={refreshSecurity}
												onRevokeSession={revokeSession}
												onAddPasskey={addPasskey}
												onDeletePasskey={deletePasskey}
												onStartTotpEnrollment={startTotpEnrollment}
												onActivateTotpEnrollment={activateTotpEnrollment}
												onDeleteTotpCredential={deleteTotpCredential}
												onRegenerateTotpBackupCodes={regenerateTotpBackupCodes}
												onClearTotpEnrollment={() => (totpEnrollment = null)}
												onReauth={() => requestReauth()}
											/>
										{:else if field.block_type === 'account_social_account_widget'}
											<AccountSecuritySection
												{devices}
												{sessions}
												{passkeys}
												{totpCredentials}
												{totpBackupCodes}
												{totpEnrollment}
												areas={['social']}
												title={accountWidgetTitle(field)}
												showSectionHeadings={false}
												loading={securityAreasRefreshing(['social'])}
												loadingAreas={initialLoadingAreas(['social'])}
												{actionLoading}
												error={securityErrorFor(['social'])}
												{reauthNeeded}
												{passkeySupported}
												{totpManagementEnabled}
												onRefresh={refreshSecurity}
												onRevokeSession={revokeSession}
												onAddPasskey={addPasskey}
												onDeletePasskey={deletePasskey}
												onStartTotpEnrollment={startTotpEnrollment}
												onActivateTotpEnrollment={activateTotpEnrollment}
												onDeleteTotpCredential={deleteTotpCredential}
												onRegenerateTotpBackupCodes={regenerateTotpBackupCodes}
												onClearTotpEnrollment={() => (totpEnrollment = null)}
												onReauth={() => requestReauth()}
											/>
										{/if}
									</div>
								{/if}
							{/each}
						</section>
					{/if}
				{/each}
			{:else}
				<AccountProfileSection
					{profile}
					loading={profileLoading}
					saving={profileSaving}
					error={profileError}
					saved={profileSaved}
					{emailChangeStage}
					{emailChangeLoading}
					{emailChangeError}
					onSave={saveProfileName}
					onStartEmailChange={startEmailChange}
					onCompleteEmailChange={completeEmailChange}
					onCancelEmailChange={cancelEmailChange}
				/>
				<AccountSecuritySection
					{devices}
					{sessions}
					{passkeys}
					{totpCredentials}
					{totpBackupCodes}
					{totpEnrollment}
					loading={securityAreasRefreshing(ALL_SECURITY_AREAS)}
					loadingAreas={initialLoadingAreas(['devices', 'sessions', 'passkeys', 'totp', 'social'])}
					{actionLoading}
					error={securityErrorFor(ALL_SECURITY_AREAS)}
					{reauthNeeded}
					{passkeySupported}
					{totpManagementEnabled}
					onRefresh={refreshSecurity}
					onRevokeSession={revokeSession}
					onAddPasskey={addPasskey}
					onDeletePasskey={deletePasskey}
					onStartTotpEnrollment={startTotpEnrollment}
					onActivateTotpEnrollment={activateTotpEnrollment}
					onDeleteTotpCredential={deleteTotpCredential}
					onRegenerateTotpBackupCodes={regenerateTotpBackupCodes}
					onClearTotpEnrollment={() => (totpEnrollment = null)}
					onReauth={() => requestReauth()}
				/>
				<AccountConsentSection {consents} loading={consentsLoading} error={consentError} />
				<AccountActivitySection {operations} loading={operationsLoading} />
			{/if}
		</section>
	</div>

	{#if loginUIPageStore.showTopbar}
		<div class="account-preferences" data-position={loginUIPageStore.topbarPosition}>
			<LanguageSwitcher
				showThemeToggle={loginUIPageStore.themeToggleEnabled}
				showLanguageSelect={loginUIPageStore.languageSelectEnabled}
			/>
		</div>
	{/if}

	<ConfiguredFooter locale={currentLocale} class="account-footer" />

	{#if reauthModalOpen}
		<button
			type="button"
			class="reauth-backdrop"
			aria-label={$LL.dialog_close()}
			onclick={() => (reauthModalOpen = false)}
		></button>
		<div
			class="reauth-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="account-reauth-title"
		>
			<div class="reauth-modal__header">
				<h2 id="account-reauth-title">{$LL.account_reauthTitle()}</h2>
				<button
					type="button"
					class="reauth-modal__close"
					aria-label={$LL.dialog_close()}
					onclick={() => (reauthModalOpen = false)}
				>
					x
				</button>
			</div>
			<p>{$LL.account_reauthDescription()}</p>
			{#if reauthError}
				<p class="reauth-error">{reauthError}</p>
			{/if}
			{#if !hasReauthMethod}
				<p class="reauth-error">{$LL.account_reauthNoMethods()}</p>
			{/if}
			<div class="reauth-actions">
				{#if passkeyReauthAvailable}
					<Button variant="primary" loading={reauthLoading} onclick={completePasskeyReauth}>
						{$LL.account_reauthWithPasskey()}
					</Button>
				{/if}
				{#if emailCodeReauthAvailable}
					{#if emailReauthCodeSent}
						<div class="reauth-email-code">
							<p>{$LL.account_reauthEmailCodeSent({ email: emailReauthMaskedEmail })}</p>
							<input
								class="reauth-code-input"
								autocomplete="one-time-code"
								inputmode="numeric"
								maxlength={6}
								placeholder={$LL.account_reauthEmailCodePlaceholder()}
								bind:value={emailReauthCode}
							/>
							<Button
								variant="primary"
								loading={reauthLoading}
								disabled={emailReauthCode.trim().length !== 6}
								onclick={completeEmailCodeReauth}
							>
								{$LL.account_reauthVerifyEmailCode()}
							</Button>
						</div>
					{:else}
						<Button variant="secondary" loading={reauthLoading} onclick={sendEmailCodeReauth}>
							{$LL.account_reauthWithEmailCode()}
						</Button>
					{/if}
				{/if}
				{#if totpReauthAvailable}
					<div class="reauth-email-code">
						<input
							class="reauth-code-input"
							autocomplete="one-time-code"
							inputmode="numeric"
							maxlength={8}
							placeholder={$LL.account_reauthTotpCodePlaceholder()}
							bind:value={totpReauthCode}
						/>
						<Button
							variant="secondary"
							loading={reauthLoading}
							disabled={!/^\d{6}$|^\d{8}$/.test(totpReauthCode.trim())}
							onclick={completeTotpReauth}
						>
							{$LL.account_reauthWithTotp()}
						</Button>
					</div>
				{/if}
				<Button variant="secondary" onclick={() => (reauthModalOpen = false)}>
					{$LL.dialog_cancel()}
				</Button>
			</div>
		</div>
	{/if}
</div>

<style>
	.account-shell {
		--account-card-bg: var(--bg-card, #fefdfa);
		--account-control-bg: var(--bg-input, #ffffff);
		--account-control-hover: var(--surface-muted, var(--bg-subtle, #f7f3ec));
		--account-primary-bg: var(--button-primary-bg, var(--primary, #2c2724));
		--account-primary-hover: var(--primary-hover, #1a1715);
		--account-modal-bg: var(--bg-card, #fffaf3);
		--account-modal-border: var(--border, #ded4c5);

		min-height: 100dvh;
		background: var(--bg-page);
		color: var(--text-primary);
		isolation: isolate;
		padding: 24px;
		display: flex;
		flex-direction: column;
	}

	:global(.account-shell .card),
	:global(.account-shell .form-input),
	:global(.account-shell .theme-toggle),
	:global(.account-shell .auth-lang-select),
	:global(.account-shell .btn),
	:global(.account-shell .btn::after),
	:global(.account-shell .btn::before) {
		transform: none !important;
		filter: none !important;
		backdrop-filter: none !important;
		-webkit-backdrop-filter: none !important;
		transition: none !important;
	}

	:global(.account-shell .card) {
		background: var(--account-card-bg) !important;
		box-shadow: none !important;
	}

	:global(.account-shell .form-input),
	:global(.account-shell .theme-toggle),
	:global(.account-shell .auth-lang-select),
	:global(.account-shell .btn-secondary) {
		background: var(--account-control-bg) !important;
	}

	:global(.account-shell .theme-toggle:hover),
	:global(.account-shell .auth-lang-select:hover),
	:global(.account-shell .btn-secondary:hover:not(:disabled)),
	:global(.account-shell .btn-ghost:hover:not(:disabled)) {
		background: var(--account-control-hover) !important;
	}

	:global(.account-shell .btn-primary) {
		background: var(--account-primary-bg) !important;
		box-shadow: none !important;
	}

	:global(.account-shell .btn-primary:hover:not(:disabled)) {
		background: var(--account-primary-hover) !important;
		box-shadow: none !important;
	}

	:global(.account-shell .btn:hover:not(:disabled)),
	:global(.account-shell .btn-primary:hover:not(:disabled)),
	:global(.account-shell .btn-secondary:hover:not(:disabled)),
	:global(.account-shell .btn-danger:hover:not(:disabled)),
	:global(.account-shell .theme-toggle:hover) {
		transform: none !important;
		filter: none !important;
	}

	:global(.account-shell .btn-primary::after) {
		display: none;
	}

	:global(.account-shell .btn-danger) {
		box-shadow: none !important;
	}

	:global(.account-shell .btn-danger:hover:not(:disabled)) {
		box-shadow: none !important;
	}

	.account-preferences {
		order: 2;
		width: min(1040px, 100%);
		margin: 24px auto 0;
		display: flex;
		justify-content: center;
	}

	.account-preferences[data-position='in_card'] {
		order: -1;
		justify-content: flex-end;
		margin: 0 auto 24px;
	}

	.account-preferences[data-position='top_right'],
	.account-preferences[data-position='bottom_left'],
	.account-preferences[data-position='bottom_center'],
	.account-preferences[data-position='bottom_right'] {
		position: fixed;
		z-index: 40;
		width: auto;
		margin: 0;
	}

	.account-preferences[data-position='top_right'] {
		top: max(20px, env(safe-area-inset-top));
		right: max(20px, env(safe-area-inset-right));
	}

	.account-preferences[data-position='bottom_left'],
	.account-preferences[data-position='bottom_center'],
	.account-preferences[data-position='bottom_right'] {
		bottom: max(20px, env(safe-area-inset-bottom));
	}

	.account-preferences[data-position='bottom_left'] {
		left: max(20px, env(safe-area-inset-left));
	}

	.account-preferences[data-position='bottom_center'] {
		left: 50%;
		transform: translateX(-50%);
	}

	.account-preferences[data-position='bottom_right'] {
		right: max(20px, env(safe-area-inset-right));
	}

	:global(.account-shell .account-footer) {
		order: 3;
		align-self: center;
		margin-top: 32px;
		padding-bottom: max(0px, env(safe-area-inset-bottom));
	}

	:global(.account-shell .account-footer p) {
		margin: 0;
	}

	:global(.account-shell .account-footer p + p) {
		margin-top: 6px;
	}

	.account-layout {
		width: min(1040px, 100%);
		margin: 0 auto;
	}

	.account-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
	}

	.account-description {
		max-width: 60ch;
		margin: 6px 0 0;
		color: var(--text-muted);
		font-size: 0.875rem;
		line-height: 1.6;
	}

	.account-kicker {
		margin: 0 0 4px;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	h1 {
		margin: 0;
	}

	h1 {
		font-size: 1.75rem;
	}

	.account-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
	}

	.account-screen {
		display: grid;
		min-width: 0;
		gap: 12px;
	}

	.account-screen.full {
		grid-column: 1 / -1;
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.account-screen.overview {
		border: 1px solid var(--border-glass);
		border-radius: var(--card-radius, var(--radius-xl));
		background: var(--account-card-bg);
		box-shadow: none;
		padding: var(--auth-card-padding, var(--card-padding, 24px));
	}

	.account-screen__block {
		min-width: 0;
		grid-column: 1 / -1;
	}

	.account-screen__heading h2,
	.account-screen__heading p,
	.account-screen__text {
		margin: 0;
	}

	.account-screen__heading h2 {
		font-size: 1.05rem;
	}

	.account-screen__heading p,
	.account-screen__text {
		margin-top: 4px;
		color: var(--text-muted);
		font-size: 0.875rem;
		line-height: 1.65;
	}

	.account-screen__divider {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.account-screen__divider::before,
	.account-screen__divider::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--border);
	}

	.account-error {
		margin: 0;
		color: var(--danger);
	}

	.reauth-backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
		border: 0;
		background: rgb(0 0 0 / 0.62);
		backdrop-filter: blur(3px);
		-webkit-backdrop-filter: blur(3px);
		cursor: default;
	}

	.reauth-modal {
		position: fixed;
		z-index: 41;
		top: 50%;
		left: 50%;
		width: min(calc(100vw - 32px), 420px);
		transform: translate(-50%, -50%);
		display: grid;
		gap: 16px;
		padding: 24px;
		border-radius: 16px;
		border: 1px solid var(--account-modal-border);
		background: var(--account-modal-bg);
		box-shadow: 0 24px 70px rgb(0 0 0 / 0.28);
		isolation: isolate;
	}

	.reauth-modal__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.reauth-modal h2,
	.reauth-modal p {
		margin: 0;
	}

	.reauth-modal h2 {
		font-size: 1.125rem;
	}

	.reauth-modal p {
		color: var(--text-muted);
		line-height: 1.6;
	}

	.reauth-modal__close {
		width: 32px;
		height: 32px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 1.25rem;
		line-height: 1;
	}

	.reauth-error {
		color: var(--danger) !important;
		font-weight: 600;
	}

	.reauth-actions {
		display: grid;
		gap: 8px;
	}

	.reauth-email-code {
		display: grid;
		gap: 10px;
	}

	.reauth-code-input {
		width: 100%;
		min-height: 44px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-primary);
		font: inherit;
		letter-spacing: 0.08em;
		padding: 0 14px;
	}

	@media (max-width: 760px) {
		.account-shell {
			padding: 16px;
		}

		.account-grid {
			grid-template-columns: 1fr;
		}

		.account-screen.full {
			grid-column: auto;
			grid-template-columns: 1fr;
		}

		.account-screen__block {
			grid-column: 1 !important;
		}

		.account-header {
			align-items: flex-start;
			gap: 16px;
		}
	}
</style>

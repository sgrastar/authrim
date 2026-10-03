<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
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
	import AccountLauncherSection from '$lib/components/account/AccountLauncherSection.svelte';
	import AccountReauthDialog, {
		type AccountReauthMethod
	} from '$lib/components/account/AccountReauthDialog.svelte';
	import AccountScreenBlock, {
		isAccountScreenStaticBlock
	} from '$lib/components/account/AccountScreenBlock.svelte';
	import AccountScreenPlacement from '$lib/components/account/AccountScreenPlacement.svelte';
	import AccountShell from '$lib/components/account/AccountShell.svelte';
	import AccountUpgradeSection from '$lib/components/account/AccountUpgradeSection.svelte';
	import AccountActivityWidget from '$lib/components/account/widgets/AccountActivityWidget.svelte';
	import AccountConsentWidget from '$lib/components/account/widgets/AccountConsentWidget.svelte';
	import AccountDevicesWidget from '$lib/components/account/widgets/AccountDevicesWidget.svelte';
	import AccountPasskeysWidget from '$lib/components/account/widgets/AccountPasskeysWidget.svelte';
	import AccountProfileWidget from '$lib/components/account/widgets/AccountProfileWidget.svelte';
	import AccountSessionsWidget from '$lib/components/account/widgets/AccountSessionsWidget.svelte';
	import AccountSocialAccountsWidget from '$lib/components/account/widgets/AccountSocialAccountsWidget.svelte';
	import AccountTotpWidget from '$lib/components/account/widgets/AccountTotpWidget.svelte';
	import AccountWidgetPanel from '$lib/components/account/widgets/AccountWidgetPanel.svelte';
	import {
		fetchAuthenticationMethods,
		type AuthenticationMethods,
		type AuthenticationMethodsResponse
	} from '$lib/api/authentication-methods';
	import { logoutWithGuestWarning } from '$lib/account/guest-logout';
	import { isPlacementVisibleForRegistrationState } from '$lib/account/account-page-visibility';
	import { safeAccountScreenHref } from '$lib/account/account-screen-href';
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
	let reauthPending = $state<AccountReauthMethod | null>(null);
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
	let totpManagementEnabled = $derived(
		Boolean(
			authenticationMethods?.totp &&
			((authenticationMethods.totp.loginEnabled ?? authenticationMethods.totp.enabled) ||
				(authenticationMethods.totp.accountLinkEnabled ?? false))
		)
	);
	/** First load of one security area: its widget draws a skeleton instead of an empty list. */
	function securityAreaLoading(area: SecurityArea): boolean {
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

	function placementVisible(
		placement: NonNullable<AccountCapabilities['account_page']>['definition']['screens'][number]
	): boolean {
		if (!isPlacementVisibleForRegistrationState(placement, profile?.registration_state)) {
			return false;
		}
		switch (placement.condition) {
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
		return safeAccountScreenHref(value, (placementId) => {
			const target = accountCapabilities?.account_page?.definition.screens.find(
				(placement) => placement.id === placementId
			);
			return Boolean(target?.enabled && placementVisible(target));
		});
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
			account_upgrade_widget: $LL.account_guestTitle(),
			account_profile_widget: $LL.account_profileTitle(),
			account_device_list_widget: $LL.account_devices(),
			account_session_widget: $LL.account_sessions(),
			account_passkey_widget: $LL.account_passkeys(),
			account_totp_widget: $LL.account_totp(),
			account_consent_widget: $LL.account_consentTitle(),
			account_activity_widget: $LL.account_activityTitle(),
			account_social_account_widget: $LL.account_socialAccounts(),
			account_launcher_widget: $LL.account_launcherTitle()
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
			'Connected accounts',
			'My applications'
		]);
		const systemWidgetFields = new Set([
			'account.profile',
			'account.devices',
			'account.sessions',
			'account.passkeys',
			'account.totp',
			'account.consents',
			'account.activity',
			'account.social_accounts',
			'account.launchers'
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
		if (!passkeyReauthAvailable || reauthPending) return;
		reauthPending = 'passkey';
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
			reauthPending = null;
		}
	}

	async function sendEmailCodeReauth() {
		if (!emailCodeReauthAvailable || reauthPending) return;
		reauthPending = 'email';
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
			reauthPending = null;
		}
	}

	async function completeEmailCodeReauth() {
		if (!emailCodeReauthAvailable || !emailReauthChallengeId || reauthPending) return;
		reauthPending = 'email';
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
			reauthPending = null;
		}
	}

	async function completeTotpReauth() {
		if (!totpReauthAvailable || reauthPending) return;
		reauthPending = 'totp';
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
			reauthPending = null;
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

	async function handleLogout(destination = '/') {
		if (logoutLoading) return;
		logoutLoading = true;
		accountError = '';
		try {
			const current = await accountAPI.getProfile();
			if (current.error || !current.data?.session) throw new Error('account_session_unavailable');
			const loggedOut = await logoutWithGuestWarning({
				amr: current.data.session.amr,
				warning: $LL.account_guestLogoutWarning(),
				confirm: (message) => window.confirm(message),
				logout: () => auth.logout()
			});
			if (loggedOut) window.location.href = destination;
			else logoutLoading = false;
		} catch {
			accountError = $LL.account_actionFailed();
			logoutLoading = false;
		}
	}
</script>

<AccountShell
	brandName={brandingStore.brandName}
	title={localizedPageCopy().title}
	description={localizedPageCopy().description}
	locale={currentLocale}
	{logoutLoading}
	onLogout={() => handleLogout()}
	pageError={accountError}
	busy={profileLoading || capabilitiesLoading}
>
	{#if capabilitiesLoading || !capabilitiesResolved}
		<!-- Wait for the published composition so unused widgets never flash as skeletons. -->
	{:else if accountCapabilities?.account_page}
		{#each accountCapabilities.account_page.definition.screens.filter((item) => item.enabled && placementVisible(item)) as placement (placement.id)}
			{@const screen = configuredScreen(placement.screen_key)}
			{#if screen}
				<AccountScreenPlacement
					id={placement.id}
					full={placement.width === 'full'}
					overview={screen.screen_key === 'account_overview'}
					fields={localizedScreenFields(screen)}
				>
					{#snippet block(field)}
						{#if isAccountScreenStaticBlock(field.block_type)}
							<AccountScreenBlock
								{field}
								href={field.block_type === 'link' ? safeHref(field.href) : null}
							/>
						{:else if field.block_type === 'account_upgrade_widget'}
							<AccountUpgradeSection
								title={accountWidgetTitle(field)}
								onExistingLogin={async () => {
									await handleLogout('/login?prompt=login');
								}}
								onCompleted={async () => {
									await auth.refreshFromSession();
									await loadAccountPage();
								}}
							/>
						{:else if field.block_type === 'account_profile_widget'}
							<AccountProfileWidget
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
							<AccountConsentWidget
								{consents}
								loading={consentsLoading}
								title={accountWidgetTitle(field)}
								error={consentError}
							/>
						{:else if field.block_type === 'account_activity_widget'}
							<AccountActivityWidget
								{operations}
								loading={operationsLoading}
								title={accountWidgetTitle(field)}
							/>
						{:else if field.block_type === 'account_device_list_widget'}
							<AccountDevicesWidget
								{devices}
								title={accountWidgetTitle(field)}
								loading={securityAreaLoading('devices')}
								refreshing={securityAreasRefreshing(['devices'])}
								error={securityErrorFor(['devices'])}
								{reauthNeeded}
								onRefresh={() => refreshSecurity(['devices'])}
								onReauthenticate={() => requestReauth()}
							/>
						{:else if field.block_type === 'account_session_widget'}
							<AccountSessionsWidget
								{sessions}
								title={accountWidgetTitle(field)}
								loading={securityAreaLoading('sessions')}
								refreshing={securityAreasRefreshing(['sessions'])}
								{actionLoading}
								error={securityErrorFor(['sessions'])}
								{reauthNeeded}
								onRefresh={() => refreshSecurity(['sessions'])}
								onReauthenticate={() => requestReauth()}
								onRevokeSession={revokeSession}
							/>
						{:else if field.block_type === 'account_passkey_widget'}
							<AccountPasskeysWidget
								{passkeys}
								{passkeySupported}
								title={accountWidgetTitle(field)}
								loading={securityAreaLoading('passkeys')}
								refreshing={securityAreasRefreshing(['passkeys'])}
								{actionLoading}
								error={securityErrorFor(['passkeys'])}
								{reauthNeeded}
								onRefresh={() => refreshSecurity(['passkeys'])}
								onReauthenticate={() => requestReauth()}
								onAddPasskey={addPasskey}
								onDeletePasskey={deletePasskey}
							/>
						{:else if field.block_type === 'account_totp_widget'}
							<AccountTotpWidget
								credentials={totpCredentials}
								backupCodes={totpBackupCodes}
								enrollment={totpEnrollment}
								managementEnabled={totpManagementEnabled}
								title={accountWidgetTitle(field)}
								loading={securityAreaLoading('totp')}
								refreshing={securityAreasRefreshing(['totp'])}
								{actionLoading}
								error={securityErrorFor(['totp'])}
								{reauthNeeded}
								onRefresh={() => refreshSecurity(['totp'])}
								onReauthenticate={() => requestReauth()}
								onStartEnrollment={startTotpEnrollment}
								onActivateEnrollment={activateTotpEnrollment}
								onDeleteCredential={deleteTotpCredential}
								onRegenerateBackupCodes={regenerateTotpBackupCodes}
								onClearEnrollment={() => (totpEnrollment = null)}
							/>
						{:else if field.block_type === 'account_social_account_widget'}
							<AccountSocialAccountsWidget title={accountWidgetTitle(field)} />
						{:else if field.block_type === 'account_launcher_widget'}
							<AccountLauncherSection title={accountWidgetTitle(field)} />
						{/if}
					{/snippet}
				</AccountScreenPlacement>
			{/if}
		{/each}
	{:else}
		<AccountProfileWidget
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
		<AccountWidgetPanel
			title={$LL.account_securityTitle()}
			busy={ALL_SECURITY_AREAS.some(securityAreaLoading)}
			refreshing={securityAreasRefreshing(ALL_SECURITY_AREAS)}
			error={securityErrorFor(ALL_SECURITY_AREAS)}
			{reauthNeeded}
			onRefresh={() => refreshSecurity([...ALL_SECURITY_AREAS])}
			onReauthenticate={() => requestReauth()}
		>
			<AccountDevicesWidget headingLevel={3} {devices} loading={securityAreaLoading('devices')} />
			<AccountSessionsWidget
				headingLevel={3}
				{sessions}
				loading={securityAreaLoading('sessions')}
				{actionLoading}
				onRevokeSession={revokeSession}
			/>
			<AccountPasskeysWidget
				headingLevel={3}
				{passkeys}
				{passkeySupported}
				loading={securityAreaLoading('passkeys')}
				{actionLoading}
				onAddPasskey={addPasskey}
				onDeletePasskey={deletePasskey}
			/>
			<AccountTotpWidget
				headingLevel={3}
				credentials={totpCredentials}
				backupCodes={totpBackupCodes}
				enrollment={totpEnrollment}
				managementEnabled={totpManagementEnabled}
				loading={securityAreaLoading('totp')}
				{actionLoading}
				onStartEnrollment={startTotpEnrollment}
				onActivateEnrollment={activateTotpEnrollment}
				onDeleteCredential={deleteTotpCredential}
				onRegenerateBackupCodes={regenerateTotpBackupCodes}
				onClearEnrollment={() => (totpEnrollment = null)}
			/>
			<AccountSocialAccountsWidget headingLevel={3} />
		</AccountWidgetPanel>
		<AccountConsentWidget {consents} loading={consentsLoading} error={consentError} />
		<AccountActivityWidget {operations} loading={operationsLoading} />
	{/if}

	{#snippet dialog()}
		<AccountReauthDialog
			open={reauthModalOpen}
			passkeyAvailable={passkeyReauthAvailable}
			emailCodeAvailable={emailCodeReauthAvailable}
			totpAvailable={totpReauthAvailable}
			pending={reauthPending}
			emailCodeSent={emailReauthCodeSent}
			maskedEmail={emailReauthMaskedEmail}
			bind:emailCode={emailReauthCode}
			bind:totpCode={totpReauthCode}
			error={reauthError}
			onPasskey={completePasskeyReauth}
			onSendEmailCode={sendEmailCodeReauth}
			onVerifyEmailCode={completeEmailCodeReauth}
			onVerifyTotp={completeTotpReauth}
			onClose={() => (reauthModalOpen = false)}
		/>
	{/snippet}
</AccountShell>

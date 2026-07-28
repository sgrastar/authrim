<script lang="ts">
	import { onMount } from 'svelte';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { Button, Spinner } from '$lib/components';
	import {
		accountAPI,
		type AccountConsent,
		type AccountCapabilities,
		type AccountDevice,
		type AccountOperation,
		type AccountPasskey,
		type AccountProfile,
		type AccountProfileSession,
		type AccountSession,
		type AccountPageScreen,
		type AccountPageScreenField,
		type AccountTotpCredential
	} from '$lib/api/account';
	import AccountActivitySection from '$lib/components/account/AccountActivitySection.svelte';
	import AccountConsentSection from '$lib/components/account/AccountConsentSection.svelte';
	import AccountProfileSection from '$lib/components/account/AccountProfileSection.svelte';
	import AccountSecuritySection from '$lib/components/account/AccountSecuritySection.svelte';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import {
		fetchAuthenticationMethods,
		type AuthenticationMethods
	} from '$lib/api/authentication-methods';
	import { auth } from '$lib/stores/auth';
	import {
		signalAllAcceptedCredentials,
		signalCurrentUserDetails,
		signalUnknownCredential,
		shouldSignalUnknownCredentialAfterRegistrationFailure
	} from '$lib/webauthn/signal';
	import { buildTotpDeleteProof } from '$lib/account/totp-proof';
	import { getAuthConfig } from '$lib/auth';
	import type { APIError } from '$lib/api/client';
	import { messageForCaughtError } from '$lib/errors/display-error';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	const { brandingStore, loginUIPageStore } = useLoginUIStores();

	let loading = $state(true);
	let logoutLoading = $state(false);
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
	let authenticationMethods = $state<AuthenticationMethods | null>(null);
	let accountCapabilities = $state<AccountCapabilities | null>(null);
	let accountError = $state('');
	let profileError = $state('');
	let consentError = $state('');
	let profileSaved = $state(false);
	let profileSaving = $state(false);
	let securityError = $state('');
	let reauthNeeded = $state(false);
	let securityLoading = $state(false);
	let actionLoading = $state('');
	let passkeySupported = $state(false);
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
		| null
	>(null);

	function localizeApiError(error: APIError | null | undefined, fallback: string): string {
		if (!error) return fallback;
		switch (error.error) {
			case 'invalid_request':
				return $LL.error_invalid_request();
			case 'access_denied':
				return $LL.error_access_denied();
			case 'temporarily_unavailable':
				return $LL.error_temporarily_unavailable();
			case 'server_error':
				return $LL.error_server_error();
			case 'login_required':
			case 'reauthentication_required':
				return $LL.account_reauthRequired();
			default:
				return fallback;
		}
	}

	function firstLocalizedApiError(
		errors: Array<APIError | null | undefined>,
		fallback: string
	): string {
		return localizeApiError(errors.find(Boolean), fallback);
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

	function configuredScreen(screenKey: string): AccountPageScreen | null {
		return (
			accountCapabilities?.account_page?.screens.find(
				(screen) => screen.screen_key === screenKey
			) ?? null
		);
	}

	function localizedPageCopy(): { title: string; description: string } {
		const definition = accountCapabilities?.account_page?.definition;
		const localized = definition?.localizations?.[getLocale()];
		const themeTitle = loginUIPageStore.getLocalizedText(getLocale(), 'accountTitle');
		return {
			title: themeTitle ?? localized?.title ?? definition?.title ?? $LL.account_title(),
			description: localized?.description || definition?.description || ''
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
				return consents.length > 0;
			case 'multiple_sessions':
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
		const language = getLocale();
		const localized = screen.localizations?.[language]?.fields ?? {};
		return [...screen.fields]
			.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
			.map((field, index) => {
				const key = field.block_id ?? `${field.field}-${index}`;
				return { ...field, ...(localized[key] ?? {}) };
			});
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
			'Sessions',
			'Passkeys',
			'Authenticator app',
			'Consent information',
			'Account activity',
			'Connected accounts'
		]);
		return !field.label || defaultLabels.has(field.label) ? (title ?? field.label) : field.label;
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

		const [methodsResult, accountLoadStatus] = await Promise.all([
			fetchAuthenticationMethods(),
			loadAccountPage()
		]);
		if (methodsResult.data?.ui.selfService?.accountPageEnabled !== true) {
			window.location.href = '/';
			return;
		}
		authenticationMethods = methodsResult.data.methods;
		passkeySupported = await detectPasskeySupport();

		if (accountLoadStatus === 'unauthorized') {
			const returnTo = `${window.location.pathname}${window.location.search}`;
			const result = await accountAPI.createAccountReturn(returnTo);
			const accountReturn = result.data?.account_return;
			window.location.href = accountReturn
				? `/login?account_return=${encodeURIComponent(accountReturn)}`
				: '/login';
			return;
		}
		loading = false;
	});

	onMount(() => {
		const handleLocaleChange = (event: Event) => {
			const locale = (event as CustomEvent<{ locale?: string }>).detail?.locale;
			if (locale) void refreshLocalizedAccountData(locale);
		};
		window.addEventListener('authrim:locale-change', handleLocaleChange);
		return () => window.removeEventListener('authrim:locale-change', handleLocaleChange);
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
		securityError = '';
		consentError = '';
		reauthNeeded = false;
		const [
			profileResult,
			devicesResult,
			sessionsResult,
			passkeysResult,
			totpResult,
			operationsResult,
			consentsResult,
			capabilitiesResult
		] = await Promise.all([
			accountAPI.getProfile(),
			accountAPI.getDevices(),
			accountAPI.getSessions(),
			accountAPI.getPasskeys(),
			accountAPI.getTotpCredentials(),
			accountAPI.getOperations(),
			accountAPI.getConsents(getLocale()),
			accountAPI.getCapabilities()
		]);

		if (profileResult.error) {
			if (profileResult.error.error === 'unauthorized') {
				return 'unauthorized';
			}
			accountError = localizeApiError(profileResult.error, $LL.account_loadFailed());
			return 'error';
		}
		profile = profileResult.data?.profile ?? null;
		if (profile && profileResult.data?.session) {
			syncAuthFromAccountProfile(profile, profileResult.data.session);
		}
		devices = devicesResult.data?.devices ?? [];
		sessions = sessionsResult.data?.sessions ?? [];
		passkeys = passkeysResult.data?.passkeys ?? [];
		totpCredentials = totpResult.data?.credentials ?? [];
		totpBackupCodes = totpResult.data?.backup_codes ?? { total: 0, remaining: 0 };
		operations = operationsResult.data?.operations ?? [];
		consents = consentsResult.data?.consents ?? [];
		accountCapabilities = capabilitiesResult.data ?? null;
		await Promise.all([
			signalAllAcceptedCredentials(passkeysResult.data?.webauthn_signal),
			signalCurrentUserDetails(profile)
		]);
		consentError = consentsResult.error
			? localizeApiError(consentsResult.error, $LL.account_loadFailed())
			: '';
		if (
			devicesResult.error ||
			sessionsResult.error ||
			passkeysResult.error ||
			totpResult.error ||
			operationsResult.error ||
			capabilitiesResult.error
		) {
			securityError = firstLocalizedApiError(
				[
					devicesResult.error,
					sessionsResult.error,
					passkeysResult.error,
					totpResult.error,
					operationsResult.error,
					capabilitiesResult.error
				],
				$LL.account_loadFailed()
			);
		}
		return 'ok';
	}

	async function refreshLocalizedAccountData(locale: string) {
		const result = await accountAPI.getConsents(locale);
		if (result.data) {
			consents = result.data.consents;
			consentError = '';
		} else if (result.error) {
			consentError = localizeApiError(result.error, $LL.account_loadFailed());
		}
	}

	async function refreshSecurity() {
		securityLoading = true;
		try {
			reauthNeeded = false;
			const [devicesResult, sessionsResult, passkeysResult, totpResult, operationsResult] =
				await Promise.all([
					accountAPI.getDevices(),
					accountAPI.getSessions(),
					accountAPI.getPasskeys(),
					accountAPI.getTotpCredentials(),
					accountAPI.getOperations()
				]);
			devices = devicesResult.data?.devices ?? devices;
			sessions = sessionsResult.data?.sessions ?? sessions;
			passkeys = passkeysResult.data?.passkeys ?? passkeys;
			totpCredentials = totpResult.data?.credentials ?? totpCredentials;
			totpBackupCodes = totpResult.data?.backup_codes ?? totpBackupCodes;
			operations = operationsResult.data?.operations ?? operations;
			await signalAllAcceptedCredentials(passkeysResult.data?.webauthn_signal);
			const refreshErrors = [
				devicesResult.error,
				sessionsResult.error,
				passkeysResult.error,
				totpResult.error,
				operationsResult.error
			];
			securityError = refreshErrors.some(Boolean)
				? firstLocalizedApiError(refreshErrors, $LL.account_loadFailed())
				: '';
		} finally {
			securityLoading = false;
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
		securityError = '';
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

	async function revokeSession(id: string) {
		actionLoading = `session:${id}`;
		securityError = '';
		try {
			const result = await accountAPI.revokeSession(id);
			if (result.error) {
				securityError = localizeApiError(result.error, $LL.account_actionFailed());
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
		securityError = '';
		try {
			const optionsResult = await accountAPI.createPasskeyOptions(deviceName.trim());
			if (optionsResult.error) {
				if (optionsResult.error.error === 'reauth_required') {
					securityError = $LL.account_reauthRequired();
					reauthNeeded = true;
					requestReauth({ type: 'add-passkey', deviceName });
					return;
				}
				securityError = localizeApiError(optionsResult.error, $LL.account_actionFailed());
				return;
			}
			const credential = await startRegistration({
				optionsJSON: optionsResult.data!.options
			});
			const completeResult = await accountAPI.completePasskeyRegistration(
				optionsResult.data!.challenge_id,
				credential,
				deviceName.trim()
			);
			if (completeResult.error) {
				if (shouldSignalUnknownCredentialAfterRegistrationFailure(completeResult.error)) {
					await signalUnknownCredential(credential.id);
				}
				securityError = localizeApiError(completeResult.error, $LL.account_actionFailed());
				return;
			}
			await signalAllAcceptedCredentials(completeResult.data?.webauthn_signal);
			await refreshSecurity();
		} catch (error) {
			securityError = messageForCaughtError(error, $LL.account_actionFailed());
		} finally {
			actionLoading = '';
		}
	}

	async function deletePasskey(id: string) {
		actionLoading = `passkey:${id}`;
		securityError = '';
		try {
			const result = await accountAPI.deletePasskey(id);
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					securityError = $LL.account_reauthRequired();
					reauthNeeded = true;
					requestReauth({ type: 'delete-passkey', id });
					return;
				}
				if (result.error.error === 'remaining_login_method_required') {
					securityError = $LL.account_remainingLoginMethodRequired();
					return;
				}
				securityError = localizeApiError(result.error, $LL.account_actionFailed());
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
		securityError = '';
		try {
			const result = await accountAPI.createTotpOptions(label.trim());
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					securityError = $LL.account_reauthRequired();
					reauthNeeded = true;
					requestReauth({ type: 'add-totp', label });
					return;
				}
				securityError = localizeApiError(result.error, $LL.account_actionFailed());
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
		securityError = '';
		try {
			const result = await accountAPI.activateTotpCredential(
				totpEnrollment.credentialId,
				code.trim()
			);
			if (result.error) {
				securityError = localizeApiError(result.error, $LL.account_actionFailed());
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
		securityError = '';
		try {
			const result = await accountAPI.deleteTotpCredential(id, buildTotpDeleteProof(code));
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					securityError = $LL.account_reauthRequired();
					reauthNeeded = true;
					requestReauth({ type: 'delete-totp', id, code });
					return;
				}
				if (result.error.error === 'remaining_login_method_required') {
					securityError = $LL.account_remainingLoginMethodRequired();
					return;
				}
				securityError = localizeApiError(result.error, $LL.account_actionFailed());
				return;
			}
			await refreshSecurity();
		} finally {
			actionLoading = '';
		}
	}

	async function regenerateTotpBackupCodes(code: string) {
		actionLoading = 'totp:backup-codes';
		securityError = '';
		try {
			const result = await accountAPI.regenerateTotpBackupCodes(code.trim() || undefined);
			if (result.error) {
				if (result.error.error === 'reauth_required') {
					securityError = $LL.account_reauthRequired();
					reauthNeeded = true;
					requestReauth({ type: 'regenerate-totp-backup-codes', code });
					return;
				}
				securityError = localizeApiError(result.error, $LL.account_actionFailed());
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
		try {
			await auth.logout();
			window.location.href = '/';
		} catch {
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
	<div class="account-language">
		<LanguageSwitcher />
	</div>

	{#if loading}
		<div class="account-loading">
			<Spinner size="lg" />
		</div>
	{:else if accountError}
		<div class="account-layout">
			<header class="account-header">
				<div>
					<p class="account-kicker">{brandingStore.brandName || $LL.app_title()}</p>
					<h1>{localizedPageCopy().title}</h1>
					{#if localizedPageCopy().description}
						<p class="account-description">
							{localizedPageCopy().description}
						</p>
					{/if}
				</div>
				<Button variant="secondary" loading={logoutLoading} onclick={handleLogout}>
					{$LL.header_logout()}
				</Button>
			</header>
			<p class="account-error">{accountError}</p>
		</div>
	{:else}
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

			<section class="account-grid">
				{#if accountCapabilities?.account_page}
					{#each accountCapabilities.account_page.definition.screens.filter((item) => item.enabled && placementVisible(item.condition)) as placement (placement.id)}
						{@const screen = configuredScreen(placement.screen_key)}
						{#if screen}
							<section
								id={placement.id}
								class="account-screen"
								class:full={placement.width === 'full'}
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
													title={accountWidgetTitle(field)}
													saving={profileSaving}
													error={profileError}
													saved={profileSaved}
													onSave={saveProfileName}
												/>
											{:else if field.block_type === 'account_consent_widget'}
												<AccountConsentSection
													{consents}
													title={accountWidgetTitle(field)}
													error={consentError}
												/>
											{:else if field.block_type === 'account_activity_widget'}
												<AccountActivitySection {operations} title={accountWidgetTitle(field)} />
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
													loading={securityLoading}
													{actionLoading}
													error={securityError}
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
													loading={securityLoading}
													{actionLoading}
													error={securityError}
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
													loading={securityLoading}
													{actionLoading}
													error={securityError}
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
													loading={securityLoading}
													{actionLoading}
													error={securityError}
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
													loading={securityLoading}
													{actionLoading}
													error={securityError}
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
						saving={profileSaving}
						error={profileError}
						saved={profileSaved}
						onSave={saveProfileName}
					/>
					<AccountSecuritySection
						{devices}
						{sessions}
						{passkeys}
						{totpCredentials}
						{totpBackupCodes}
						{totpEnrollment}
						loading={securityLoading}
						{actionLoading}
						error={securityError}
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
					<AccountConsentSection {consents} error={consentError} />
					<AccountActivitySection {operations} />
				{/if}
			</section>
		</div>
	{/if}

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

	.account-language {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 24px;
	}

	.account-loading {
		min-height: 60vh;
		display: grid;
		place-items: center;
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

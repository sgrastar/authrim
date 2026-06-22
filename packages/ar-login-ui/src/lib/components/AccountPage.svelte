<script lang="ts">
	import { onMount } from 'svelte';
	import { startRegistration } from '@simplewebauthn/browser';
	import { Button, Spinner } from '$lib/components';
	import {
		accountAPI,
		type AccountDevice,
		type AccountOperation,
		type AccountPasskey,
		type AccountProfile,
		type AccountSession
	} from '$lib/api/account';
	import AccountActivitySection from '$lib/components/account/AccountActivitySection.svelte';
	import AccountProfileSection from '$lib/components/account/AccountProfileSection.svelte';
	import AccountSecuritySection from '$lib/components/account/AccountSecuritySection.svelte';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { fetchAuthenticationMethods } from '$lib/api/authentication-methods';
	import { auth } from '$lib/stores/auth';
	import { LL } from '$i18n/i18n-svelte';

	let loading = $state(true);
	let logoutLoading = $state(false);
	let profile = $state<AccountProfile | null>(null);
	let devices = $state<AccountDevice[]>([]);
	let sessions = $state<AccountSession[]>([]);
	let passkeys = $state<AccountPasskey[]>([]);
	let operations = $state<AccountOperation[]>([]);
	let accountError = $state('');
	let profileError = $state('');
	let profileSaved = $state(false);
	let profileSaving = $state(false);
	let securityError = $state('');
	let reauthNeeded = $state(false);
	let securityLoading = $state(false);
	let actionLoading = $state('');
	let passkeySupported = $state(false);

	onMount(async () => {
		const [methodsResult] = await Promise.all([
			fetchAuthenticationMethods(),
			auth.refreshFromSession()
		]);
		if (methodsResult.data?.ui.selfService?.accountPageEnabled !== true) {
			window.location.href = '/';
			return;
		}
		if (!auth.checkAuth()) {
			const returnTo = `${window.location.pathname}${window.location.search}`;
			const result = await accountAPI.createAccountReturn(returnTo);
			const accountReturn = result.data?.account_return;
			window.location.href = accountReturn
				? `/login?account_return=${encodeURIComponent(accountReturn)}`
				: '/login';
			return;
		}
		passkeySupported = await detectPasskeySupport();
		await loadAccountPage();
		loading = false;
	});

	async function detectPasskeySupport(): Promise<boolean> {
		return window.isSecureContext && window.PublicKeyCredential !== undefined;
	}

	async function loadAccountPage() {
		accountError = '';
		securityError = '';
		reauthNeeded = false;
		const [
			profileResult,
			devicesResult,
			sessionsResult,
			passkeysResult,
			operationsResult,
			capabilitiesResult
		] = await Promise.all([
			accountAPI.getProfile(),
			accountAPI.getDevices(),
			accountAPI.getSessions(),
			accountAPI.getPasskeys(),
			accountAPI.getOperations(),
			accountAPI.getCapabilities()
		]);

		if (profileResult.error) {
			accountError = profileResult.error.error_description || profileResult.error.error;
			return;
		}
		profile = profileResult.data?.profile ?? null;
		devices = devicesResult.data?.devices ?? [];
		sessions = sessionsResult.data?.sessions ?? [];
		passkeys = passkeysResult.data?.passkeys ?? [];
		operations = operationsResult.data?.operations ?? [];
		if (
			devicesResult.error ||
			sessionsResult.error ||
			passkeysResult.error ||
			operationsResult.error ||
			capabilitiesResult.error
		) {
			securityError =
				devicesResult.error?.error_description ||
				sessionsResult.error?.error_description ||
				passkeysResult.error?.error_description ||
				operationsResult.error?.error_description ||
				capabilitiesResult.error?.error_description ||
				$LL.account_loadFailed();
		}
	}

	async function refreshSecurity() {
		securityLoading = true;
		try {
			reauthNeeded = false;
			const [devicesResult, sessionsResult, passkeysResult, operationsResult] = await Promise.all([
				accountAPI.getDevices(),
				accountAPI.getSessions(),
				accountAPI.getPasskeys(),
				accountAPI.getOperations()
			]);
			devices = devicesResult.data?.devices ?? devices;
			sessions = sessionsResult.data?.sessions ?? sessions;
			passkeys = passkeysResult.data?.passkeys ?? passkeys;
			operations = operationsResult.data?.operations ?? operations;
			securityError =
				devicesResult.error?.error_description ||
				sessionsResult.error?.error_description ||
				passkeysResult.error?.error_description ||
				operationsResult.error?.error_description ||
				'';
		} finally {
			securityLoading = false;
		}
	}

	function reauth() {
		const returnTo = `${window.location.pathname}${window.location.search}`;
		void accountAPI.createAccountReturn(returnTo).then((result) => {
			const accountReturn = result.data?.account_return;
			window.location.href = accountReturn
				? `/login?account_return=${encodeURIComponent(accountReturn)}`
				: '/login';
		});
	}

	function handleApiError(message: string | undefined, fallback: string): string {
		return message || fallback;
	}

	async function saveProfileName(name: string) {
		profileError = '';
		profileSaved = false;
		profileSaving = true;
		try {
			const result = await accountAPI.updateProfileName(name);
			if (result.error) {
				profileError = handleApiError(result.error.error_description, $LL.account_saveFailed());
				return;
			}
			profile = result.data?.profile ?? profile;
			profileSaved = true;
			await auth.refreshFromSession();
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
				securityError = handleApiError(result.error.error_description, $LL.account_actionFailed());
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
					return;
				}
				securityError = handleApiError(
					optionsResult.error.error_description,
					$LL.account_actionFailed()
				);
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
				securityError = handleApiError(
					completeResult.error.error_description,
					$LL.account_actionFailed()
				);
				return;
			}
			await refreshSecurity();
		} catch (error) {
			securityError = error instanceof Error ? error.message : $LL.account_actionFailed();
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
					return;
				}
				if (result.error.error === 'remaining_login_method_required') {
					securityError = $LL.account_remainingLoginMethodRequired();
					return;
				}
				securityError = handleApiError(result.error.error_description, $LL.account_actionFailed());
				return;
			}
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
	<title>{$LL.account_pageTitle()}</title>
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
					<p class="account-kicker">Authrim</p>
					<h1>{$LL.account_title()}</h1>
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
					<p class="account-kicker">Authrim</p>
					<h1>{$LL.account_title()}</h1>
				</div>
				<Button variant="secondary" loading={logoutLoading} onclick={handleLogout}>
					{$LL.header_logout()}
				</Button>
			</header>

			<section class="account-grid">
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
					loading={securityLoading}
					{actionLoading}
					error={securityError}
					{reauthNeeded}
					{passkeySupported}
					onRefresh={refreshSecurity}
					onRevokeSession={revokeSession}
					onAddPasskey={addPasskey}
					onDeletePasskey={deletePasskey}
					onReauth={reauth}
				/>
				<AccountActivitySection {operations} />
			</section>
		</div>
	{/if}
</div>

<style>
	.account-shell {
		min-height: 100vh;
		background: var(--bg-primary);
		color: var(--text-primary);
		padding: 24px;
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
		width: min(720px, 100%);
		margin: 0 auto;
	}

	.account-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
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
		grid-template-columns: 1fr;
		gap: 16px;
	}

	.account-error {
		margin: 0;
		color: var(--danger);
	}
</style>

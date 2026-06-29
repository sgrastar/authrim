<script lang="ts">
	import { onMount } from 'svelte';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { Button, Spinner } from '$lib/components';
	import {
		accountAPI,
		type AccountDevice,
		type AccountOperation,
		type AccountPasskey,
		type AccountProfile,
		type AccountProfileSession,
		type AccountSession
	} from '$lib/api/account';
	import AccountActivitySection from '$lib/components/account/AccountActivitySection.svelte';
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
	import { LL } from '$i18n/i18n-svelte';

	let loading = $state(true);
	let logoutLoading = $state(false);
	let profile = $state<AccountProfile | null>(null);
	let devices = $state<AccountDevice[]>([]);
	let sessions = $state<AccountSession[]>([]);
	let passkeys = $state<AccountPasskey[]>([]);
	let operations = $state<AccountOperation[]>([]);
	let authenticationMethods = $state<AuthenticationMethods | null>(null);
	let accountError = $state('');
	let profileError = $state('');
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
	let pendingReauthAction = $state<
		{ type: 'add-passkey'; deviceName: string } | { type: 'delete-passkey'; id: string } | null
	>(null);
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
	let hasReauthMethod = $derived(passkeyReauthAvailable || emailCodeReauthAvailable);

	onMount(async () => {
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
			if (profileResult.error.error === 'unauthorized') {
				return 'unauthorized';
			}
			accountError = profileResult.error.error_description || profileResult.error.error;
			return 'error';
		}
		profile = profileResult.data?.profile ?? null;
		if (profile && profileResult.data?.session) {
			syncAuthFromAccountProfile(profile, profileResult.data.session);
		}
		devices = devicesResult.data?.devices ?? [];
		sessions = sessionsResult.data?.sessions ?? [];
		passkeys = passkeysResult.data?.passkeys ?? [];
		operations = operationsResult.data?.operations ?? [];
		await Promise.all([
			signalAllAcceptedCredentials(passkeysResult.data?.webauthn_signal),
			signalCurrentUserDetails(profile)
		]);
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
		return 'ok';
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
			await signalAllAcceptedCredentials(passkeysResult.data?.webauthn_signal);
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

	function requestReauth(action?: typeof pendingReauthAction) {
		pendingReauthAction = action ?? pendingReauthAction;
		reauthError = '';
		emailReauthChallengeId = '';
		emailReauthCode = '';
		emailReauthMaskedEmail = '';
		emailReauthCodeSent = false;
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
		await refreshSecurity();

		const pending = pendingReauthAction;
		pendingReauthAction = null;
		if (pending?.type === 'add-passkey') {
			await addPasskey(pending.deviceName);
		} else if (pending?.type === 'delete-passkey') {
			await deletePasskey(pending.id);
		}
	}

	async function completePasskeyReauth() {
		if (!passkeyReauthAvailable || reauthLoading) return;
		reauthLoading = true;
		reauthError = '';
		try {
			const optionsResult = await accountAPI.createPasskeyReauthOptions();
			if (optionsResult.error) {
				reauthError = handleApiError(
					optionsResult.error.error_description,
					$LL.account_actionFailed()
				);
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
				reauthError = handleApiError(
					completeResult.error.error_description,
					$LL.account_actionFailed()
				);
				return;
			}

			await finishReauth();
		} catch (error) {
			reauthError = error instanceof Error ? error.message : $LL.account_actionFailed();
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
				reauthError = handleApiError(result.error.error_description, $LL.account_actionFailed());
				return;
			}
			emailReauthChallengeId = result.data!.challenge_id;
			emailReauthMaskedEmail = result.data!.masked_email;
			emailReauthCode = '';
			emailReauthCodeSent = true;
		} catch (error) {
			reauthError = error instanceof Error ? error.message : $LL.account_actionFailed();
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
				reauthError = handleApiError(result.error.error_description, $LL.account_actionFailed());
				return;
			}
			await finishReauth();
		} catch (error) {
			reauthError = error instanceof Error ? error.message : $LL.account_actionFailed();
		} finally {
			reauthLoading = false;
		}
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
					requestReauth({ type: 'add-passkey', deviceName });
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
				if (shouldSignalUnknownCredentialAfterRegistrationFailure(completeResult.error)) {
					await signalUnknownCredential(credential.id);
				}
				securityError = handleApiError(
					completeResult.error.error_description,
					$LL.account_actionFailed()
				);
				return;
			}
			await signalAllAcceptedCredentials(completeResult.data?.webauthn_signal);
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
					requestReauth({ type: 'delete-passkey', id });
					return;
				}
				if (result.error.error === 'remaining_login_method_required') {
					securityError = $LL.account_remainingLoginMethodRequired();
					return;
				}
				securityError = handleApiError(result.error.error_description, $LL.account_actionFailed());
				return;
			}
			await signalAllAcceptedCredentials(result.data?.webauthn_signal);
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
					onReauth={() => requestReauth()}
				/>
				<AccountActivitySection {operations} />
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
								maxlength="6"
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
				<Button variant="secondary" onclick={() => (reauthModalOpen = false)}>
					{$LL.dialog_cancel()}
				</Button>
			</div>
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

	.reauth-backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
		border: 0;
		background: rgb(0 0 0 / 0.42);
		backdrop-filter: blur(3px);
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
		background: var(--surface);
		box-shadow: 0 24px 70px rgb(0 0 0 / 0.28);
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
</style>

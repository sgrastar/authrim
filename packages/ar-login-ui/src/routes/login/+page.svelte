<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import {
		passkeyAPI,
		emailCodeAPI,
		directoryPasswordAPI,
		externalIdpAPI,
		loginChallengeAPI
	} from '$lib/api/client';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import {
		isValidRedirectUrl,
		isValidImageUrl,
		isValidLinkUrl,
		sanitizeColor
	} from '$lib/utils/url-validation';
	import {
		fetchAuthenticationMethods,
		type ExternalProvider
	} from '$lib/api/authentication-methods';
	import { getExternalProviderIconClass } from '$lib/login-provider-icons';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { LOGIN_UI_SESSION_STORAGE_KEYS, setLoginUiSessionItem } from '$lib/authrim/storage-keys';
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
	let passkeyLoading = $state(false);
	let emailCodeLoading = $state(false);
	let directoryPasswordLoading = $state(false);
	let externalIdpLoading = $state<string | null>(null);
	const authActionLoading = $derived(
		passkeyLoading || emailCodeLoading || directoryPasswordLoading || externalIdpLoading !== null
	);

	// Login methods (from API)
	let methodsLoading = $state(true);
	let methodsError = $state('');
	let passkeyEnabled = $state(false);
	let emailCodeEnabled = $state(false);
	let directoryPasswordEnabled = $state(false);
	let directoryPasswordLabel = $state('Organization ID');
	let externalEnabled = $state(false);
	let externalProviders = $state<ExternalProvider[]>([]);

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
	let samlRequestId = $state('');
	let samlSpEntityId = $state('');
	let returnTo = $state('');

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

	// Derived: WebAuthn support check
	const isPasskeySupported = $derived(
		typeof window !== 'undefined' &&
			window.PublicKeyCredential !== undefined &&
			typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	);

	// Show passkey only if both server-enabled and browser-supported
	const showPasskey = $derived(passkeyEnabled && isPasskeySupported);

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

		const observer = new MutationObserver(() => {
			isDarkMode = checkDarkMode();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme']
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

		// Fetch login methods + challenge data in parallel
		const urlChallengeId = $page.url.searchParams.get('challenge_id');
		authorizationChallengeId = urlChallengeId || '';
		samlRequestId = $page.url.searchParams.get('saml_request_id') || '';
		samlSpEntityId = $page.url.searchParams.get('saml_sp_entity_id') || '';
		returnTo = $page.url.searchParams.get('return_to') || '';
		const urlLoginHint = $page.url.searchParams.get('login_hint');
		if (urlLoginHint) {
			email = urlLoginHint;
		}

		const tasks: Promise<void>[] = [loadAuthenticationMethods()];
		if (urlChallengeId) {
			tasks.push(loadChallengeData(urlChallengeId));
		}
		await Promise.all(tasks);
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
				passkeyEnabled = data.methods.passkey.enabled;
				emailCodeEnabled = data.methods.emailCode.enabled;
				directoryPasswordEnabled = data.methods.directoryPassword.enabled;
				directoryPasswordLabel = data.methods.directoryPassword.label || 'Organization ID';
				externalEnabled = data.methods.external.enabled;
				externalProviders = data.methods.external.providers;
			}
		} catch {
			methodsError = 'Failed to load login methods';
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

	function buildPostAuthRedirect(redirectUrl?: string): string {
		if (returnTo === 'saml_sso' && samlRequestId && samlSpEntityId) {
			const params = new SvelteURLSearchParams({
				saml_request_id: samlRequestId,
				saml_sp_entity_id: samlSpEntityId,
				return_to: 'saml_sso'
			});
			return `/saml/idp/sso?${params.toString()}`;
		}

		if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
			return redirectUrl;
		}

		return '/';
	}

	async function handlePasskeyLogin() {
		if (authActionLoading) return;
		error = '';
		passkeyLoading = true;

		try {
			const { data: optionsData, error: optionsError } = await passkeyAPI.getLoginOptions({});
			if (optionsError) {
				throw new Error(getApiErrorMessage(optionsError));
			}

			/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
			const credential = await startAuthentication({ optionsJSON: optionsData!.options as any });

			const { data: verifyData, error: verifyError } = await passkeyAPI.verifyLogin({
				challengeId: optionsData!.challengeId,
				credential,
				authorizationChallengeId: authorizationChallengeId || undefined
			});

			if (verifyError) {
				throw new Error(getApiErrorMessage(verifyError));
			}

			await auth.refreshFromSession();

			window.location.href = buildPostAuthRedirect(verifyData?.redirect_url);
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
			const { error: apiError } = await emailCodeAPI.send({ email });
			if (apiError) {
				throw new Error(getApiErrorMessage(apiError));
			}
			const params = new SvelteURLSearchParams({ email });
			if (authorizationChallengeId) {
				params.set('challenge_id', authorizationChallengeId);
			}
			if (returnTo === 'saml_sso' && samlRequestId && samlSpEntityId) {
				params.set('saml_request_id', samlRequestId);
				params.set('saml_sp_entity_id', samlSpEntityId);
				params.set('return_to', 'saml_sso');
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
			const { data, error: apiError } = await directoryPasswordAPI.login({
				username,
				password: directoryPassword,
				authorizationChallengeId: authorizationChallengeId || undefined
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

			await auth.refreshFromSession();
			window.location.href = buildPostAuthRedirect(data?.redirect_url);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.login_errorDirectoryFailed();
		} finally {
			directoryPasswordLoading = false;
		}
	}

	async function handleExternalLogin(provider: ExternalProvider) {
		const providerId = provider.id;
		if (authActionLoading) return;
		externalIdpLoading = providerId;
		try {
			const redirectUri =
				provider.startMode === 'saml_sp'
					? `${window.location.origin}/`
					: `${window.location.origin}/callback`;
			const { url } = await externalIdpAPI.startLogin(
				providerId,
				redirectUri,
				provider.startUrl,
				provider.startMode
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

				<!-- Passkey Button -->
				{#if showPasskey}
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

					{#if directoryPasswordEnabled || emailCodeEnabled}
						<div class="auth-divider">
							<div class="auth-divider__line"></div>
							<span class="auth-divider__text">{$LL.common_or()}</span>
							<div class="auth-divider__line"></div>
						</div>
					{/if}
				{/if}

				<!-- Directory Password -->
				{#if directoryPasswordEnabled}
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

					{#if emailCodeEnabled}
						<div class="auth-divider">
							<div class="auth-divider__line"></div>
							<span class="auth-divider__text">{$LL.common_or()}</span>
							<div class="auth-divider__line"></div>
						</div>
					{/if}
				{/if}

				<!-- Email Input + Email Code -->
				{#if emailCodeEnabled}
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
				{/if}

				<!-- External Login Section -->
				{#if externalEnabled && externalProviders.length > 0}
					<div class="auth-divider" style="margin: 24px 0;">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.login_orContinueWith()}</span>
						<div class="auth-divider__line"></div>
					</div>

					<div class="space-y-3">
						{#each externalProviders as provider (provider.id)}
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

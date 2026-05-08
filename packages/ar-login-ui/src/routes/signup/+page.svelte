<script lang="ts">
	import { Button, Input, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { passkeyAPI, emailCodeAPI, externalIdpAPI } from '$lib/api/client';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import {
		fetchRegistrationFields,
		type RegistrationField
	} from '$lib/api/registration-fields';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { isValidImageUrl, isValidRedirectUrl, sanitizeColor } from '$lib/utils/url-validation';
	import { fetchLoginMethods, type SocialProvider } from '$lib/api/login-methods';
	import { startRegistration } from '@simplewebauthn/browser';
	import { auth } from '$lib/stores/auth';
	import {
		LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS,
		LOGIN_UI_SESSION_STORAGE_KEYS,
		removeLoginUiSessionItems,
		setLoginUiSessionItem
	} from '$lib/authrim/storage-keys';
	import { onMount } from 'svelte';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let email = $state('');
	let name = $state('');
	let inviteToken = $state('');
	let inviteTenantName = $state('');

	let registrationFields = $state<RegistrationField[]>([]);
	let customFieldValues = $state<Record<string, string>>({});
	let customFieldErrors = $state<Record<string, string>>({});
	let error = $state('');
	let passkeyLoading = $state(false);
	let emailCodeLoading = $state(false);
	let emailError = $state('');
	let nameError = $state('');
	let externalIdpLoading = $state<string | null>(null);

	// Login methods (from API)
	let methodsLoading = $state(true);
	let passkeyEnabled = $state(false);
	let emailCodeEnabled = $state(false);
	let socialEnabled = $state(false);
	let socialProviders = $state<SocialProvider[]>([]);

	// Dark mode detection for social button colors
	let isDarkMode = $state(false);

	// Derived: WebAuthn support check
	const isPasskeySupported = $derived(
		typeof window !== 'undefined' &&
			window.PublicKeyCredential !== undefined &&
			typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	);

	const showPasskey = $derived(passkeyEnabled && isPasskeySupported);

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
		mql.addEventListener('change', () => {
			isDarkMode = checkDarkMode();
		});

		// Read invite context from URL params
		const params = new URLSearchParams(window.location.search);
		const token = params.get('invite_token');
		const prefilledEmail = params.get('email');
		const tenant = params.get('tenant');

		if (token) {
			inviteToken = token;
		}
		if (prefilledEmail) {
			email = prefilledEmail;
		}
		if (tenant) {
			inviteTenantName = tenant;
		}

		await Promise.all([loadLoginMethods(), loadRegistrationFields()]);
	});

	async function loadLoginMethods() {
		methodsLoading = true;
		try {
			const { data } = await fetchLoginMethods();
			if (data) {
				passkeyEnabled = data.methods.passkey.enabled;
				emailCodeEnabled = data.methods.emailCode.enabled;
				socialEnabled = data.methods.social.enabled;
				socialProviders = data.methods.social.providers;
			}
		} catch {
			// Fallback: enable all methods
			passkeyEnabled = true;
			emailCodeEnabled = true;
		} finally {
			methodsLoading = false;
		}
	}

	async function loadRegistrationFields() {
		registrationFields = await fetchRegistrationFields();
		customFieldValues = {};
		customFieldErrors = {};
		for (const f of registrationFields) {
			customFieldValues[f.field_key] = f.field_type === 'boolean' ? 'false' : '';
		}
	}

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
	function validateEmail(value: string): boolean {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
			const value = customFieldValues[field.field_key] ?? '';
			if (field.required && value.trim() === '') {
				customFieldErrors[field.field_key] = `${field.display_label} is required`;
			}
		}

		return Object.values(customFieldErrors).every((value) => !value);
	}

	function getSubmittedCustomFields(): Record<string, string> {
		return Object.fromEntries(
			Object.entries(customFieldValues).filter(([, value]) => value !== '')
		);
	}

	function validateForm(): boolean {
		emailError = '';
		nameError = '';

		if (!name.trim()) {
			nameError = $LL.register_errorNameRequired();
			return false;
		}
		if (!email.trim()) {
			emailError = $LL.login_errorEmailRequired();
			return false;
		}
		if (!validateEmail(email)) {
			emailError = $LL.login_errorEmailInvalid();
			return false;
		}
		if (!validateCustomFields()) {
			return false;
		}
		return true;
	}

	async function handlePasskeyRegister() {
		if (passkeyLoading) return;
		error = '';
		if (!validateForm()) return;

		passkeyLoading = true;

		try {
			const { data: optionsData, error: optionsError } = await passkeyAPI.getRegisterOptions({
				email,
				name,
				custom_fields: getSubmittedCustomFields()
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
				deviceName: navigator.userAgent.includes('Mobile') ? 'Mobile Device' : 'Desktop'
			});

			if (verifyError) {
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
			const submittedCustomFields = getSubmittedCustomFields();
			const { error: apiError } = await emailCodeAPI.send({
				email,
				name,
				invite_token: inviteToken || undefined,
				custom_fields: submittedCustomFields
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
			window.location.href = `/verify-email-code?${verifyQs}`;
		} catch (err) {
			error =
				err instanceof Error ? err.message : 'An error occurred while sending verification code';
		} finally {
			emailCodeLoading = false;
		}
	}

	async function handleExternalLogin(providerId: string) {
		externalIdpLoading = providerId;
		try {
			const redirectUri = `${window.location.origin}/callback`;
			const { url } = await externalIdpAPI.startLogin(providerId, redirectUri);

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

	function getProviderIcon(provider: SocialProvider): string {
		if (provider.iconUrl) return provider.iconUrl;
		const providerName = (provider.name || '').toLowerCase();
		if (providerName.includes('google')) return 'i-ph-google-logo';
		if (providerName.includes('github')) return 'i-ph-github-logo';
		if (providerName.includes('microsoft') || providerName.includes('azure'))
			return 'i-ph-windows-logo';
		if (providerName.includes('apple')) return 'i-ph-apple-logo';
		if (providerName.includes('facebook') || providerName.includes('meta')) return 'i-ph-meta-logo';
		if (providerName.includes('twitter') || providerName.includes('x.com')) return 'i-ph-x-logo';
		if (providerName.includes('linkedin')) return 'i-ph-linkedin-logo';
		return 'i-ph-sign-in';
	}

	function getProviderButtonText(provider: SocialProvider): string {
		if (provider.buttonText) return provider.buttonText;
		return $LL.login_continueWith({ provider: provider.name });
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			handleEmailCodeSignup();
		}
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
							You've been invited to <strong>{inviteTenantName}</strong>. Create your account to continue.
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

				<!-- Name Input -->
				<div class="mb-4">
					<Input
						label={$LL.common_name()}
						type="text"
						placeholder={$LL.common_namePlaceholder()}
						bind:value={name}
						error={nameError}
						autocomplete="name"
						required
					/>
				</div>

				<!-- Email Input -->
				<div class="mb-6">
					<Input
						label={$LL.common_email()}
						type="email"
						placeholder={$LL.common_emailPlaceholder()}
						bind:value={email}
						error={emailError}
						onkeypress={handleKeyPress}
						autocomplete="email"
						required
					/>
				</div>

				<!-- Custom Registration Fields -->
				{#if registrationFields.length > 0}
					{#each registrationFields as field (field.field_key)}
						<div class="mb-4">
							{#if field.field_type === 'boolean'}
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
									<label class="form-label" for={`signup-${field.field_key}`}>{getFieldLabel(field)}</label>
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
									oninput={() => setCustomFieldValue(field.field_key, customFieldValues[field.field_key])}
									required={field.required}
								/>
							{:else if field.field_type === 'number'}
								<Input
									label={getFieldLabel(field)}
									type="number"
									placeholder={field.placeholder ?? ''}
									bind:value={customFieldValues[field.field_key]}
									error={customFieldErrors[field.field_key]}
									oninput={() => setCustomFieldValue(field.field_key, customFieldValues[field.field_key])}
									required={field.required}
								/>
							{:else}
								<Input
									label={getFieldLabel(field)}
									type="text"
									placeholder={field.placeholder ?? ''}
									bind:value={customFieldValues[field.field_key]}
									error={customFieldErrors[field.field_key]}
									oninput={() => setCustomFieldValue(field.field_key, customFieldValues[field.field_key])}
									required={field.required}
								/>
							{/if}
						</div>
					{/each}
				{/if}

				<!-- Passkey Button -->
				{#if showPasskey}
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

					{#if emailCodeEnabled}
						<div class="auth-divider">
							<div class="auth-divider__line"></div>
							<span class="auth-divider__text">{$LL.common_or()}</span>
							<div class="auth-divider__line"></div>
						</div>
					{/if}
				{/if}

				<!-- Email Code Button -->
				{#if emailCodeEnabled}
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
				{/if}

				<!-- Social Login Section -->
				{#if socialEnabled && socialProviders.length > 0}
					<div class="auth-divider" style="margin: 24px 0;">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.login_orContinueWith()}</span>
						<div class="auth-divider__line"></div>
					</div>

					<div class="space-y-3">
						{#each socialProviders as provider (provider.id)}
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
								onclick={() => handleExternalLogin(provider.id)}
								style={safeColor ? `border-color: ${safeColor}; color: ${safeColor};` : ''}
							>
								<div class="{getProviderIcon(provider)} h-5 w-5"></div>
								{getProviderButtonText(provider)}
							</Button>
						{/each}
					</div>
				{/if}

				<!-- Terms Agreement -->
				<p class="mt-4 text-xs text-center" style="color: var(--text-muted);">
					{$LL.register_termsAgreement()}
				</p>
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
</style>

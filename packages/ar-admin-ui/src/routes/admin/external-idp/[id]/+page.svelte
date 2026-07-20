<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';
	import { buildExternalIdPCallbackUrl } from '$lib/admin/external-idp-callback-url';
	import { getTenantInfo } from '$lib/api/admin-info';
	import {
		adminExternalProvidersAPI,
		type ExternalIdPProvider,
		type UpdateProviderRequest
	} from '$lib/api/admin-external-providers';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import LoginProviderIconPicker from '$lib/components/admin/LoginProviderIconPicker.svelte';
	import { ToggleSwitch } from '$lib/components';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let provider: ExternalIdPProvider | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let saveSuccess = $state(false);

	// Form state
	let name = $state('');
	let slug = $state('');
	let providerType = $state<'oidc' | 'oauth2'>('oidc');
	let enabled = $state(true);
	let priority = $state(0);
	let clientId = $state('');
	let clientSecret = $state(''); // Only used for updates
	let issuer = $state('');
	let scopes = $state('');
	let authorizationEndpoint = $state('');
	let tokenEndpoint = $state('');
	let userinfoEndpoint = $state('');
	let jwksUri = $state('');
	let autoLinkEmail = $state(true);
	let jitProvisioning = $state(true);
	let requireEmailVerified = $state(true);
	let alwaysFetchUserinfo = $state(false);
	let enableSso = $state(true);
	let iconUrl = $state('');
	let iconName = $state('');
	let buttonColor = $state('');
	let buttonColorDark = $state('');
	let buttonText = $state('');
	let copySuccess = $state(false);
	let slugError = $state('');
	let discoveryUrl = $state('');
	let discoveryMode = $state<'url' | 'webfinger'>('url');
	let discovering = $state(false);
	let discoveryError = $state('');
	let dynamicRegistrationEnabled = $state(false);
	let dynamicClientName = $state('');
	let initiateLoginUri = $state('');
	let requestUris = $state('');
	let userinfoSignedResponseAlg = $state('');
	let registering = $state(false);
	let registrationError = $state('');
	let registrationSuccess = $state(false);
	let callbackIssuer = $state<string | null>(null);
	let callbackIssuerRequest = 0;

	const providerId = $derived($page.params.id);
	const providerIdentifier = $derived(slug || providerId || null);

	// Validate slug format
	function validateSlug(value: string): string {
		if (!value) return $LL.admin_external_idp_slug_required_error();
		if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(value)) {
			return $LL.admin_external_idp_slug_format_error();
		}
		if (value.length > 50) return $LL.admin_external_idp_slug_length_error();
		return '';
	}

	function handleSlugInput() {
		slugError = validateSlug(slug);
	}

	const redirectUrl = $derived(
		!slugError ? buildExternalIdPCallbackUrl(callbackIssuer, providerIdentifier) : null
	);

	async function copyRedirectUrl() {
		const url = redirectUrl;
		if (url && typeof navigator !== 'undefined') {
			await navigator.clipboard.writeText(url);
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2000);
		}
	}

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId) {
			callbackIssuer = null;
			return;
		}
		void loadCallbackIssuer(tenantId);
	});

	async function loadCallbackIssuer(tenantId: string) {
		const requestId = ++callbackIssuerRequest;
		try {
			const info = await getTenantInfo(tenantId);
			if (requestId === callbackIssuerRequest) {
				callbackIssuer = info.issuer;
			}
		} catch {
			if (requestId === callbackIssuerRequest) {
				callbackIssuer = null;
			}
		}
	}

	// Discover OIDC configuration from well-known endpoint (via backend proxy to avoid CORS)
	async function discoverOidcConfig() {
		if (!discoveryUrl) {
			discoveryError = $LL.admin_external_idp_discovery_required();
			return;
		}

		discovering = true;
		discoveryError = '';

		try {
			// Use backend proxy to fetch OIDC configuration (avoids CORS issues)
			const config = await adminExternalProvidersAPI.discoverOidcConfig(
				discoveryUrl.trim(),
				discoveryMode
			);

			// Populate fields from discovery response
			if (config.issuer) issuer = config.issuer;
			if (config.authorization_endpoint) authorizationEndpoint = config.authorization_endpoint;
			if (config.token_endpoint) tokenEndpoint = config.token_endpoint;
			if (config.userinfo_endpoint) userinfoEndpoint = config.userinfo_endpoint;
			if (config.jwks_uri) jwksUri = config.jwks_uri;

			// Optionally update scopes if supported scopes are provided
			if (config.scopes_supported && Array.isArray(config.scopes_supported)) {
				const commonScopes = ['openid', 'email', 'profile'];
				const available = config.scopes_supported.filter((s: string) => commonScopes.includes(s));
				if (available.length > 0) {
					scopes = available.join(' ');
				}
			}

			discoveryError = '';
		} catch (err) {
			console.error('OIDC Discovery failed:', err);
			discoveryError =
				err instanceof Error ? err.message : $LL.admin_external_idp_discovery_error();
		} finally {
			discovering = false;
		}
	}

	async function loadProvider() {
		if (!providerId) return;

		loading = true;
		error = '';

		try {
			const data = await adminExternalProvidersAPI.get(providerId);
			provider = data;

			// Populate form
			name = data.name;
			slug = data.slug || '';
			providerType = data.providerType;
			enabled = data.enabled;
			priority = data.priority;
			clientId = data.clientId;
			issuer = data.issuer || '';
			scopes = data.scopes;
			authorizationEndpoint = data.authorizationEndpoint || '';
			tokenEndpoint = data.tokenEndpoint || '';
			userinfoEndpoint = data.userinfoEndpoint || '';
			jwksUri = data.jwksUri || '';
			autoLinkEmail = data.autoLinkEmail;
			jitProvisioning = data.jitProvisioning;
			requireEmailVerified = data.requireEmailVerified;
			alwaysFetchUserinfo = data.alwaysFetchUserinfo || false;
			enableSso = data.enableSso !== false;
			iconUrl = data.iconUrl || '';
			iconName = data.iconName || '';
			buttonColor = data.buttonColor || '';
			buttonColorDark = data.buttonColorDark || '';
			buttonText = data.buttonText || '';
			const dynamicConfig = data.providerQuirks?.dynamicClientRegistration;
			if (dynamicConfig && typeof dynamicConfig === 'object' && !Array.isArray(dynamicConfig)) {
				const config = dynamicConfig as Record<string, unknown>;
				dynamicRegistrationEnabled = config.enabled === true;
				dynamicClientName = typeof config.clientName === 'string' ? config.clientName : '';
				initiateLoginUri =
					typeof config.initiateLoginUri === 'string' ? config.initiateLoginUri : '';
				requestUris = Array.isArray(config.requestUris)
					? config.requestUris.filter((value): value is string => typeof value === 'string').join('\n')
					: '';
				userinfoSignedResponseAlg =
					typeof config.userinfoSignedResponseAlg === 'string'
						? config.userinfoSignedResponseAlg
						: '';
			} else {
				dynamicRegistrationEnabled = false;
				dynamicClientName = '';
				initiateLoginUri = '';
				requestUris = '';
				userinfoSignedResponseAlg = '';
			}
		} catch (err) {
			console.error('Failed to load provider:', err);
			error = err instanceof Error ? err.message : $LL.admin_external_idp_error_load_provider();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void (async () => {
			await settingsContext.initialize();
			await loadProvider();
		})();
	});

	async function handleSubmit() {
		if (!providerId) return;

		// Validate slug before submission
		slugError = validateSlug(slug);
		if (slugError) {
			saveError = slugError;
			return;
		}

		saving = true;
		saveError = '';
		saveSuccess = false;

		try {
			const existingQuirks = provider?.providerQuirks || {};
			const updateData: UpdateProviderRequest = {
				name,
				slug,
				provider_type: providerType,
				enabled,
				priority,
				client_id: clientId,
				issuer: issuer || undefined,
				scopes: scopes || undefined,
				authorization_endpoint: authorizationEndpoint || undefined,
				token_endpoint: tokenEndpoint || undefined,
				userinfo_endpoint: userinfoEndpoint || undefined,
				jwks_uri: jwksUri || undefined,
				auto_link_email: autoLinkEmail,
				jit_provisioning: jitProvisioning,
				require_email_verified: requireEmailVerified,
				always_fetch_userinfo: alwaysFetchUserinfo,
				enable_sso: enableSso,
				icon_url: iconUrl || null,
				icon_name: iconName || null,
				button_color: buttonColor || undefined,
				button_color_dark: buttonColorDark || undefined,
				button_text: buttonText || undefined,
				provider_quirks: {
					...existingQuirks,
					dynamicClientRegistration: {
						enabled: dynamicRegistrationEnabled,
						clientName: dynamicClientName.trim() || name.trim() || undefined,
						initiateLoginUri: initiateLoginUri.trim() || undefined,
						requestUris: requestUris
							.split(/[\n,]/)
							.map((value) => value.trim())
							.filter(Boolean),
						userinfoSignedResponseAlg: userinfoSignedResponseAlg || undefined
					}
				}
			};

			// Only include client_secret if it was entered
			if (clientSecret) {
				updateData.client_secret = clientSecret;
			}

			await adminExternalProvidersAPI.update(providerId, updateData);
			saveSuccess = true;
			clientSecret = ''; // Clear secret field after save

			// Reload to get updated data
			await loadProvider();
		} catch (err) {
			saveError = err instanceof Error ? err.message : $LL.admin_external_idp_error_update();
		} finally {
			saving = false;
		}
	}

	async function handleDynamicRegistration() {
		if (!providerId) return;
		registrationError = '';
		registrationSuccess = false;
		if (!dynamicRegistrationEnabled) {
			registrationError = 'Enable dynamic client registration and save the provider first.';
			return;
		}

		registering = true;
		try {
			await adminExternalProvidersAPI.registerDynamic(providerId);
			registrationSuccess = true;
			await loadProvider();
		} catch (err) {
			registrationError = err instanceof Error ? err.message : 'Dynamic registration failed';
		} finally {
			registering = false;
		}
	}

	function navigateBack() {
		goto('/admin/external-idp');
	}
</script>

<svelte:head>
	<title
		>{provider
			? $LL.admin_external_idp_edit_title({ name: provider.name })
			: $LL.admin_external_idp_detail_title_fallback()} - External IdP - Admin Dashboard - Authrim</title
	>
</svelte:head>

{#snippet pageActions()}
	<a href="/admin/external-idp" class="btn btn-secondary">{$LL.admin_external_idp_back()}</a>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={loading
			? $LL.admin_external_idp_loading()
			: provider
				? $LL.admin_external_idp_edit_title({ name: provider.name })
				: $LL.admin_external_idp_not_found()}
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">{$LL.admin_external_idp_loading()}</div>
	{:else if provider}
		<form
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
		>
			{#if saveError}
				<div class="alert alert-error">{saveError}</div>
			{/if}

			{#if saveSuccess}
				<div class="alert alert-success">{$LL.admin_external_idp_updated()}</div>
			{/if}

			<!-- Enable/Disable Toggle -->
			<AdminSection>
				<ToggleSwitch
					bind:checked={enabled}
					label={$LL.admin_external_idp_provider_status()}
					description={$LL.admin_external_idp_provider_status_desc()}
				/>
			</AdminSection>

			<!-- SSO Toggle -->
			<AdminSection>
				<ToggleSwitch
					bind:checked={enableSso}
					label={$LL.admin_external_idp_enable_sso()}
					description={$LL.admin_external_idp_enable_sso_desc()}
				/>
			</AdminSection>

			<!-- Basic Information -->
			<AdminSection title={$LL.admin_external_idp_basic_information()}>
				<div class="form-grid">
					<div class="admin-field">
						<label for="name" class="admin-field__label"
							>{$LL.admin_external_idp_name_required()}</label
						>
						<input id="name" type="text" bind:value={name} required class="admin-input" />
					</div>

					<div class="admin-field">
						<label for="slug" class="admin-field__label"
							>{$LL.admin_external_idp_slug_required()}</label
						>
						<input
							id="slug"
							type="text"
							bind:value={slug}
							oninput={handleSlugInput}
							required
							placeholder={$LL.admin_external_idp_slug_placeholder()}
							class="admin-input"
							class:input-error={slugError}
						/>
						{#if slugError}
							<p class="form-error">{slugError}</p>
						{:else}
							<p class="field-hint">
								{$LL.admin_external_idp_slug_edit_hint()}
							</p>
						{/if}
					</div>

					<div class="admin-field">
						<label for="providerType" class="admin-field__label"
							>{$LL.admin_external_idp_provider_type()}</label
						>
						<select id="providerType" bind:value={providerType} class="admin-select">
							<option value="oidc">OIDC (OpenID Connect)</option>
							<option value="oauth2">OAuth 2.0</option>
						</select>
					</div>

					<div class="admin-field">
						<label for="priority" class="admin-field__label"
							>{$LL.admin_external_idp_priority()}</label
						>
						<input id="priority" type="number" bind:value={priority} min="0" class="admin-input" />
						<p class="field-hint">{$LL.admin_external_idp_priority_hint()}</p>
					</div>
				</div>

				<!-- Redirect URL Display -->
				<div class="redirect-url-section">
					<!-- svelte-ignore a11y_label_has_associated_control -->
					<label class="admin-field__label">{$LL.admin_external_idp_redirect_url()}</label>
					<p class="field-hint field-hint--spaced">
						{$LL.admin_external_idp_redirect_url_hint()}
					</p>
					{#if redirectUrl}
						<div class="input-copy-group">
							<input
								type="url"
								class="admin-input callback-url-input"
								value={redirectUrl}
								readonly
							/>
							<button
								type="button"
								class="copy-btn"
								onclick={copyRedirectUrl}
								title={$LL.admin_external_idp_copy_to_clipboard()}
								aria-label={$LL.admin_external_idp_copy_to_clipboard()}
							>
								{#if copySuccess}
									<i class="i-ph-check copy-success"></i>
								{:else}
									<i class="i-ph-copy"></i>
								{/if}
							</button>
						</div>
					{/if}
				</div>
			</AdminSection>

			<!-- OAuth/OIDC Configuration -->
			<AdminSection title={$LL.admin_external_idp_oauth_config()}>
				<!-- OIDC Discovery -->
				{#if providerType === 'oidc'}
					<div class="discovery-section">
						<label for="discoveryUrl" class="admin-field__label"
							>{$LL.admin_external_idp_discovery_label()}</label
						>
						<div class="discovery-input-row">
							<select
								bind:value={discoveryMode}
								class="admin-select discovery-mode-select"
								aria-label="Discovery input type"
							>
								<option value="url">Issuer URL</option>
								<option value="webfinger">WebFinger resource</option>
							</select>
							<input
								id="discoveryUrl"
								type="text"
								bind:value={discoveryUrl}
								placeholder={discoveryMode === 'webfinger'
									? 'acct:user@example.com or https://example.com/user'
									: $LL.admin_external_idp_discovery_placeholder()}
								class="admin-input"
							/>
							<button
								type="button"
								class="btn btn-secondary"
								onclick={discoverOidcConfig}
								disabled={discovering}
							>
								{#if discovering}
									<span class="spinner-small"></span>
									{$LL.admin_external_idp_discovering()}
								{:else}
									<i class="i-ph-magnifying-glass"></i>
									{$LL.admin_external_idp_discover()}
								{/if}
							</button>
						</div>
						{#if discoveryError}
							<p class="form-error">{discoveryError}</p>
						{:else}
							<p class="field-hint">
								{$LL.admin_external_idp_discovery_edit_hint()}
							</p>
						{/if}
					</div>
				{/if}

				<div class="form-grid">
					<div class="admin-field">
						<label for="clientId" class="admin-field__label"
							>{$LL.admin_external_idp_client_id_required()}</label
						>
						<input id="clientId" type="text" bind:value={clientId} required class="admin-input" />
					</div>

					<div class="admin-field">
						<label for="clientSecret" class="admin-field__label"
							>{$LL.admin_external_idp_client_secret_keep()}</label
						>
						<input
							id="clientSecret"
							type="password"
							bind:value={clientSecret}
							placeholder={$LL.admin_external_idp_client_secret_update_placeholder()}
							class="admin-input"
						/>
						{#if provider.hasSecret}
							<p class="field-hint text-success">{$LL.admin_external_idp_secret_configured()}</p>
						{/if}
					</div>

					{#if providerType === 'oidc'}
						<div class="admin-field admin-field--full">
							<label for="issuer" class="admin-field__label"
								>{$LL.admin_external_idp_issuer_url()}</label
							>
							<input
								id="issuer"
								type="url"
								bind:value={issuer}
								placeholder="https://accounts.google.com"
								class="admin-input"
							/>
						</div>
					{/if}

					<div class="admin-field admin-field--full">
						<label for="scopes" class="admin-field__label">{$LL.admin_external_idp_scopes()}</label>
						<input
							id="scopes"
							type="text"
							bind:value={scopes}
							placeholder="openid email profile"
							class="admin-input"
						/>
					</div>
				</div>

				<details class="advanced-details">
					<summary class="advanced-details-summary">
						{$LL.admin_external_idp_advanced_endpoints()}
					</summary>
					<div class="form-grid form-grid--nested">
						<div class="admin-field">
							<label for="authorizationEndpoint" class="admin-field__label"
								>{$LL.admin_external_idp_authorization_endpoint()}</label
							>
							<input
								id="authorizationEndpoint"
								type="url"
								bind:value={authorizationEndpoint}
								class="admin-input"
							/>
						</div>

						<div class="admin-field">
							<label for="tokenEndpoint" class="admin-field__label"
								>{$LL.admin_external_idp_token_endpoint()}</label
							>
							<input id="tokenEndpoint" type="url" bind:value={tokenEndpoint} class="admin-input" />
						</div>

						<div class="admin-field">
							<label for="userinfoEndpoint" class="admin-field__label"
								>{$LL.admin_external_idp_userinfo_endpoint()}</label
							>
							<input
								id="userinfoEndpoint"
								type="url"
								bind:value={userinfoEndpoint}
								class="admin-input"
							/>
						</div>

						<div class="admin-field">
							<label for="jwksUri" class="admin-field__label"
								>{$LL.admin_external_idp_jwks_uri()}</label
							>
							<input id="jwksUri" type="url" bind:value={jwksUri} class="admin-input" />
						</div>
					</div>
				</details>
			</AdminSection>

			{#if providerType === 'oidc'}
				<AdminSection title="Dynamic Client Registration">
					<div class="behavior-settings-list">
						<ToggleSwitch
							bind:checked={dynamicRegistrationEnabled}
							label="Enable dynamic client registration"
							description="Register this RP from the provider's discovery registration_endpoint. Existing credentials are replaced only after a successful registration."
						/>
					</div>

					{#if dynamicRegistrationEnabled}
						<div class="form-grid dynamic-registration-fields">
							<div class="admin-field">
								<label for="dynamicClientName" class="admin-field__label">Client name</label>
								<input
									id="dynamicClientName"
									type="text"
									bind:value={dynamicClientName}
									placeholder={name}
									class="admin-input"
								/>
							</div>

							<div class="admin-field">
								<label for="userinfoSignedResponseAlg" class="admin-field__label"
									>Signed UserInfo algorithm</label
								>
								<select
									id="userinfoSignedResponseAlg"
									bind:value={userinfoSignedResponseAlg}
									class="admin-select"
								>
									<option value="">Provider default (JSON allowed)</option>
									<option value="RS256">RS256</option>
									<option value="ES256">ES256</option>
								</select>
							</div>

							<div class="admin-field admin-field--full">
								<label for="initiateLoginUri" class="admin-field__label"
									>Initiate login URI</label
								>
								<input
									id="initiateLoginUri"
									type="url"
									bind:value={initiateLoginUri}
									placeholder="https://rp.example.com/auth/external/provider/initiate-login"
									class="admin-input"
								/>
								<p class="field-hint">Optional metadata for third-party initiated login.</p>
							</div>

							<div class="admin-field admin-field--full">
								<label for="requestUris" class="admin-field__label">Request URIs</label>
								<textarea
									id="requestUris"
									bind:value={requestUris}
									rows="3"
									placeholder="One HTTPS request_uri per line"
									class="admin-input"
								></textarea>
							</div>
						</div>

						{#if registrationError}
							<div class="alert alert-error">{registrationError}</div>
						{/if}
						{#if registrationSuccess}
							<div class="alert alert-success">Dynamic registration completed.</div>
						{/if}
						<div class="registration-actions">
							<button
								type="button"
								class="btn btn-secondary"
								onclick={handleDynamicRegistration}
								disabled={registering || saving}
							>
								{registering ? 'Registering…' : 'Register now'}
							</button>
							<p class="field-hint">Save configuration changes before registering.</p>
						</div>
					{/if}
				</AdminSection>
			{/if}

			<!-- Behavior Settings -->
			<AdminSection title={$LL.admin_external_idp_behavior_settings()}>
				<div class="behavior-settings-list">
					<ToggleSwitch
						bind:checked={autoLinkEmail}
						label={$LL.admin_external_idp_auto_link_email()}
						description={$LL.admin_external_idp_auto_link_email_desc()}
					/>

					<ToggleSwitch
						bind:checked={jitProvisioning}
						label={$LL.admin_external_idp_jit_provisioning()}
						description={$LL.admin_external_idp_jit_provisioning_desc()}
					/>

					<ToggleSwitch
						bind:checked={requireEmailVerified}
						label={$LL.admin_external_idp_require_email_verified()}
						description={$LL.admin_external_idp_require_email_verified_desc()}
					/>

					<ToggleSwitch
						bind:checked={alwaysFetchUserinfo}
						label={$LL.admin_external_idp_always_fetch_userinfo()}
						description={$LL.admin_external_idp_always_fetch_userinfo_desc()}
					/>
				</div>
			</AdminSection>

			<!-- UI Customization -->
			<AdminSection title={$LL.admin_external_idp_ui_customization()}>
				<div class="form-grid">
					<div class="admin-field admin-field--full">
						<label for="iconUrl" class="admin-field__label"
							>{$LL.admin_external_idp_icon_url()}</label
						>
						<input
							id="iconUrl"
							type="url"
							bind:value={iconUrl}
							placeholder="ex. https://example.com/icon.png"
							class="admin-input"
						/>
					</div>

					<div class="admin-field admin-field--full">
						<LoginProviderIconPicker
							bind:value={iconName}
							defaultIcon="sign-in"
							defaultLabel={$LL.admin_external_idp_icon_automatic()}
							description={$LL.admin_external_idp_icon_picker_desc()}
						/>
					</div>

					<div class="admin-field">
						<label for="buttonColor" class="admin-field__label"
							>{$LL.admin_external_idp_button_color_light()}</label
						>
						<div class="color-picker-row">
							<input type="color" bind:value={buttonColor} class="color-picker-input" />
							<input
								id="buttonColor"
								type="text"
								bind:value={buttonColor}
								placeholder="ex. #4285F4"
								class="admin-input"
							/>
						</div>
					</div>

					<div class="admin-field">
						<label for="buttonColorDark" class="admin-field__label"
							>{$LL.admin_external_idp_button_color_dark()}</label
						>
						<div class="color-picker-row">
							<input type="color" bind:value={buttonColorDark} class="color-picker-input" />
							<input
								id="buttonColorDark"
								type="text"
								bind:value={buttonColorDark}
								placeholder="ex. #8AB4F8"
								class="admin-input"
							/>
						</div>
					</div>

					<div class="admin-field admin-field--full">
						<label for="buttonText" class="admin-field__label"
							>{$LL.admin_external_idp_button_text()}</label
						>
						<input
							id="buttonText"
							type="text"
							bind:value={buttonText}
							placeholder={name
								? $LL.admin_external_idp_button_text_named_placeholder({ name })
								: $LL.admin_external_idp_button_text_placeholder()}
							class="admin-input"
						/>
						<p class="field-hint">{$LL.admin_external_idp_button_text_hint()}</p>
					</div>
				</div>
			</AdminSection>

			<!-- Actions -->
			<div class="form-actions">
				<button type="button" class="btn btn-secondary" onclick={navigateBack}>
					{$LL.dialog_cancel()}
				</button>
				<button type="submit" class="btn btn-primary" disabled={saving}>
					{saving ? $LL.admin_client_detail_saving() : $LL.admin_user_detail_save()}
				</button>
			</div>
		</form>
	{:else}
		<div class="empty-state">
			<p>{$LL.admin_external_idp_not_found_desc()}</p>
			<button class="btn btn-primary" onclick={navigateBack}
				>{$LL.admin_external_idp_back_to_providers()}</button
			>
		</div>
	{/if}
</AdminPageShell>

<style>
	form {
		display: grid;
		gap: 18px;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
	}

	.form-grid--nested {
		margin-top: 12px;
	}

	.dynamic-registration-fields {
		margin-top: 16px;
	}

	.registration-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 16px;
	}

	.admin-field {
		display: grid;
		gap: 6px;
	}

	.admin-field--full {
		grid-column: 1 / -1;
	}

	.admin-field__label {
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 700;
	}

	.admin-input,
	.admin-select {
		width: 100%;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.admin-input:focus,
	.admin-select:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.field-hint {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.5;
	}

	.redirect-url-section {
		margin-top: 16px;
		display: grid;
		gap: 8px;
	}

	.input-copy-group {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.callback-url-input {
		flex: 1;
		font-family:
			ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
		font-size: 0.82rem;
	}

	.copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 var(--control-height, 40px);
		width: var(--control-height, 40px);
		height: var(--control-height, 40px);
		padding: 0;
		background: var(--control-bg, var(--color-surface));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		color: var(--color-text-muted);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.copy-btn:hover {
		background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
		color: var(--color-accent);
		border-color: var(--color-accent);
	}

	.copy-success {
		color: var(--color-success);
	}

	.input-error {
		border-color: var(--color-danger) !important;
	}

	.form-error {
		color: var(--color-danger);
		font-size: 12px;
		margin-top: 4px;
	}

	.text-success {
		color: var(--color-success);
	}

	.discovery-section {
		margin-bottom: 20px;
		padding-bottom: 20px;
		border-bottom: 1px solid var(--color-border);
	}

	.discovery-input-row {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}

	.discovery-input-row .admin-input {
		flex: 1;
	}

	.discovery-mode-select {
		width: 170px;
		flex: 0 0 170px;
	}

	.discovery-input-row .btn {
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}

	.spinner-small {
		width: 14px;
		height: 14px;
		border: 2px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.color-picker-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.color-picker-input {
		width: 40px;
		height: 38px;
		padding: 2px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		cursor: pointer;
		flex-shrink: 0;
	}

	.color-picker-input::-webkit-color-swatch-wrapper {
		padding: 2px;
	}

	.color-picker-input::-webkit-color-swatch {
		border: none;
		border-radius: 3px;
	}

	.color-picker-row .admin-input {
		flex: 1;
	}

	.behavior-settings-list {
		display: grid;
		gap: 14px;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding-top: 4px;
	}

	@media (max-width: 720px) {
		.form-grid {
			grid-template-columns: 1fr;
		}

		.admin-field--full {
			grid-column: auto;
		}

		.discovery-input-row,
		.input-copy-group,
		.registration-actions,
		.form-actions {
			align-items: stretch;
			flex-direction: column;
		}

		.discovery-mode-select {
			width: 100%;
			flex-basis: auto;
		}

		.copy-btn {
			width: 100%;
			flex-basis: var(--control-height, 40px);
		}
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminExternalProvidersAPI,
		type ExternalIdPProvider,
		type UpdateProviderRequest
	} from '$lib/api/admin-external-providers';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import LoginProviderIconPicker from '$lib/components/admin/LoginProviderIconPicker.svelte';
	import { ToggleSwitch } from '$lib/components';

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
	let discovering = $state(false);
	let discoveryError = $state('');

	const providerId = $derived($page.params.id);

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

	// Compute redirect URL (use current slug value for preview)
	const redirectUrl = $derived(() => {
		if (!provider) return null;
		const baseUrl =
			typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.com';
		// Show URL with current slug input (for preview), fallback to provider ID
		const identifier = slug || provider.id;
		if (slugError) return null; // Don't show if invalid
		return `${baseUrl}/auth/external/${identifier}/callback`;
	});

	async function copyRedirectUrl() {
		const url = redirectUrl();
		if (url && typeof navigator !== 'undefined') {
			await navigator.clipboard.writeText(url);
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2000);
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
			const config = await adminExternalProvidersAPI.discoverOidcConfig(discoveryUrl.trim());

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
		} catch (err) {
			console.error('Failed to load provider:', err);
			error = err instanceof Error ? err.message : $LL.admin_external_idp_error_load_provider();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadProvider();
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
				button_text: buttonText || undefined
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
				{#if redirectUrl()}
					<div class="redirect-url-section">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="admin-field__label">{$LL.admin_external_idp_redirect_url()}</label>
						<div class="redirect-url-box">
							<code class="redirect-url-text">{redirectUrl()}</code>
							<button
								type="button"
								class="copy-btn"
								onclick={copyRedirectUrl}
								title={$LL.admin_external_idp_copy_to_clipboard()}
							>
								{#if copySuccess}
									<span class="copy-success">✓</span>
								{:else}
									<i class="i-ph-copy"></i>
								{/if}
							</button>
						</div>
					</div>
				{/if}
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
							<input
								id="discoveryUrl"
								type="url"
								bind:value={discoveryUrl}
								placeholder={$LL.admin_external_idp_discovery_placeholder()}
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
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	.redirect-url-box {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
		padding: 10px 12px;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
	}

	.redirect-url-text {
		flex: 1;
		font-size: 13px;
		color: var(--color-text);
		word-break: break-all;
	}

	.copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 6px;
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
		font-weight: 600;
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
		.form-actions {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>

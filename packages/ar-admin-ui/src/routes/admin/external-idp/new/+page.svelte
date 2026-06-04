<script lang="ts">
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminExternalProvidersAPI,
		type CreateProviderRequest,
		type ProviderTemplate,
		PROVIDER_TEMPLATES
	} from '$lib/api/admin-external-providers';
	import LoginProviderIconPicker from '$lib/components/admin/LoginProviderIconPicker.svelte';
	import { ToggleSwitch } from '$lib/components';

	let saving = $state(false);
	let error = $state('');

	// Template selection
	let selectedTemplate = $state<ProviderTemplate | 'custom'>('custom');

	// Form state
	let name = $state('');
	let slug = $state('');
	let providerType = $state<'oidc' | 'oauth2'>('oidc');
	let enabled = $state(true);
	let priority = $state(0);
	let clientId = $state('');
	let clientSecret = $state('');
	let issuer = $state('');
	let scopes = $state('openid email profile');
	let authorizationEndpoint = $state('');
	let tokenEndpoint = $state('');
	let userinfoEndpoint = $state('');
	let jwksUri = $state('');
	let autoLinkEmail = $state(true);
	let jitProvisioning = $state(true);
	let requireEmailVerified = $state(true);
	let alwaysFetchUserinfo = $state(false);
	let iconUrl = $state('');
	let iconName = $state('');
	let buttonColor = $state('');
	let buttonColorDark = $state('');
	let buttonText = $state('');
	let copySuccess = $state(false);
	let slugManuallyEdited = $state(false);
	let slugError = $state('');
	let discoveryUrl = $state('');
	let discovering = $state(false);
	let discoveryError = $state('');

	// Generate URL-safe slug from name
	function generateSlug(input: string): string {
		let result = input
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '') // Remove accents
			.replace(/[^a-z0-9\s-]/g, '') // Keep only alphanumeric, space, hyphen
			.replace(/\s+/g, '-') // Space to hyphen
			.replace(/-+/g, '-') // Collapse multiple hyphens
			.replace(/^-|-$/g, '') // Trim hyphens from ends
			.substring(0, 50); // Max length

		// If result is empty (e.g., Japanese-only name), generate fallback
		if (!result) {
			result = `custom-${Date.now().toString(36)}`;
		}

		return result;
	}

	// Validate slug format
	function validateSlug(value: string): string {
		if (!value) return $LL.admin_external_idp_slug_required_error();
		if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(value)) {
			return $LL.admin_external_idp_slug_format_error();
		}
		if (value.length > 50) return $LL.admin_external_idp_slug_length_error();
		return '';
	}

	// Auto-generate slug when name changes (unless manually edited)
	function handleNameChange() {
		if (!slugManuallyEdited && selectedTemplate === 'custom') {
			slug = generateSlug(name);
			slugError = validateSlug(slug);
		}
	}

	// Mark slug as manually edited
	function handleSlugInput() {
		slugManuallyEdited = true;
		slugError = validateSlug(slug);
	}

	// Compute redirect URL based on slug
	const redirectUrl = $derived(() => {
		const baseUrl =
			typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.com';
		if (slug && !slugError) {
			return `${baseUrl}/auth/external/${slug}/callback`;
		}
		return null;
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

			discoveryError = ''; // Clear any previous error
		} catch (err) {
			console.error('OIDC Discovery failed:', err);
			discoveryError =
				err instanceof Error ? err.message : $LL.admin_external_idp_discovery_error();
		} finally {
			discovering = false;
		}
	}

	function handleTemplateChange() {
		slugManuallyEdited = false;
		slugError = '';
		const template = PROVIDER_TEMPLATES.find((t) => t.id === selectedTemplate);
		if (template) {
			name = template.name;
			slug = template.id;
			providerType = template.providerType;

			// Set template-specific defaults
			switch (selectedTemplate) {
				case 'google':
					scopes = 'openid email profile';
					buttonColor = '#4285F4';
					buttonColorDark = '#8AB4F8';
					break;
				case 'github':
					scopes = 'read:user user:email';
					buttonColor = '#24292E';
					buttonColorDark = '#C9D1D9';
					break;
				case 'microsoft':
					scopes = 'openid email profile';
					buttonColor = '#00A4EF';
					buttonColorDark = '#4CC2FF';
					break;
				case 'linkedin':
					scopes = 'openid email profile';
					buttonColor = '#0A66C2';
					buttonColorDark = '#70B5F9';
					break;
				case 'facebook':
					scopes = 'email public_profile';
					buttonColor = '#1877F2';
					buttonColorDark = '#4599FF';
					break;
				case 'twitter':
					scopes = 'users.read tweet.read offline.access';
					buttonColor = '#1DA1F2';
					buttonColorDark = '#71C9F8';
					break;
				case 'apple':
					scopes = 'name email';
					buttonColor = '#000000';
					buttonColorDark = '#FFFFFF';
					break;
			}
		} else {
			// Reset to defaults for custom
			name = '';
			slug = '';
			scopes = 'openid email profile';
			buttonColor = '';
			buttonColorDark = '';
			buttonText = '';
		}
	}

	async function handleSubmit() {
		// Validate slug before submission
		slugError = validateSlug(slug);
		if (slugError) {
			error = slugError;
			return;
		}

		saving = true;
		error = '';

		try {
			const createData: CreateProviderRequest = {
				name,
				slug,
				provider_type: providerType,
				enabled,
				priority,
				client_id: clientId,
				client_secret: clientSecret,
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
				icon_url: iconUrl || undefined,
				icon_name: iconName || undefined,
				button_color: buttonColor || undefined,
				button_color_dark: buttonColorDark || undefined,
				button_text: buttonText || undefined
			};

			// Add template if using a predefined one
			if (selectedTemplate !== 'custom') {
				createData.template = selectedTemplate as ProviderTemplate;
			}

			const provider = await adminExternalProvidersAPI.create(createData);
			goto(`/admin/external-idp/${provider.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_external_idp_error_create();
		} finally {
			saving = false;
		}
	}

	function navigateBack() {
		goto('/admin/external-idp');
	}
</script>

<svelte:head>
	<title>{$LL.admin_external_idp_new_page_title()}</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/external-idp" class="back-link">← {$LL.admin_external_idp_back()}</a>

	<h1 class="page-title">{$LL.admin_external_idp_new_title()}</h1>

	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
	>
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}

		<!-- Template Selection -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_external_idp_template_title()}</h2>
			<p class="form-hint" style="margin-bottom: 16px;">
				{$LL.admin_external_idp_template_desc()}
			</p>

			<div class="template-grid">
				<button
					type="button"
					class="template-card"
					class:template-card-selected={selectedTemplate === 'custom'}
					onclick={() => {
						selectedTemplate = 'custom';
						handleTemplateChange();
					}}
				>
					<div class="i-ph-gear h-5 w-5 template-icon"></div>
					<div class="template-name">{$LL.admin_external_idp_template_custom()}</div>
					<div class="template-desc">{$LL.admin_external_idp_template_custom_desc()}</div>
				</button>

				{#each PROVIDER_TEMPLATES as template (template.id)}
					<button
						type="button"
						class="template-card"
						class:template-card-selected={selectedTemplate === template.id}
						onclick={() => {
							selectedTemplate = template.id;
							handleTemplateChange();
						}}
					>
						<div class="{template.icon} h-5 w-5 template-icon"></div>
						<div class="template-name">{template.name}</div>
						<div class="template-desc">{template.providerType.toUpperCase()}</div>
					</button>
				{/each}
			</div>
		</div>

		<!-- Basic Information -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_external_idp_basic_information()}</h2>

			<div class="form-grid">
				<div class="form-group">
					<label for="name" class="form-label">{$LL.admin_external_idp_name_required()}</label>
					<input
						id="name"
						type="text"
						bind:value={name}
						oninput={handleNameChange}
						required
						placeholder={$LL.admin_external_idp_name_placeholder()}
						class="form-input"
					/>
				</div>

				<div class="form-group">
					<label for="slug" class="form-label">{$LL.admin_external_idp_slug_required()}</label>
					<input
						id="slug"
						type="text"
						bind:value={slug}
						oninput={handleSlugInput}
						required
						placeholder={$LL.admin_external_idp_slug_placeholder()}
						class="form-input"
						class:input-error={slugError}
					/>
					{#if slugError}
						<p class="form-error">{slugError}</p>
					{:else}
						<p class="form-hint">{$LL.admin_external_idp_slug_hint()}</p>
					{/if}
				</div>

				<div class="form-group">
					<label for="providerType" class="form-label"
						>{$LL.admin_external_idp_provider_type()}</label
					>
					<select id="providerType" bind:value={providerType} class="form-select">
						<option value="oidc">OIDC (OpenID Connect)</option>
						<option value="oauth2">OAuth 2.0</option>
					</select>
				</div>

				<div class="form-group">
					<label for="priority" class="form-label">{$LL.admin_external_idp_priority()}</label>
					<input id="priority" type="number" bind:value={priority} min="0" class="form-input" />
				</div>
			</div>

			<!-- Redirect URL Display -->
			<div class="redirect-url-section">
				<!-- svelte-ignore a11y_label_has_associated_control -->
				<label class="form-label">{$LL.admin_external_idp_redirect_url()}</label>
				{#if redirectUrl()}
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
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
									<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
								</svg>
							{/if}
						</button>
					</div>
				{:else}
					<p class="form-hint">
						{$LL.admin_external_idp_redirect_url_hint()}
					</p>
				{/if}
			</div>
		</div>

		<!-- Enable/Disable Toggle -->
		<div class="panel">
			<ToggleSwitch
				bind:checked={enabled}
				label={$LL.admin_external_idp_provider_status()}
				description={$LL.admin_external_idp_provider_status_desc()}
			/>
		</div>

		<!-- OAuth/OIDC Configuration -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_external_idp_oauth_config()}</h2>

			<!-- OIDC Discovery -->
			{#if providerType === 'oidc'}
				<div class="discovery-section">
					<label for="discoveryUrl" class="form-label"
						>{$LL.admin_external_idp_discovery_label()}</label
					>
					<div class="discovery-input-row">
						<input
							id="discoveryUrl"
							type="url"
							bind:value={discoveryUrl}
							placeholder={$LL.admin_external_idp_discovery_placeholder()}
							class="form-input"
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
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<circle cx="11" cy="11" r="8"></circle>
									<path d="m21 21-4.3-4.3"></path>
								</svg>
								{$LL.admin_external_idp_discover()}
							{/if}
						</button>
					</div>
					{#if discoveryError}
						<p class="form-error">{discoveryError}</p>
					{:else}
						<p class="form-hint">
							{$LL.admin_external_idp_discovery_hint()}
						</p>
					{/if}
				</div>
			{/if}

			<div class="form-grid">
				<div class="form-group">
					<label for="clientId" class="form-label"
						>{$LL.admin_external_idp_client_id_required()}</label
					>
					<input
						id="clientId"
						type="text"
						bind:value={clientId}
						required
						placeholder={$LL.admin_external_idp_client_id_placeholder()}
						class="form-input"
					/>
				</div>

				<div class="form-group">
					<label for="clientSecret" class="form-label"
						>{$LL.admin_external_idp_client_secret_required()}</label
					>
					<input
						id="clientSecret"
						type="password"
						bind:value={clientSecret}
						required
						placeholder={$LL.admin_external_idp_client_secret_placeholder()}
						class="form-input"
					/>
				</div>

				{#if providerType === 'oidc'}
					<div class="form-group form-group-full">
						<label for="issuer" class="form-label">{$LL.admin_external_idp_issuer_url()}</label>
						<input
							id="issuer"
							type="url"
							bind:value={issuer}
							placeholder="https://accounts.google.com"
							class="form-input"
						/>
						<p class="form-hint">
							{$LL.admin_external_idp_issuer_hint()}
						</p>
					</div>
				{/if}

				<div class="form-group form-group-full">
					<label for="scopes" class="form-label">{$LL.admin_external_idp_scopes()}</label>
					<input
						id="scopes"
						type="text"
						bind:value={scopes}
						placeholder="openid email profile"
						class="form-input"
					/>
				</div>
			</div>

			{#if selectedTemplate === 'custom' || providerType === 'oauth2'}
				<details class="advanced-details" open={providerType === 'oauth2'}>
					<summary class="advanced-details-summary">
						{$LL.admin_external_idp_manual_endpoints()}
					</summary>
					<div class="form-grid" style="margin-top: 12px;">
						<div class="form-group">
							<label for="authorizationEndpoint" class="form-label"
								>{$LL.admin_external_idp_authorization_endpoint()}</label
							>
							<input
								id="authorizationEndpoint"
								type="url"
								bind:value={authorizationEndpoint}
								placeholder="https://provider.com/oauth/authorize"
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="tokenEndpoint" class="form-label"
								>{$LL.admin_external_idp_token_endpoint()}</label
							>
							<input
								id="tokenEndpoint"
								type="url"
								bind:value={tokenEndpoint}
								placeholder="https://provider.com/oauth/token"
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="userinfoEndpoint" class="form-label"
								>{$LL.admin_external_idp_userinfo_endpoint()}</label
							>
							<input
								id="userinfoEndpoint"
								type="url"
								bind:value={userinfoEndpoint}
								placeholder="https://provider.com/oauth/userinfo"
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="jwksUri" class="form-label">{$LL.admin_external_idp_jwks_uri()}</label>
							<input
								id="jwksUri"
								type="url"
								bind:value={jwksUri}
								placeholder="https://provider.com/.well-known/jwks.json"
								class="form-input"
							/>
						</div>
					</div>
				</details>
			{/if}
		</div>

		<!-- Behavior Settings -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_external_idp_behavior_settings()}</h2>

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
		</div>

		<!-- UI Customization -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_external_idp_ui_customization()}</h2>

			<div class="form-grid">
				<div class="form-group form-group-full">
					<label for="iconUrl" class="form-label">{$LL.admin_external_idp_icon_url()}</label>
					<input
						id="iconUrl"
						type="url"
						bind:value={iconUrl}
						placeholder="ex. https://example.com/icon.png"
						class="form-input"
					/>
				</div>

				<div class="form-group form-group-full">
					<LoginProviderIconPicker
						bind:value={iconName}
						defaultIcon="sign-in"
						defaultLabel={$LL.admin_external_idp_icon_automatic()}
						description={$LL.admin_external_idp_icon_picker_desc()}
					/>
				</div>

				<div class="form-group">
					<label for="buttonColor" class="form-label"
						>{$LL.admin_external_idp_button_color_light()}</label
					>
					<div class="color-picker-row">
						<input type="color" bind:value={buttonColor} class="color-picker-input" />
						<input
							id="buttonColor"
							type="text"
							bind:value={buttonColor}
							placeholder="ex. #4285F4"
							class="form-input"
						/>
					</div>
				</div>

				<div class="form-group">
					<label for="buttonColorDark" class="form-label"
						>{$LL.admin_external_idp_button_color_dark()}</label
					>
					<div class="color-picker-row">
						<input type="color" bind:value={buttonColorDark} class="color-picker-input" />
						<input
							id="buttonColorDark"
							type="text"
							bind:value={buttonColorDark}
							placeholder="ex. #8AB4F8"
							class="form-input"
						/>
					</div>
				</div>

				<div class="form-group form-group-full">
					<label for="buttonText" class="form-label">{$LL.admin_external_idp_button_text()}</label>
					<input
						id="buttonText"
						type="text"
						bind:value={buttonText}
						placeholder={name
							? $LL.admin_external_idp_button_text_named_placeholder({ name })
							: $LL.admin_external_idp_button_text_placeholder()}
						class="form-input"
					/>
					<p class="form-hint">{$LL.admin_external_idp_button_text_hint()}</p>
				</div>
			</div>
		</div>

		<!-- Actions -->
		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack}>
				{$LL.dialog_cancel()}
			</button>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{saving ? $LL.admin_external_idp_creating() : $LL.admin_external_idp_create_provider()}
			</button>
		</div>
	</form>
</div>

<style>
	.redirect-url-section {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}

	.redirect-url-box {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
		padding: 10px 12px;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.redirect-url-text {
		flex: 1;
		font-size: 13px;
		color: var(--text-primary);
		word-break: break-all;
	}

	.copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 6px;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text-secondary);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.copy-btn:hover {
		background: var(--primary-light);
		color: var(--primary);
		border-color: var(--primary);
	}

	.copy-success {
		color: #10b981;
		font-weight: 600;
	}

	.input-error {
		border-color: #ef4444 !important;
	}

	.form-error {
		color: #ef4444;
		font-size: 12px;
		margin-top: 4px;
	}

	.discovery-section {
		margin-bottom: 20px;
		padding-bottom: 20px;
		border-bottom: 1px solid var(--border);
	}

	.discovery-input-row {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}

	.discovery-input-row .form-input {
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
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
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

	.color-picker-row .form-input {
		flex: 1;
	}
</style>

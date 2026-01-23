<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		adminExternalProvidersAPI,
		type CreateProviderRequest,
		type ProviderTemplate,
		PROVIDER_TEMPLATES
	} from '$lib/api/admin-external-providers';
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
	let buttonColor = $state('');
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
		if (!value) return 'Slug is required';
		if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(value)) {
			return 'Slug must contain only lowercase letters, numbers, and hyphens (cannot start/end with hyphen)';
		}
		if (value.length > 50) return 'Slug must be 50 characters or less';
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
			discoveryError = 'Please enter a Discovery URL';
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
			discoveryError = err instanceof Error ? err.message : 'Failed to discover OIDC configuration';
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
			buttonText = `Sign in with ${template.name}`;

			// Set template-specific defaults
			switch (selectedTemplate) {
				case 'google':
					scopes = 'openid email profile';
					buttonColor = '#4285F4';
					break;
				case 'github':
					scopes = 'read:user user:email';
					buttonColor = '#24292E';
					break;
				case 'microsoft':
					scopes = 'openid email profile';
					buttonColor = '#00A4EF';
					break;
				case 'linkedin':
					scopes = 'openid email profile';
					buttonColor = '#0A66C2';
					break;
				case 'facebook':
					scopes = 'email public_profile';
					buttonColor = '#1877F2';
					break;
				case 'twitter':
					scopes = 'users.read tweet.read offline.access';
					buttonColor = '#1DA1F2';
					break;
				case 'apple':
					scopes = 'name email';
					buttonColor = '#000000';
					break;
			}
		} else {
			// Reset to defaults for custom
			name = '';
			slug = '';
			scopes = 'openid email profile';
			buttonColor = '';
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
				button_color: buttonColor || undefined,
				button_text: buttonText || undefined
			};

			// Add template if using a predefined one
			if (selectedTemplate !== 'custom') {
				createData.template = selectedTemplate as ProviderTemplate;
			}

			const provider = await adminExternalProvidersAPI.create(createData);
			goto(`/admin/external-idp/${provider.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create provider';
		} finally {
			saving = false;
		}
	}

	function navigateBack() {
		goto('/admin/external-idp');
	}
</script>

<svelte:head>
	<title>Add External Identity Provider - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/external-idp" class="back-link">← Back to External IdP</a>

	<h1 class="page-title">Add External Identity Provider</h1>

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
			<h2 class="panel-title">Choose a Template (Optional)</h2>
			<p class="form-hint" style="margin-bottom: 16px;">
				Select a provider template for pre-configured defaults, or choose "Custom" to configure
				manually.
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
					<div class="template-name">Custom</div>
					<div class="template-desc">Manual config</div>
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
						<div class="template-name">{template.name}</div>
						<div class="template-desc">{template.providerType.toUpperCase()}</div>
					</button>
				{/each}
			</div>
		</div>

		<!-- Basic Information -->
		<div class="panel">
			<h2 class="panel-title">Basic Information</h2>

			<div class="form-grid">
				<div class="form-group">
					<label for="name" class="form-label">Name *</label>
					<input
						id="name"
						type="text"
						bind:value={name}
						oninput={handleNameChange}
						required
						placeholder="e.g., Google"
						class="form-input"
					/>
				</div>

				<div class="form-group">
					<label for="slug" class="form-label">Slug *</label>
					<input
						id="slug"
						type="text"
						bind:value={slug}
						oninput={handleSlugInput}
						required
						placeholder="e.g., google"
						class="form-input"
						class:input-error={slugError}
					/>
					{#if slugError}
						<p class="form-error">{slugError}</p>
					{:else}
						<p class="form-hint">Auto-generated from name. Used in redirect URL.</p>
					{/if}
				</div>

				<div class="form-group">
					<label for="providerType" class="form-label">Provider Type</label>
					<select id="providerType" bind:value={providerType} class="form-select">
						<option value="oidc">OIDC (OpenID Connect)</option>
						<option value="oauth2">OAuth 2.0</option>
					</select>
				</div>

				<div class="form-group">
					<label for="priority" class="form-label">Priority</label>
					<input id="priority" type="number" bind:value={priority} min="0" class="form-input" />
				</div>
			</div>

			<!-- Redirect URL Display -->
			<div class="redirect-url-section">
				<label class="form-label">Redirect URL (for external IdP configuration)</label>
				{#if redirectUrl()}
					<div class="redirect-url-box">
						<code class="redirect-url-text">{redirectUrl()}</code>
						<button
							type="button"
							class="copy-btn"
							onclick={copyRedirectUrl}
							title="Copy to clipboard"
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
						Enter a slug above to see the redirect URL, or it will be generated using the Provider
						ID after saving.
					</p>
				{/if}
			</div>
		</div>

		<!-- Enable/Disable Toggle -->
		<div class="panel feature-toggle-panel">
			<div class="feature-toggle-row">
				<div class="feature-toggle-info">
					<h3 class="feature-toggle-title">Provider Status</h3>
					<p class="feature-toggle-description">
						Enable or disable this identity provider. When disabled, users cannot sign in using this
						provider.
					</p>
				</div>
				<div class="feature-toggle-control">
					<ToggleSwitch bind:checked={enabled} />
				</div>
			</div>
		</div>

		<!-- OAuth/OIDC Configuration -->
		<div class="panel">
			<h2 class="panel-title">OAuth/OIDC Configuration</h2>

			<!-- OIDC Discovery -->
			{#if providerType === 'oidc'}
				<div class="discovery-section">
					<label for="discoveryUrl" class="form-label"
						>Auto-discover from OpenID Configuration</label
					>
					<div class="discovery-input-row">
						<input
							id="discoveryUrl"
							type="url"
							bind:value={discoveryUrl}
							placeholder="https://accounts.google.com or https://accounts.google.com/.well-known/openid-configuration"
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
								Discovering...
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
								Discover
							{/if}
						</button>
					</div>
					{#if discoveryError}
						<p class="form-error">{discoveryError}</p>
					{:else}
						<p class="form-hint">
							Enter the issuer URL or full discovery URL. Endpoints will be auto-filled.
						</p>
					{/if}
				</div>
			{/if}

			<div class="form-grid">
				<div class="form-group">
					<label for="clientId" class="form-label">Client ID *</label>
					<input
						id="clientId"
						type="text"
						bind:value={clientId}
						required
						placeholder="Your OAuth client ID"
						class="form-input"
					/>
				</div>

				<div class="form-group">
					<label for="clientSecret" class="form-label">Client Secret *</label>
					<input
						id="clientSecret"
						type="password"
						bind:value={clientSecret}
						required
						placeholder="Your OAuth client secret"
						class="form-input"
					/>
				</div>

				{#if providerType === 'oidc'}
					<div class="form-group form-group-full">
						<label for="issuer" class="form-label">Issuer URL</label>
						<input
							id="issuer"
							type="url"
							bind:value={issuer}
							placeholder="https://accounts.google.com"
							class="form-input"
						/>
						<p class="form-hint">
							For OIDC providers, the issuer URL is used to discover endpoints automatically
						</p>
					</div>
				{/if}

				<div class="form-group form-group-full">
					<label for="scopes" class="form-label">Scopes</label>
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
						Manual Endpoints (required for OAuth 2.0 or custom OIDC)
					</summary>
					<div class="form-grid" style="margin-top: 12px;">
						<div class="form-group">
							<label for="authorizationEndpoint" class="form-label">Authorization Endpoint</label>
							<input
								id="authorizationEndpoint"
								type="url"
								bind:value={authorizationEndpoint}
								placeholder="https://provider.com/oauth/authorize"
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="tokenEndpoint" class="form-label">Token Endpoint</label>
							<input
								id="tokenEndpoint"
								type="url"
								bind:value={tokenEndpoint}
								placeholder="https://provider.com/oauth/token"
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="userinfoEndpoint" class="form-label">Userinfo Endpoint</label>
							<input
								id="userinfoEndpoint"
								type="url"
								bind:value={userinfoEndpoint}
								placeholder="https://provider.com/oauth/userinfo"
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="jwksUri" class="form-label">JWKS URI</label>
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
			<h2 class="panel-title">Behavior Settings</h2>

			<div class="behavior-settings-list">
				<ToggleSwitch
					bind:checked={autoLinkEmail}
					label="Auto Link Email"
					description="Automatically link accounts with matching email addresses"
				/>

				<ToggleSwitch
					bind:checked={jitProvisioning}
					label="JIT Provisioning"
					description="Create new user accounts on first login"
				/>

				<ToggleSwitch
					bind:checked={requireEmailVerified}
					label="Require Email Verified"
					description="Only allow users with verified email addresses"
				/>

				<ToggleSwitch
					bind:checked={alwaysFetchUserinfo}
					label="Always Fetch Userinfo"
					description="Fetch userinfo endpoint even if claims are in ID token"
				/>
			</div>
		</div>

		<!-- UI Customization -->
		<div class="panel">
			<h2 class="panel-title">UI Customization</h2>

			<div class="form-grid form-grid-3">
				<div class="form-group">
					<label for="iconUrl" class="form-label">Icon URL</label>
					<input
						id="iconUrl"
						type="url"
						bind:value={iconUrl}
						placeholder="https://..."
						class="form-input"
					/>
				</div>

				<div class="form-group">
					<label for="buttonColor" class="form-label">Button Color</label>
					<input
						id="buttonColor"
						type="text"
						bind:value={buttonColor}
						placeholder="#4285F4"
						class="form-input"
					/>
				</div>

				<div class="form-group">
					<label for="buttonText" class="form-label">Button Text</label>
					<input
						id="buttonText"
						type="text"
						bind:value={buttonText}
						placeholder="Sign in with Google"
						class="form-input"
					/>
				</div>
			</div>
		</div>

		<!-- Actions -->
		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack}> Cancel </button>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{saving ? 'Creating...' : 'Create Provider'}
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

	.feature-toggle-panel {
		margin-bottom: 20px;
	}

	.feature-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
	}

	.feature-toggle-info {
		flex: 1;
	}

	.feature-toggle-title {
		font-size: 16px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 4px 0;
	}

	.feature-toggle-description {
		font-size: 13px;
		color: var(--text-secondary);
		margin: 0;
	}

	.feature-toggle-control {
		flex-shrink: 0;
	}
</style>

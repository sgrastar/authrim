<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		adminExternalProvidersAPI,
		type ExternalIdPProvider,
		type UpdateProviderRequest
	} from '$lib/api/admin-external-providers';
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
	let iconUrl = $state('');
	let buttonColor = $state('');
	let buttonText = $state('');
	let copySuccess = $state(false);
	let slugError = $state('');
	let discoveryUrl = $state('');
	let discovering = $state(false);
	let discoveryError = $state('');

	const providerId = $derived($page.params.id);

	// Validate slug format
	function validateSlug(value: string): string {
		if (!value) return 'Slug is required';
		if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(value)) {
			return 'Slug must contain only lowercase letters, numbers, and hyphens (cannot start/end with hyphen)';
		}
		if (value.length > 50) return 'Slug must be 50 characters or less';
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

			discoveryError = '';
		} catch (err) {
			console.error('OIDC Discovery failed:', err);
			discoveryError = err instanceof Error ? err.message : 'Failed to discover OIDC configuration';
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
			iconUrl = data.iconUrl || '';
			buttonColor = data.buttonColor || '';
			buttonText = data.buttonText || '';
		} catch (err) {
			console.error('Failed to load provider:', err);
			error = err instanceof Error ? err.message : 'Failed to load provider';
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
				icon_url: iconUrl || undefined,
				button_color: buttonColor || undefined,
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
			saveError = err instanceof Error ? err.message : 'Failed to update provider';
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
		>{provider ? `Edit: ${provider.name}` : 'Provider Details'} - External IdP - Admin Dashboard - Authrim</title
	>
</svelte:head>

<div class="admin-page">
	<a href="/admin/external-idp" class="back-link">← Back to External IdP</a>

	<h1 class="page-title">
		{loading ? 'Loading...' : provider ? `Edit: ${provider.name}` : 'Provider Not Found'}
	</h1>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">Loading...</div>
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
				<div class="alert alert-success">Provider updated successfully!</div>
			{/if}

			<!-- Enable/Disable Toggle -->
			<div class="panel feature-toggle-panel">
				<div class="feature-toggle-row">
					<div class="feature-toggle-info">
						<h3 class="feature-toggle-title">Provider Status</h3>
						<p class="feature-toggle-description">
							Enable or disable this identity provider. When disabled, users cannot sign in using
							this provider.
						</p>
					</div>
					<div class="feature-toggle-control">
						<ToggleSwitch bind:checked={enabled} />
					</div>
				</div>
			</div>

			<!-- Basic Information -->
			<div class="panel">
				<h2 class="panel-title">Basic Information</h2>

				<div class="form-grid">
					<div class="form-group">
						<label for="name" class="form-label">Name *</label>
						<input id="name" type="text" bind:value={name} required class="form-input" />
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
							<p class="form-hint">
								Used in redirect URL. Changing this will require updating your external IdP
								configuration.
							</p>
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
						<p class="form-hint">Higher priority providers are shown first</p>
					</div>
				</div>

				<!-- Redirect URL Display -->
				{#if redirectUrl()}
					<div class="redirect-url-section">
						<label class="form-label">Redirect URL (for external IdP configuration)</label>
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
					</div>
				{/if}
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
								Enter the issuer URL or full discovery URL to auto-fill endpoints.
							</p>
						{/if}
					</div>
				{/if}

				<div class="form-grid">
					<div class="form-group">
						<label for="clientId" class="form-label">Client ID *</label>
						<input id="clientId" type="text" bind:value={clientId} required class="form-input" />
					</div>

					<div class="form-group">
						<label for="clientSecret" class="form-label"
							>Client Secret (leave empty to keep current)</label
						>
						<input
							id="clientSecret"
							type="password"
							bind:value={clientSecret}
							placeholder="Enter new secret to update"
							class="form-input"
						/>
						{#if provider.hasSecret}
							<p class="form-hint text-success">A secret is already configured</p>
						{/if}
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

				<details class="advanced-details">
					<summary class="advanced-details-summary">Advanced Endpoints</summary>
					<div class="form-grid" style="margin-top: 12px;">
						<div class="form-group">
							<label for="authorizationEndpoint" class="form-label">Authorization Endpoint</label>
							<input
								id="authorizationEndpoint"
								type="url"
								bind:value={authorizationEndpoint}
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="tokenEndpoint" class="form-label">Token Endpoint</label>
							<input id="tokenEndpoint" type="url" bind:value={tokenEndpoint} class="form-input" />
						</div>

						<div class="form-group">
							<label for="userinfoEndpoint" class="form-label">Userinfo Endpoint</label>
							<input
								id="userinfoEndpoint"
								type="url"
								bind:value={userinfoEndpoint}
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="jwksUri" class="form-label">JWKS URI</label>
							<input id="jwksUri" type="url" bind:value={jwksUri} class="form-input" />
						</div>
					</div>
				</details>
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
					{saving ? 'Saving...' : 'Save Changes'}
				</button>
			</div>
		</form>
	{:else}
		<div class="empty-state">
			<p>Provider not found.</p>
			<button class="btn btn-primary" onclick={navigateBack}>Back to Providers</button>
		</div>
	{/if}
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
</style>

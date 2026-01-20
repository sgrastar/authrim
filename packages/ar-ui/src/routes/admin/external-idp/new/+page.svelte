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

	function handleTemplateChange() {
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
		saving = true;
		error = '';

		try {
			const createData: CreateProviderRequest = {
				name,
				slug: slug || undefined,
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
						required
						placeholder="e.g., Google"
						class="form-input"
					/>
				</div>

				<div class="form-group">
					<label for="slug" class="form-label">Slug (optional)</label>
					<input
						id="slug"
						type="text"
						bind:value={slug}
						placeholder="e.g., google"
						class="form-input"
					/>
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

			<div class="form-group">
				<ToggleSwitch
					bind:checked={enabled}
					label="Enabled"
					description="Enable this identity provider for user authentication"
				/>
			</div>
		</div>

		<!-- OAuth/OIDC Configuration -->
		<div class="panel">
			<h2 class="panel-title">OAuth/OIDC Configuration</h2>

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

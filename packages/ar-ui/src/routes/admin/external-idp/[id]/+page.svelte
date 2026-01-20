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

	const providerId = $derived($page.params.id);

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

		saving = true;
		saveError = '';
		saveSuccess = false;

		try {
			const updateData: UpdateProviderRequest = {
				name,
				slug: slug || undefined,
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

			<!-- Basic Information -->
			<div class="panel">
				<h2 class="panel-title">Basic Information</h2>

				<div class="form-grid">
					<div class="form-group">
						<label for="name" class="form-label">Name *</label>
						<input id="name" type="text" bind:value={name} required class="form-input" />
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
						<p class="form-hint">Higher priority providers are shown first</p>
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

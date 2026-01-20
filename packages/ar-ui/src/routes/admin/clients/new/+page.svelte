<script lang="ts">
	import { adminClientsAPI, type Client, type CreateClientInput } from '$lib/api/admin-clients';
	import { ToggleSwitch } from '$lib/components';

	// Preset configuration
	interface PresetConfig {
		id: string;
		name: string;
		description: string;
		icon: string;
		clientType: 'public' | 'confidential';
		requiresRedirectUri: boolean;
		defaultGrantTypes: string[];
		pkceRequired: boolean;
	}

	const PRESET_CONFIGS: PresetConfig[] = [
		{
			id: 'spa-public',
			name: 'SPA',
			description: 'Single Page Application (React, Vue, Angular)',
			icon: '🌐',
			clientType: 'public',
			requiresRedirectUri: true,
			defaultGrantTypes: ['authorization_code', 'refresh_token'],
			pkceRequired: true
		},
		{
			id: 'mobile-native',
			name: 'Mobile',
			description: 'iOS / Android native app',
			icon: '📱',
			clientType: 'public',
			requiresRedirectUri: true,
			defaultGrantTypes: ['authorization_code', 'refresh_token'],
			pkceRequired: true
		},
		{
			id: 'server-confidential',
			name: 'Server',
			description: 'Backend server application',
			icon: '🖥️',
			clientType: 'confidential',
			requiresRedirectUri: true,
			defaultGrantTypes: ['authorization_code', 'refresh_token'],
			pkceRequired: false
		},
		{
			id: 'first-party-web',
			name: '1st Party Web',
			description: 'Your own web application',
			icon: '🏠',
			clientType: 'confidential',
			requiresRedirectUri: true,
			defaultGrantTypes: ['authorization_code', 'refresh_token'],
			pkceRequired: false
		},
		{
			id: 'm2m-service',
			name: 'M2M',
			description: 'Machine-to-machine / Service',
			icon: '⚙️',
			clientType: 'confidential',
			requiresRedirectUri: false,
			defaultGrantTypes: ['client_credentials'],
			pkceRequired: false
		},
		{
			id: 'iot-device',
			name: 'IoT',
			description: 'IoT device with limited input',
			icon: '📡',
			clientType: 'public',
			requiresRedirectUri: false,
			defaultGrantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
			pkceRequired: false
		},
		{
			id: 'custom',
			name: 'Custom',
			description: 'Configure all settings manually',
			icon: '🔧',
			clientType: 'public',
			requiresRedirectUri: true,
			defaultGrantTypes: ['authorization_code'],
			pkceRequired: false
		}
	];

	// State
	let step = $state(1);
	let selectedPreset = $state<PresetConfig | null>(null);
	let loading = $state(false);
	let error = $state('');
	let createdClient = $state<Client | null>(null);
	let showAdvanced = $state(false);

	// Form state
	let clientName = $state('');
	let redirectUris = $state<string[]>(['']);
	let grantTypes = $state<string[]>([]);
	let responseTypes = $state<string[]>(['code']);
	let tokenEndpointAuthMethod = $state('client_secret_basic');
	let scope = $state('openid profile email');
	let requirePkce = $state(false);

	function selectPreset(preset: PresetConfig) {
		selectedPreset = preset;
		grantTypes = [...preset.defaultGrantTypes];
		requirePkce = preset.pkceRequired;

		// Set auth method based on client type
		if (preset.clientType === 'confidential') {
			tokenEndpointAuthMethod = 'client_secret_basic';
		} else {
			tokenEndpointAuthMethod = 'none';
		}

		// M2M doesn't need redirect URIs
		if (!preset.requiresRedirectUri) {
			redirectUris = [];
		} else if (redirectUris.length === 0) {
			redirectUris = [''];
		}

		step = 2;
	}

	function addRedirectUri() {
		redirectUris = [...redirectUris, ''];
	}

	function removeRedirectUri(index: number) {
		redirectUris = redirectUris.filter((_, i) => i !== index);
	}

	function updateRedirectUri(index: number, value: string) {
		redirectUris = redirectUris.map((uri, i) => (i === index ? value : uri));
	}

	function toggleGrantType(grantType: string) {
		if (grantTypes.includes(grantType)) {
			grantTypes = grantTypes.filter((gt) => gt !== grantType);
		} else {
			grantTypes = [...grantTypes, grantType];
		}

		// Update PKCE requirement based on grant types
		if (!grantTypes.includes('authorization_code')) {
			requirePkce = false;
		}
	}

	async function handleSubmit() {
		if (!clientName.trim()) {
			error = 'Client name is required';
			return;
		}

		const validRedirectUris = redirectUris.filter((uri) => uri.trim());
		if (selectedPreset?.requiresRedirectUri && validRedirectUris.length === 0) {
			error = 'At least one redirect URI is required';
			return;
		}

		loading = true;
		error = '';

		try {
			const input: CreateClientInput = {
				client_name: clientName.trim(),
				redirect_uris: validRedirectUris,
				grant_types: grantTypes,
				response_types: responseTypes,
				token_endpoint_auth_method: tokenEndpointAuthMethod,
				scope: scope,
				require_pkce: requirePkce
			};

			createdClient = await adminClientsAPI.create(input);
			step = 3;
		} catch (err) {
			console.error('Failed to create client:', err);
			error = err instanceof Error ? err.message : 'Failed to create client';
		} finally {
			loading = false;
		}
	}

	function copyToClipboard(text: string) {
		navigator.clipboard.writeText(text);
	}
</script>

<svelte:head>
	<title>Create OAuth Client - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/clients" class="back-link">← Back to Clients</a>

	<h1 class="page-title">Create OAuth Client</h1>

	{#if step === 1}
		<!-- Step 1: Preset Selection -->
		<div class="panel">
			<h2 class="panel-title">Step 1: Select Application Type</h2>
			<p class="modal-description">
				Choose the type that best matches your application. This will configure optimal defaults.
			</p>

			<div class="preset-grid">
				{#each PRESET_CONFIGS as preset (preset.id)}
					<button class="preset-card" onclick={() => selectPreset(preset)}>
						<div class="preset-icon">{preset.icon}</div>
						<div class="preset-name">{preset.name}</div>
						<div class="preset-description">{preset.description}</div>
						<span
							class="preset-type-badge {preset.clientType === 'confidential'
								? 'preset-type-confidential'
								: 'preset-type-public'}"
						>
							{preset.clientType}
						</span>
					</button>
				{/each}
			</div>
		</div>
	{:else if step === 2}
		<!-- Step 2: Configuration -->
		<div class="panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">Step 2: Configure {selectedPreset?.name} Client</h2>
					<p class="modal-description">{selectedPreset?.description}</p>
				</div>
				<button
					class="btn btn-secondary btn-sm"
					onclick={() => {
						step = 1;
						selectedPreset = null;
					}}
				>
					Change Type
				</button>
			</div>

			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

			<form
				onsubmit={(e) => {
					e.preventDefault();
					handleSubmit();
				}}
			>
				<!-- Client Name -->
				<div class="form-group">
					<label for="clientName" class="form-label">
						Client Name <span style="color: var(--danger);">*</span>
					</label>
					<input
						id="clientName"
						type="text"
						class="form-input"
						bind:value={clientName}
						placeholder="My Application"
						required
					/>
				</div>

				<!-- Redirect URIs -->
				{#if selectedPreset?.requiresRedirectUri}
					<div class="form-group">
						<label class="form-label">
							Redirect URIs <span style="color: var(--danger);">*</span>
						</label>
						<p class="form-hint" style="margin-bottom: 8px;">
							The URLs where users will be redirected after authentication
						</p>
						{#each redirectUris as uri, index (index)}
							<div class="input-copy-group" style="margin-bottom: 8px;">
								<input
									type="url"
									class="form-input"
									value={uri}
									oninput={(e) => updateRedirectUri(index, e.currentTarget.value)}
									placeholder="https://example.com/callback"
								/>
								{#if redirectUris.length > 1}
									<button
										type="button"
										class="btn btn-secondary btn-sm"
										onclick={() => removeRedirectUri(index)}
									>
										×
									</button>
								{/if}
							</div>
						{/each}
						<button type="button" class="btn-add" onclick={addRedirectUri}>
							+ Add Redirect URI
						</button>
					</div>
				{:else}
					<div class="info-box">
						<p>ℹ️ {selectedPreset?.name} clients don't require redirect URIs</p>
					</div>
				{/if}

				<!-- Applied Settings Summary -->
				<div class="settings-summary">
					<h3 class="settings-summary-title">Applied Settings</h3>
					<div class="settings-summary-grid">
						<div class="settings-summary-item">
							<span class="settings-summary-label">Grant Types:</span>
							<span class="settings-summary-value">
								{grantTypes
									.map((gt) => gt.replace('urn:ietf:params:oauth:grant-type:', ''))
									.join(', ')}
							</span>
						</div>
						<div class="settings-summary-item">
							<span class="settings-summary-label">Client Type:</span>
							<span class="settings-summary-value">{selectedPreset?.clientType}</span>
						</div>
						<div class="settings-summary-item">
							<span class="settings-summary-label">PKCE:</span>
							<span class="settings-summary-value">{requirePkce ? 'Required' : 'Optional'}</span>
						</div>
						<div class="settings-summary-item">
							<span class="settings-summary-label">Auth Method:</span>
							<span class="settings-summary-value">{tokenEndpointAuthMethod}</span>
						</div>
					</div>
				</div>

				<!-- Advanced Settings -->
				<div class="form-group">
					<button
						type="button"
						class="advanced-toggle"
						onclick={() => (showAdvanced = !showAdvanced)}
					>
						<span class="advanced-toggle-arrow" class:open={showAdvanced}>▶</span>
						Advanced Settings
					</button>

					{#if showAdvanced}
						<div class="advanced-panel">
							<!-- Grant Types -->
							<div class="form-group">
								<label class="form-label">Grant Types</label>
								<div class="checkbox-list">
									{#each [{ id: 'authorization_code', label: 'Authorization Code' }, { id: 'refresh_token', label: 'Refresh Token' }, { id: 'client_credentials', label: 'Client Credentials' }, { id: 'urn:ietf:params:oauth:grant-type:device_code', label: 'Device Code' }] as grant (grant.id)}
										<label class="checkbox-list-item">
											<input
												type="checkbox"
												checked={grantTypes.includes(grant.id)}
												onchange={() => toggleGrantType(grant.id)}
											/>
											{grant.label}
										</label>
									{/each}
								</div>
							</div>

							<!-- Response Types (with warning for implicit) -->
							{#if selectedPreset?.id === 'custom'}
								<div class="form-group">
									<label class="form-label">Response Types</label>
									<div class="warning-box">
										<p>
											⚠️ <code>token</code> and <code>id_token</code> response types use implicit
											flow. For security reasons, we recommend using <code>code</code> only unless you
											have specific requirements.
										</p>
									</div>
									<div class="checkbox-list">
										{#each [{ id: 'code', label: 'code (recommended)' }, { id: 'token', label: 'token (implicit)' }, { id: 'id_token', label: 'id_token (implicit)' }] as response (response.id)}
											<label class="checkbox-list-item">
												<input
													type="checkbox"
													checked={responseTypes.includes(response.id)}
													onchange={() => {
														if (responseTypes.includes(response.id)) {
															responseTypes = responseTypes.filter((r) => r !== response.id);
														} else {
															responseTypes = [...responseTypes, response.id];
														}
													}}
												/>
												{response.label}
											</label>
										{/each}
									</div>
								</div>
							{/if}

							<!-- PKCE -->
							{#if grantTypes.includes('authorization_code')}
								<div class="form-group">
									<ToggleSwitch
										bind:checked={requirePkce}
										label="Require PKCE"
										description="Proof Key for Code Exchange - recommended for all clients"
									/>
								</div>
							{/if}

							<!-- Scope -->
							<div class="form-group">
								<label for="scope" class="form-label">Default Scope</label>
								<input
									id="scope"
									type="text"
									class="form-input"
									bind:value={scope}
									placeholder="openid profile email"
								/>
							</div>
						</div>
					{/if}
				</div>

				<!-- Submit -->
				<div class="form-actions">
					<a href="/admin/clients" class="btn btn-secondary">Cancel</a>
					<button type="submit" class="btn btn-primary" disabled={loading}>
						{loading ? 'Creating...' : 'Create Client'}
					</button>
				</div>
			</form>
		</div>
	{:else if step === 3 && createdClient}
		<!-- Step 3: Success -->
		<div class="panel">
			<div class="success-center">
				<div class="success-icon">✅</div>
				<h2 class="success-title">Client Created Successfully</h2>
				<p class="success-description">
					Save these credentials - the client secret will only be shown once!
				</p>
			</div>

			<!-- Client ID -->
			<div class="form-group">
				<label class="form-label">Client ID</label>
				<div class="input-copy-group">
					<input type="text" value={createdClient.client_id} readonly class="input-readonly" />
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => copyToClipboard(createdClient!.client_id)}
					>
						Copy
					</button>
				</div>
			</div>

			<!-- Client Secret -->
			{#if createdClient.client_secret}
				<div class="form-group">
					<label class="form-label">Client Secret</label>
					<div class="warning-box">
						<p>⚠️ <strong>Save this secret now!</strong> It will not be shown again.</p>
					</div>
					<div class="input-copy-group">
						<input
							type="text"
							value={createdClient.client_secret}
							readonly
							class="input-readonly"
						/>
						<button
							class="btn btn-secondary btn-sm"
							onclick={() => copyToClipboard(createdClient!.client_secret!)}
						>
							Copy
						</button>
					</div>
				</div>
			{/if}

			<div class="center-actions">
				<a href="/admin/clients" class="btn btn-secondary">Back to Clients</a>
				<a
					href="/admin/clients/{encodeURIComponent(createdClient.client_id)}"
					class="btn btn-primary"
				>
					View Client Details
				</a>
			</div>
		</div>
	{/if}
</div>

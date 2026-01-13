<script lang="ts">
	import {
		adminClientsAPI,
		type Client,
		type CreateClientInput
	} from '$lib/api/admin-clients';

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
			grantTypes = grantTypes.filter(gt => gt !== grantType);
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

		const validRedirectUris = redirectUris.filter(uri => uri.trim());
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

<div style="max-width: 800px;">
	<div style="margin-bottom: 24px;">
		<a
			href="/admin/clients"
			style="color: #6b7280; text-decoration: none; font-size: 14px;"
		>
			← Back to Clients
		</a>
	</div>

	<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0 0 24px 0;">
		Create OAuth Client
	</h1>

	{#if step === 1}
		<!-- Step 1: Preset Selection -->
		<div style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
			<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 8px 0;">
				Step 1: Select Application Type
			</h2>
			<p style="color: #6b7280; font-size: 14px; margin: 0 0 24px 0;">
				Choose the type that best matches your application. This will configure optimal defaults.
			</p>

			<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px;">
				{#each PRESET_CONFIGS as preset (preset.id)}
					<button
						onclick={() => selectPreset(preset)}
						style="
							padding: 20px;
							border: 2px solid #e5e7eb;
							border-radius: 8px;
							background-color: white;
							cursor: pointer;
							text-align: left;
							transition: border-color 0.2s;
						"
						onmouseenter={(e) => e.currentTarget.style.borderColor = '#3b82f6'}
						onmouseleave={(e) => e.currentTarget.style.borderColor = '#e5e7eb'}
					>
						<div style="font-size: 32px; margin-bottom: 12px;">{preset.icon}</div>
						<div style="font-size: 16px; font-weight: 600; color: #1f2937; margin-bottom: 4px;">
							{preset.name}
						</div>
						<div style="font-size: 13px; color: #6b7280;">
							{preset.description}
						</div>
						<div style="margin-top: 8px;">
							<span style="
								display: inline-block;
								padding: 2px 8px;
								border-radius: 12px;
								font-size: 11px;
								font-weight: 500;
								background-color: {preset.clientType === 'confidential' ? '#dbeafe' : '#e0e7ff'};
								color: {preset.clientType === 'confidential' ? '#1e40af' : '#3730a3'};
							">
								{preset.clientType}
							</span>
						</div>
					</button>
				{/each}
			</div>
		</div>

	{:else if step === 2}
		<!-- Step 2: Configuration -->
		<div style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
			<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
				<div>
					<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 4px 0;">
						Step 2: Configure {selectedPreset?.name} Client
					</h2>
					<p style="color: #6b7280; font-size: 14px; margin: 0;">
						{selectedPreset?.description}
					</p>
				</div>
				<button
					onclick={() => { step = 1; selectedPreset = null; }}
					style="
						padding: 8px 16px;
						border: 1px solid #d1d5db;
						border-radius: 4px;
						background-color: white;
						color: #374151;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Change Type
				</button>
			</div>

			{#if error}
				<div style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
					{error}
				</div>
			{/if}

			<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<!-- Client Name -->
				<div style="margin-bottom: 20px;">
					<label for="clientName" style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;">
						Client Name <span style="color: #ef4444;">*</span>
					</label>
					<input
						id="clientName"
						type="text"
						bind:value={clientName}
						placeholder="My Application"
						required
						style="
							width: 100%;
							padding: 10px 12px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
							box-sizing: border-box;
						"
					/>
				</div>

				<!-- Redirect URIs -->
				{#if selectedPreset?.requiresRedirectUri}
					<div style="margin-bottom: 20px;">
						<label style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;">
							Redirect URIs <span style="color: #ef4444;">*</span>
						</label>
						<p style="color: #6b7280; font-size: 12px; margin: 0 0 8px 0;">
							The URLs where users will be redirected after authentication
						</p>
						{#each redirectUris as uri, index (index)}
							<div style="display: flex; gap: 8px; margin-bottom: 8px;">
								<input
									type="url"
									value={uri}
									oninput={(e) => updateRedirectUri(index, e.currentTarget.value)}
									placeholder="https://example.com/callback"
									style="
										flex: 1;
										padding: 10px 12px;
										border: 1px solid #d1d5db;
										border-radius: 6px;
										font-size: 14px;
									"
								/>
								{#if redirectUris.length > 1}
									<button
										type="button"
										onclick={() => removeRedirectUri(index)}
										style="
											padding: 10px 14px;
											border: 1px solid #d1d5db;
											border-radius: 6px;
											background-color: white;
											color: #6b7280;
											cursor: pointer;
											font-size: 14px;
										"
									>
										×
									</button>
								{/if}
							</div>
						{/each}
						<button
							type="button"
							onclick={addRedirectUri}
							style="
								padding: 8px 16px;
								border: 1px dashed #d1d5db;
								border-radius: 6px;
								background-color: transparent;
								color: #6b7280;
								cursor: pointer;
								font-size: 14px;
							"
						>
							+ Add Redirect URI
						</button>
					</div>
				{:else}
					<div style="margin-bottom: 20px; padding: 12px; background-color: #f3f4f6; border-radius: 6px;">
						<p style="color: #6b7280; font-size: 14px; margin: 0;">
							ℹ️ {selectedPreset?.name} clients don't require redirect URIs
						</p>
					</div>
				{/if}

				<!-- Preset-applied settings (read-only display) -->
				<div style="margin-bottom: 20px; padding: 16px; background-color: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
					<h3 style="font-size: 14px; font-weight: 600; color: #374151; margin: 0 0 12px 0;">
						Applied Settings
					</h3>
					<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
						<div>
							<span style="color: #6b7280;">Grant Types:</span>
							<span style="color: #1f2937; margin-left: 4px;">
								{grantTypes.map(gt => gt.replace('urn:ietf:params:oauth:grant-type:', '')).join(', ')}
							</span>
						</div>
						<div>
							<span style="color: #6b7280;">Client Type:</span>
							<span style="color: #1f2937; margin-left: 4px;">{selectedPreset?.clientType}</span>
						</div>
						<div>
							<span style="color: #6b7280;">PKCE:</span>
							<span style="color: #1f2937; margin-left: 4px;">{requirePkce ? 'Required' : 'Optional'}</span>
						</div>
						<div>
							<span style="color: #6b7280;">Auth Method:</span>
							<span style="color: #1f2937; margin-left: 4px;">{tokenEndpointAuthMethod}</span>
						</div>
					</div>
				</div>

				<!-- Advanced Settings (collapsed) -->
				<div style="margin-bottom: 20px;">
					<button
						type="button"
						onclick={() => showAdvanced = !showAdvanced}
						style="
							display: flex;
							align-items: center;
							gap: 8px;
							padding: 0;
							border: none;
							background: none;
							color: #6b7280;
							cursor: pointer;
							font-size: 14px;
						"
					>
						<span style="transform: rotate({showAdvanced ? 90 : 0}deg); transition: transform 0.2s;">▶</span>
						Advanced Settings
					</button>

					{#if showAdvanced}
						<div style="margin-top: 16px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 6px;">
							<!-- Grant Types -->
							<div style="margin-bottom: 16px;">
								<label style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 8px;">
									Grant Types
								</label>
								<div style="display: flex; flex-wrap: wrap; gap: 12px;">
									{#each [
										{ id: 'authorization_code', label: 'Authorization Code' },
										{ id: 'refresh_token', label: 'Refresh Token' },
										{ id: 'client_credentials', label: 'Client Credentials' },
										{ id: 'urn:ietf:params:oauth:grant-type:device_code', label: 'Device Code' }
									] as grant (grant.id)}
										<label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
											<input
												type="checkbox"
												checked={grantTypes.includes(grant.id)}
												onchange={() => toggleGrantType(grant.id)}
											/>
											<span style="font-size: 13px; color: #374151;">{grant.label}</span>
										</label>
									{/each}
								</div>
							</div>

							<!-- Response Types (with warning for implicit) -->
							{#if selectedPreset?.id === 'custom'}
								<div style="margin-bottom: 16px;">
									<label style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 8px;">
										Response Types
									</label>
									<div style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 12px; margin-bottom: 12px;">
										<p style="color: #92400e; font-size: 13px; margin: 0;">
											⚠️ <code>token</code> and <code>id_token</code> response types use implicit flow. For security reasons, we recommend using <code>code</code> only unless you have specific requirements.
										</p>
									</div>
									<div style="display: flex; flex-wrap: wrap; gap: 12px;">
										{#each [
											{ id: 'code', label: 'code (recommended)' },
											{ id: 'token', label: 'token (implicit)' },
											{ id: 'id_token', label: 'id_token (implicit)' }
										] as response (response.id)}
											<label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
												<input
													type="checkbox"
													checked={responseTypes.includes(response.id)}
													onchange={() => {
														if (responseTypes.includes(response.id)) {
															responseTypes = responseTypes.filter(r => r !== response.id);
														} else {
															responseTypes = [...responseTypes, response.id];
														}
													}}
												/>
												<span style="font-size: 13px; color: #374151;">{response.label}</span>
											</label>
										{/each}
									</div>
								</div>
							{/if}

							<!-- PKCE -->
							{#if grantTypes.includes('authorization_code')}
								<div style="margin-bottom: 16px;">
									<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
										<input
											type="checkbox"
											bind:checked={requirePkce}
										/>
										<span style="font-size: 14px; color: #374151;">Require PKCE</span>
									</label>
									<p style="color: #6b7280; font-size: 12px; margin: 4px 0 0 24px;">
										Proof Key for Code Exchange - recommended for all clients
									</p>
								</div>
							{/if}

							<!-- Scope -->
							<div>
								<label for="scope" style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;">
									Default Scope
								</label>
								<input
									id="scope"
									type="text"
									bind:value={scope}
									placeholder="openid profile email"
									style="
										width: 100%;
										padding: 10px 12px;
										border: 1px solid #d1d5db;
										border-radius: 6px;
										font-size: 14px;
										box-sizing: border-box;
									"
								/>
							</div>
						</div>
					{/if}
				</div>

				<!-- Submit -->
				<div style="display: flex; justify-content: flex-end; gap: 12px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
					<a
						href="/admin/clients"
						style="
							padding: 10px 20px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							background-color: white;
							color: #374151;
							text-decoration: none;
							font-size: 14px;
						"
					>
						Cancel
					</a>
					<button
						type="submit"
						disabled={loading}
						style="
							padding: 10px 20px;
							border: none;
							border-radius: 6px;
							background-color: {loading ? '#9ca3af' : '#3b82f6'};
							color: white;
							cursor: {loading ? 'not-allowed' : 'pointer'};
							font-size: 14px;
							font-weight: 500;
						"
					>
						{loading ? 'Creating...' : 'Create Client'}
					</button>
				</div>
			</form>
		</div>

	{:else if step === 3 && createdClient}
		<!-- Step 3: Success -->
		<div style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
			<div style="text-align: center; margin-bottom: 24px;">
				<div style="font-size: 48px; margin-bottom: 16px;">✅</div>
				<h2 style="font-size: 20px; font-weight: 600; color: #1f2937; margin: 0 0 8px 0;">
					Client Created Successfully
				</h2>
				<p style="color: #6b7280; font-size: 14px; margin: 0;">
					Save these credentials - the client secret will only be shown once!
				</p>
			</div>

			<!-- Client ID -->
			<div style="margin-bottom: 16px;">
				<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
					Client ID
				</label>
				<div style="display: flex; gap: 8px;">
					<input
						type="text"
						value={createdClient.client_id}
						readonly
						style="
							flex: 1;
							padding: 10px 12px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
							font-family: monospace;
							background-color: #f9fafb;
						"
					/>
					<button
						onclick={() => copyToClipboard(createdClient!.client_id)}
						style="
							padding: 10px 16px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							background-color: white;
							color: #374151;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Copy
					</button>
				</div>
			</div>

			<!-- Client Secret -->
			{#if createdClient.client_secret}
				<div style="margin-bottom: 24px;">
					<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
						Client Secret
					</label>
					<div style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 12px; margin-bottom: 8px;">
						<p style="color: #92400e; font-size: 13px; margin: 0;">
							⚠️ <strong>Save this secret now!</strong> It will not be shown again.
						</p>
					</div>
					<div style="display: flex; gap: 8px;">
						<input
							type="text"
							value={createdClient.client_secret}
							readonly
							style="
								flex: 1;
								padding: 10px 12px;
								border: 1px solid #d1d5db;
								border-radius: 6px;
								font-size: 14px;
								font-family: monospace;
								background-color: #f9fafb;
							"
						/>
						<button
							onclick={() => copyToClipboard(createdClient!.client_secret!)}
							style="
								padding: 10px 16px;
								border: 1px solid #d1d5db;
								border-radius: 6px;
								background-color: white;
								color: #374151;
								cursor: pointer;
								font-size: 14px;
							"
						>
							Copy
						</button>
					</div>
				</div>
			{/if}

			<div style="display: flex; justify-content: center; gap: 12px;">
				<a
					href="/admin/clients"
					style="
						padding: 10px 20px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						background-color: white;
						color: #374151;
						text-decoration: none;
						font-size: 14px;
					"
				>
					Back to Clients
				</a>
				<a
					href="/admin/clients/{encodeURIComponent(createdClient.client_id)}"
					style="
						padding: 10px 20px;
						border: none;
						border-radius: 6px;
						background-color: #3b82f6;
						color: white;
						text-decoration: none;
						font-size: 14px;
						font-weight: 500;
					"
				>
					View Client Details
				</a>
			</div>
		</div>
	{/if}
</div>

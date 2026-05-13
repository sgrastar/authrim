<script lang="ts">
	import {
		adminClientsAPI,
		type ClaimReleasePolicy,
		type ClaimsParameterPolicy,
		type Client,
		type CreateClientInput
	} from '$lib/api/admin-clients';
	import {
		createPresetClientDownstreamGrantForm,
		toClientDownstreamGrantCreateInput
	} from '$lib/admin/client-downstream-grant';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
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
		badge?: string; // Optional badge (e.g., "WebSDK")
	}

	const PRESET_CONFIGS: PresetConfig[] = [
		{
			id: 'authrim-websdk',
			name: 'Authrim WebSDK',
			description: 'Best practice config for @authrim/web SDK',
			icon: '⚡',
			clientType: 'public',
			requiresRedirectUri: true,
			defaultGrantTypes: ['authorization_code', 'refresh_token'],
			pkceRequired: true,
			badge: 'Recommended'
		},
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

	const CLAIM_RELEASE_POLICIES = new Set<ClaimReleasePolicy>([
		'scope_required',
		'claims_allowed',
		'forbidden'
	]);
	const ASC_TRANSFORMED_CLAIMS = [
		{ id: 'age_over_13', label: 'Age over 13' },
		{ id: 'age_over_18', label: 'Age over 18' },
		{ id: 'age_over_20', label: 'Age over 20' },
		{ id: 'email_domain', label: 'Email domain' },
		{ id: 'phone_country_code', label: 'Phone country code' },
		{ id: 'address_country', label: 'Address country' }
	] as const;
	const DEFAULT_CLAIMS_PARAMETER_POLICY_TEXT = [
		'email: claims_allowed',
		'email_verified: claims_allowed',
		'birthdate: claims_allowed',
		'address: claims_allowed'
	].join('\n');

	// State
	let step = $state(1);
	let selectedPreset = $state<PresetConfig | null>(null);
	let loading = $state(false);
	let error = $state('');
	let createdClient = $state<Client | null>(null);
	let showAdvanced = $state(false);

	// Form state
	let clientName = $state('');
	let clientDescription = $state('');
	let redirectUris = $state<string[]>(['']);
	let grantTypes = $state<string[]>([]);
	let responseTypes = $state<string[]>(['code']);
	let tokenEndpointAuthMethod = $state('client_secret_basic');
	let scope = $state('openid profile email');
	let requirePkce = $state(false);
	let allowClaimsWithoutScope = $state(false);
	let claimsParameterPolicyText = $state(DEFAULT_CLAIMS_PARAMETER_POLICY_TEXT);
	let ascEnabled = $state(true);
	let ascProtectedRequestRequired = $state(true);
	let ascSaoEnabled = $state(true);
	let ascTransformedClaimsEnabled = $state(true);
	let ascAllowedTransformedClaims = $state<string[]>(
		ASC_TRANSFORMED_CLAIMS.map((claim) => claim.id)
	);
	let downstreamGrantForm = $state(createPresetClientDownstreamGrantForm('custom'));

	// CORS settings
	let tenantSettings = $state<CategorySettings | null>(null);
	let allowedOrigins = $derived.by(() => {
		const originsStr = tenantSettings?.values['tenant.allowed_origins'] as string | undefined;
		if (!originsStr) return [] as string[];
		return originsStr
			.split(',')
			.map((o) => o.trim())
			.filter((o) => o.length > 0);
	});
	let addingToCors = $state<string | null>(null);

	/**
	 * Extract origin from a URL (e.g., "https://example.com/callback" -> "https://example.com")
	 */
	function extractOrigin(url: string): string {
		try {
			const parsed = new URL(url);
			return parsed.origin;
		} catch {
			return '';
		}
	}

	function buildWebOriginRegistry(uris: string[]): CreateClientInput['web_origin_registry'] {
		const origins = [
			...new Set(uris.map((uri) => extractOrigin(uri)).filter((origin) => origin.length > 0))
		];
		return {
			origins: origins.map((origin) => ({
				origin,
				cors: { allowed: true },
				handoff_allowed: true,
				iframe_allowed: false
			}))
		};
	}

	/**
	 * Check if an origin is in the CORS allowlist (with wildcard support)
	 */
	function isOriginInCors(redirectUri: string): boolean {
		const origin = extractOrigin(redirectUri);
		if (!origin) return false;

		const registryOrigins = createdClient?.web_origin_registry?.origins ?? [];
		if (registryOrigins.some((entry) => entry.origin === origin && entry.cors?.allowed !== false)) {
			return true;
		}

		for (const pattern of allowedOrigins) {
			const normalizedPattern = pattern.trim();
			const normalizedOrigin = origin.replace(/\/$/, '');

			// Exact match
			if (normalizedOrigin === normalizedPattern.replace(/\/$/, '')) {
				return true;
			}

			// Wildcard match (e.g., https://*.pages.dev)
			if (normalizedPattern.includes('*')) {
				const escaped = normalizedPattern
					.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
					.replace(/\*/g, '[a-z0-9]([a-z0-9-]*[a-z0-9])?');
				const regex = new RegExp(`^${escaped}$`, 'i');
				if (regex.test(normalizedOrigin)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Add an origin to the CORS allowlist
	 */
	async function addToCors(redirectUri: string) {
		const origin = extractOrigin(redirectUri);
		if (!origin) return;

		addingToCors = redirectUri;
		try {
			if (createdClient) {
				const existingOrigins = createdClient.web_origin_registry?.origins ?? [];
				const origins = existingOrigins.some((entry) => entry.origin === origin)
					? existingOrigins
					: [
							...existingOrigins,
							{
								origin,
								cors: { allowed: true },
								handoff_allowed: true,
								iframe_allowed: false
							}
						];
				createdClient = await adminClientsAPI.update(createdClient.client_id, {
					web_origin_registry: { origins }
				});
				return;
			}
			if (!tenantSettings) return;
			// Get current allowed_origins
			const current = (tenantSettings.values['tenant.allowed_origins'] as string) || '';
			const origins = current
				? current
						.split(',')
						.map((o) => o.trim())
						.filter((o) => o.length > 0)
				: [];

			// Add if not already present
			if (!origins.includes(origin)) {
				origins.push(origin);
				await adminSettingsAPI.updateSettings('tenant', {
					ifMatch: tenantSettings.version,
					set: { 'tenant.allowed_origins': origins.join(',') }
				});
				// Reload tenant settings
				tenantSettings = await adminSettingsAPI.getSettings('tenant');
			}
		} catch (err) {
			console.error('Failed to add to CORS:', err);
			error = err instanceof Error ? err.message : 'Failed to add to CORS';
		} finally {
			addingToCors = null;
		}
	}

	async function loadTenantSettings() {
		try {
			tenantSettings = await adminSettingsAPI.getSettings('tenant');
		} catch (err) {
			// Tenant settings may not be available, initialize with empty values
			// This allows CORS addition to work even when settings haven't been created yet
			console.warn('Failed to load tenant settings for CORS check:', err);
			tenantSettings = {
				category: 'tenant',
				version: '',
				values: {},
				sources: {}
			};
		}
	}

	function selectPreset(preset: PresetConfig) {
		selectedPreset = preset;
		grantTypes = [...preset.defaultGrantTypes];
		requirePkce = preset.pkceRequired;
		downstreamGrantForm = createPresetClientDownstreamGrantForm(preset.id);

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

	function parseClaimsParameterPolicy(text: string): ClaimsParameterPolicy | null {
		const policy: ClaimsParameterPolicy = {};
		const lines = text.split('\n');
		for (const [index, rawLine] of lines.entries()) {
			const line = rawLine.trim();
			if (!line) continue;
			const separatorIndex = line.indexOf(':');
			if (separatorIndex <= 0) {
				throw new Error(`Claims policy line ${index + 1} must use "claim: policy"`);
			}
			const claim = line.slice(0, separatorIndex).trim();
			const policyValue = line.slice(separatorIndex + 1).trim() as ClaimReleasePolicy;
			if (!claim) {
				throw new Error(`Claims policy line ${index + 1} has an empty claim name`);
			}
			if (!CLAIM_RELEASE_POLICIES.has(policyValue)) {
				throw new Error(
					`Claims policy line ${index + 1} must use scope_required, claims_allowed, or forbidden`
				);
			}
			policy[claim] = policyValue;
		}
		return Object.keys(policy).length > 0 ? policy : null;
	}

	function toggleAscAllowedTransformedClaim(claimId: string) {
		if (ascAllowedTransformedClaims.includes(claimId)) {
			ascAllowedTransformedClaims = ascAllowedTransformedClaims.filter(
				(claim) => claim !== claimId
			);
		} else {
			ascAllowedTransformedClaims = [...ascAllowedTransformedClaims, claimId];
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

		error = '';

		try {
			const claimsParameterPolicy = parseClaimsParameterPolicy(claimsParameterPolicyText);
			loading = true;

			const input: CreateClientInput = {
				client_name: clientName.trim(),
				description: clientDescription.trim() || null,
				redirect_uris: validRedirectUris,
				grant_types: grantTypes,
				response_types: responseTypes,
				token_endpoint_auth_method: tokenEndpointAuthMethod,
				scope: scope,
				require_pkce: requirePkce,
				allow_claims_without_scope: allowClaimsWithoutScope,
				claims_parameter_policy: claimsParameterPolicy,
				asc_enabled: ascEnabled,
				asc_protected_request_required: ascProtectedRequestRequired,
				asc_sao_enabled: ascSaoEnabled,
				asc_transformed_claims_enabled: ascTransformedClaimsEnabled,
				asc_allowed_transformed_claims: ascAllowedTransformedClaims,
				web_origin_registry: buildWebOriginRegistry(validRedirectUris),
				...toClientDownstreamGrantCreateInput(downstreamGrantForm)
			};

			createdClient = await adminClientsAPI.create(input);
			step = 3;
			// Load tenant settings for CORS check in success screen
			loadTenantSettings();
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
						<div class="preset-name">
							{preset.name}
							{#if preset.badge}
								<span class="preset-badge">{preset.badge}</span>
							{/if}
						</div>
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

				<div class="form-group">
					<label for="clientDescription" class="form-label">Description</label>
					<textarea
						id="clientDescription"
						class="form-input textarea-input"
						bind:value={clientDescription}
						placeholder="Internal memo for admins"
					></textarea>
					<p class="form-hint">Optional admin memo. This is not exposed as OIDC metadata.</p>
				</div>

				<!-- Redirect URIs -->
				{#if selectedPreset?.requiresRedirectUri}
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
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
								<!-- svelte-ignore a11y_label_has_associated_control -->
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
									<!-- svelte-ignore a11y_label_has_associated_control -->
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

							<div class="settings-summary settings-summary-subsection">
								<h3 class="settings-summary-title">OIDC Claims & ASC</h3>
								<div class="advanced-panel" style="padding: 0; border: none;">
									<div class="form-group">
										<ToggleSwitch
											bind:checked={allowClaimsWithoutScope}
											label="Allow Claims Without Scope"
											description="Allow approved claims requests even when the matching scope is absent"
										/>
									</div>

									<div class="form-group">
										<label class="form-label" for="claimsParameterPolicy">
											Claims Parameter Policy
										</label>
										<textarea
											id="claimsParameterPolicy"
											class="form-input textarea-input"
											rows="5"
											bind:value={claimsParameterPolicyText}
											placeholder="email: claims_allowed&#10;birthdate: claims_allowed"
										></textarea>
										<p class="form-hint">
											One claim per line. Policies: scope_required, claims_allowed, forbidden.
										</p>
									</div>

									<div class="form-grid">
										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascEnabled}
												label="Enable Advanced Syntax for Claims"
												description="Accept _asc in the claims parameter"
											/>
										</div>

										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascProtectedRequestRequired}
												label="Require Protected ASC Requests"
												description="Require PAR or JAR for ASC request processing"
											/>
										</div>

										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascSaoEnabled}
												label="Enable Selective Abort/Omit"
												description="Allow SAO rules under _asc"
											/>
										</div>

										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascTransformedClaimsEnabled}
												label="Enable Transformed Claims"
												description="Allow predefined transformed claims"
											/>
										</div>
									</div>

									<div class="form-group">
										<!-- svelte-ignore a11y_label_has_associated_control -->
										<label class="form-label">Allowed Transformed Claims</label>
										<div class="checkbox-list">
											{#each ASC_TRANSFORMED_CLAIMS as transformedClaim (transformedClaim.id)}
												<label class="checkbox-list-item">
													<input
														type="checkbox"
														checked={ascAllowedTransformedClaims.includes(transformedClaim.id)}
														onchange={() => toggleAscAllowedTransformedClaim(transformedClaim.id)}
													/>
													{transformedClaim.label}
												</label>
											{/each}
										</div>
									</div>
								</div>
							</div>

							<div class="settings-summary settings-summary-subsection">
								<h3 class="settings-summary-title">Service & Downstream Grant</h3>
								<p class="form-hint" style="margin-bottom: 12px;">
									Use these fields when this client will exchange downstream subject tokens or
									access protected product resources such as
									<code>svc://op-userinfo/customer-profile</code>.
								</p>
								<div class="advanced-panel" style="padding: 0; border: none;">
									<div class="form-group">
										<ToggleSwitch
											bind:checked={downstreamGrantForm.token_exchange_allowed}
											label="Enable Token Exchange"
											description="Allow RFC 8693 token exchange for this client"
										/>
									</div>

									<div class="form-group">
										<ToggleSwitch
											bind:checked={downstreamGrantForm.client_credentials_allowed}
											label="Allow Client Credentials"
											description="Allow this client to authenticate as a service"
										/>
									</div>

									<div class="form-group">
										<label class="form-label" for="delegationMode">Delegation Mode</label>
										<select
											id="delegationMode"
											class="form-select"
											bind:value={downstreamGrantForm.delegation_mode}
										>
											<option value="none">None</option>
											<option value="delegation">Delegation</option>
											<option value="impersonation">Impersonation</option>
										</select>
										<p class="form-hint">How downstream grants should represent the actor.</p>
									</div>

									<div class="form-grid">
										<div class="form-group">
											<label class="form-label" for="downstreamDefaultAudience">
												Default Audience
											</label>
											<input
												id="downstreamDefaultAudience"
												type="text"
												class="form-input"
												bind:value={downstreamGrantForm.default_audience}
												placeholder="svc://op-userinfo/customer-profile"
											/>
											<p class="form-hint">Audience used for exchanged downstream access tokens.</p>
										</div>

										<div class="form-group">
											<label class="form-label" for="downstreamDefaultScope">Default Scope</label>
											<input
												id="downstreamDefaultScope"
												type="text"
												class="form-input"
												bind:value={downstreamGrantForm.default_scope}
												placeholder="openid profile"
											/>
											<p class="form-hint">
												Applied when a downstream grant does not request scope.
											</p>
										</div>
									</div>

									<div class="form-group">
										<label class="form-label" for="allowedScopes">Allowed Scopes</label>
										<input
											id="allowedScopes"
											type="text"
											class="form-input"
											bind:value={downstreamGrantForm.allowed_scopes}
											placeholder="openid profile profile_export"
										/>
										<p class="form-hint">
											Space or comma separated. Leave blank to allow any scope.
										</p>
									</div>

									<div class="form-grid">
										<div class="form-group">
											<label class="form-label" for="allowedSubjectTokenClients">
												Allowed Subject Token Clients
											</label>
											<textarea
												id="allowedSubjectTokenClients"
												class="form-input textarea-input"
												rows="4"
												bind:value={downstreamGrantForm.allowed_subject_token_clients}
												placeholder="svc-client-a&#10;svc-client-b"
											></textarea>
											<p class="form-hint">
												One client ID per line. Restricts who can present subject tokens.
											</p>
										</div>

										<div class="form-group">
											<label class="form-label" for="allowedTokenExchangeResources">
												Allowed Token Exchange Resources
											</label>
											<textarea
												id="allowedTokenExchangeResources"
												class="form-input textarea-input"
												rows="4"
												bind:value={downstreamGrantForm.allowed_token_exchange_resources}
												placeholder="svc://op-userinfo/customer-profile&#10;svc://op-userinfo/customer-export"
											></textarea>
											<p class="form-hint">
												One audience/resource per line. Restricts downstream resource exchange.
											</p>
										</div>
									</div>
								</div>
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
				<!-- svelte-ignore a11y_label_has_associated_control -->
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
					<!-- svelte-ignore a11y_label_has_associated_control -->
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

			<!-- Redirect URIs with CORS Status -->
			{#if createdClient.redirect_uris.length > 0}
				<div class="form-group">
					<!-- svelte-ignore a11y_label_has_associated_control -->
					<label class="form-label">Redirect URIs - Browser Origin Status</label>
					<ul class="uri-list">
						{#each createdClient.redirect_uris as uri (uri)}
							<li class="uri-item uri-item-with-cors">
								<span class="uri-text">{uri}</span>
								{#if tenantSettings}
									{#if isOriginInCors(uri)}
										<span class="badge badge-success">Origin OK</span>
									{:else}
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => addToCors(uri)}
											disabled={addingToCors === uri}
										>
											{addingToCors === uri ? 'Adding...' : 'Add Origin'}
										</button>
									{/if}
								{:else}
									<span class="badge badge-neutral">Loading...</span>
								{/if}
							</li>
						{/each}
					</ul>
					{#if tenantSettings && createdClient.redirect_uris.some((uri) => !isOriginInCors(uri))}
						<p class="form-hint cors-hint">
							Some redirect URI origins are not in this client's web origin registry. Direct Auth
							and browser handoff calls from these origins may fail. Click "Add to CORS" to allow
							them.
						</p>
					{/if}
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

<style>
	.uri-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.uri-item-with-cors {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 0;
		border-bottom: 1px solid var(--border-color, #e5e7eb);
	}

	.uri-item-with-cors:last-child {
		border-bottom: none;
	}

	.uri-text {
		flex: 1;
		word-break: break-all;
		font-family: monospace;
		font-size: 0.875rem;
	}

	.badge-success {
		background-color: var(--success, #10b981);
		color: white;
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 500;
		white-space: nowrap;
	}

	.badge-neutral {
		background-color: var(--neutral, #9ca3af);
		color: white;
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 500;
		white-space: nowrap;
	}

	.cors-hint {
		margin-top: 8px;
		color: var(--warning, #f59e0b);
	}

	.settings-summary-subsection {
		margin-top: 1rem;
	}

	.textarea-input {
		min-height: 112px;
		resize: vertical;
	}
</style>

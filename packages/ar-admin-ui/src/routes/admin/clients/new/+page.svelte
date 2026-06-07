<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminClientsAPI,
		type ClaimReleasePolicy,
		type ClaimsParameterPolicy,
		type Client,
		type CreateClientInput
	} from '$lib/api/admin-clients';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingPolicySummary
	} from '$lib/api/admin-identity-mapping';
	import {
		createPresetClientDownstreamGrantForm,
		toClientDownstreamGrantCreateInput
	} from '$lib/admin/client-downstream-grant';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';
	import { onMount } from 'svelte';

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
		browserPublicClientMode?: 'strict' | 'cookie_fallback' | '';
		browserRefreshTokenPolicy?: 'disabled' | 'dpop_bound';
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
			browserPublicClientMode: 'strict',
			browserRefreshTokenPolicy: 'dpop_bound',
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
			pkceRequired: true,
			browserPublicClientMode: 'strict',
			browserRefreshTokenPolicy: 'dpop_bound'
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
	let browserPublicClientMode = $state<'strict' | 'cookie_fallback' | ''>('');
	let browserRefreshTokenPolicy = $state<'disabled' | 'dpop_bound'>('disabled');
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
	let identityMappingPolicySetId = $state('');
	let mappingPolicies = $state<IdentityMappingPolicySummary[]>([]);

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

	onMount(() => {
		adminIdentityMappingAPI
			.listPolicies()
			.then((result) => {
				mappingPolicies = result.policies;
			})
			.catch((err) => {
				console.warn('Failed to load identity mapping policies:', err);
			});
	});

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
			error = err instanceof Error ? err.message : $LL.admin_clients_new_add_cors_failed();
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
		browserPublicClientMode = preset.browserPublicClientMode ?? '';
		browserRefreshTokenPolicy = preset.browserRefreshTokenPolicy ?? 'disabled';

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
				throw new Error($LL.admin_clients_new_claim_policy_line_format({ line: index + 1 }));
			}
			const claim = line.slice(0, separatorIndex).trim();
			const policyValue = line.slice(separatorIndex + 1).trim() as ClaimReleasePolicy;
			if (!claim) {
				throw new Error($LL.admin_clients_new_claim_policy_empty_claim({ line: index + 1 }));
			}
			if (!CLAIM_RELEASE_POLICIES.has(policyValue)) {
				throw new Error($LL.admin_clients_new_claim_policy_invalid({ line: index + 1 }));
			}
			policy[claim] = policyValue;
		}
		return Object.keys(policy).length > 0 ? policy : null;
	}

	function presetDescription(presetId: string): string {
		switch (presetId) {
			case 'authrim-websdk':
				return $LL.admin_clients_new_preset_websdk_desc();
			case 'spa-public':
				return $LL.admin_clients_new_preset_spa_desc();
			case 'mobile-native':
				return $LL.admin_clients_new_preset_mobile_desc();
			case 'server-confidential':
				return $LL.admin_clients_new_preset_server_desc();
			case 'first-party-web':
				return $LL.admin_clients_new_preset_first_party_desc();
			case 'm2m-service':
				return $LL.admin_clients_new_preset_m2m_desc();
			case 'iot-device':
				return $LL.admin_clients_new_preset_iot_desc();
			default:
				return $LL.admin_clients_new_preset_custom_desc();
		}
	}

	function grantTypeLabel(grantType: string): string {
		switch (grantType) {
			case 'authorization_code':
				return $LL.admin_clients_new_grant_type_authorization_code();
			case 'refresh_token':
				return $LL.admin_clients_new_grant_type_refresh_token();
			case 'client_credentials':
				return $LL.admin_clients_new_grant_type_client_credentials();
			case 'urn:ietf:params:oauth:grant-type:device_code':
				return $LL.admin_clients_new_grant_type_device_code();
			default:
				return grantType;
		}
	}

	function responseTypeLabel(responseType: string): string {
		switch (responseType) {
			case 'code':
				return $LL.admin_clients_new_response_code_recommended();
			case 'token':
				return $LL.admin_clients_new_response_token_implicit();
			case 'id_token':
				return $LL.admin_clients_new_response_id_token_implicit();
			default:
				return responseType;
		}
	}

	function transformedClaimLabel(claimId: string): string {
		switch (claimId) {
			case 'age_over_13':
				return $LL.admin_clients_new_claim_age_over_13();
			case 'age_over_18':
				return $LL.admin_clients_new_claim_age_over_18();
			case 'age_over_20':
				return $LL.admin_clients_new_claim_age_over_20();
			case 'email_domain':
				return $LL.admin_clients_new_claim_email_domain();
			case 'phone_country_code':
				return $LL.admin_clients_new_claim_phone_country_code();
			case 'address_country':
				return $LL.admin_clients_new_claim_address_country();
			default:
				return claimId;
		}
	}

	function clientTypeLabel(clientType: PresetConfig['clientType'] | undefined): string {
		return clientType === 'confidential'
			? $LL.admin_clients_new_client_type_confidential()
			: $LL.admin_clients_new_client_type_public();
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
			error = $LL.admin_clients_new_client_name_error();
			return;
		}

		const validRedirectUris = redirectUris.filter((uri) => uri.trim());
		if (selectedPreset?.requiresRedirectUri && validRedirectUris.length === 0) {
			error = $LL.admin_clients_new_redirect_required_error();
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
				browser_public_client_mode: browserPublicClientMode || null,
				browser_refresh_token_policy: browserRefreshTokenPolicy,
				scope: scope,
				require_pkce: requirePkce,
				allow_claims_without_scope: allowClaimsWithoutScope,
				claims_parameter_policy: claimsParameterPolicy,
				identity_mapping: identityMappingPolicySetId
					? {
							policySetId: identityMappingPolicySetId,
							destinationNamespace: 'oidc.claim'
						}
					: null,
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
			error = err instanceof Error ? err.message : $LL.admin_clients_new_create_failed();
		} finally {
			loading = false;
		}
	}

	function copyToClipboard(text: string) {
		navigator.clipboard.writeText(text);
	}
</script>

<svelte:head>
	<title>{$LL.admin_clients_new_page_title()}</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/clients" class="back-link">← {$LL.admin_clients_new_back()}</a>

	<h1 class="page-title">{$LL.admin_clients_new_title()}</h1>

	{#if step === 1}
		<!-- Step 1: Preset Selection -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_clients_new_step1_title()}</h2>
			<p class="modal-description">
				{$LL.admin_clients_new_step1_desc()}
			</p>

			<div class="preset-grid">
				{#each PRESET_CONFIGS as preset (preset.id)}
					<button class="preset-card" onclick={() => selectPreset(preset)}>
						<div class="preset-icon">{preset.icon}</div>
						<div class="preset-name">
							{preset.name}
							{#if preset.badge}
								<span class="preset-badge">{$LL.admin_clients_new_badge_recommended()}</span>
							{/if}
						</div>
						<div class="preset-description">{presetDescription(preset.id)}</div>
						<span
							class="preset-type-badge {preset.clientType === 'confidential'
								? 'preset-type-confidential'
								: 'preset-type-public'}"
						>
							{clientTypeLabel(preset.clientType)}
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
					<h2 class="panel-title">
						{$LL.admin_clients_new_step2_title({ name: selectedPreset?.name ?? '' })}
					</h2>
					<p class="modal-description">
						{selectedPreset ? presetDescription(selectedPreset.id) : ''}
					</p>
				</div>
				<button
					class="btn btn-secondary btn-sm"
					onclick={() => {
						step = 1;
						selectedPreset = null;
					}}
				>
					{$LL.admin_clients_new_change_type()}
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
						{$LL.admin_clients_new_client_name_required()}
					</label>
					<input
						id="clientName"
						type="text"
						class="form-input"
						bind:value={clientName}
						placeholder={$LL.admin_clients_new_client_name_placeholder()}
						required
					/>
				</div>

				<div class="form-group">
					<label for="clientDescription" class="form-label">
						{$LL.admin_clients_new_description()}
					</label>
					<textarea
						id="clientDescription"
						class="form-input textarea-input"
						bind:value={clientDescription}
						placeholder={$LL.admin_clients_new_description_placeholder()}
					></textarea>
					<p class="form-hint">{$LL.admin_clients_new_description_hint()}</p>
				</div>

				<!-- Redirect URIs -->
				{#if selectedPreset?.requiresRedirectUri}
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">
							{$LL.admin_clients_new_redirect_uris_required()}
						</label>
						<p class="form-hint" style="margin-bottom: 8px;">
							{$LL.admin_clients_new_redirect_hint()}
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
							+ {$LL.admin_clients_new_add_redirect_uri()}
						</button>
					</div>
				{:else}
					<div class="info-box">
						<p>
							{$LL.admin_clients_new_no_redirect_required({
								name: selectedPreset?.name ?? ''
							})}
						</p>
					</div>
				{/if}

				<!-- Applied Settings Summary -->
				<div class="settings-summary">
					<h3 class="settings-summary-title">{$LL.admin_clients_new_applied_settings()}</h3>
					<div class="settings-summary-grid">
						<div class="settings-summary-item">
							<span class="settings-summary-label">{$LL.admin_clients_new_grant_types_label()}</span
							>
							<span class="settings-summary-value">
								{grantTypes
									.map((gt) => gt.replace('urn:ietf:params:oauth:grant-type:', ''))
									.join(', ')}
							</span>
						</div>
						<div class="settings-summary-item">
							<span class="settings-summary-label">{$LL.admin_clients_new_client_type_label()}</span
							>
							<span class="settings-summary-value"
								>{clientTypeLabel(selectedPreset?.clientType)}</span
							>
						</div>
						<div class="settings-summary-item">
							<span class="settings-summary-label">{$LL.admin_clients_new_pkce_label()}</span>
							<span class="settings-summary-value">
								{requirePkce ? $LL.admin_clients_new_required() : $LL.admin_clients_new_optional()}
							</span>
						</div>
						<div class="settings-summary-item">
							<span class="settings-summary-label">{$LL.admin_clients_new_auth_method_label()}</span
							>
							<span class="settings-summary-value">{tokenEndpointAuthMethod}</span>
						</div>
						{#if tokenEndpointAuthMethod === 'none'}
							<div class="settings-summary-item">
								<span class="settings-summary-label"
									>{$LL.admin_clients_new_browser_mode_label()}</span
								>
								<span class="settings-summary-value"
									>{browserPublicClientMode || $LL.admin_clients_new_server_default()}</span
								>
							</div>
							<div class="settings-summary-item">
								<span class="settings-summary-label">
									{$LL.admin_clients_new_browser_refresh_label()}
								</span>
								<span class="settings-summary-value">{browserRefreshTokenPolicy}</span>
							</div>
						{/if}
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
						{$LL.admin_clients_new_advanced_settings()}
					</button>

					{#if showAdvanced}
						<div class="advanced-panel">
							<!-- Grant Types -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_grantTypes()}</label>
								<div class="checkbox-list">
									{#each [{ id: 'authorization_code' }, { id: 'refresh_token' }, { id: 'client_credentials' }, { id: 'urn:ietf:params:oauth:grant-type:device_code' }] as grant (grant.id)}
										<label class="checkbox-list-item">
											<input
												type="checkbox"
												checked={grantTypes.includes(grant.id)}
												onchange={() => toggleGrantType(grant.id)}
											/>
											{grantTypeLabel(grant.id)}
										</label>
									{/each}
								</div>
							</div>

							<!-- Response Types (with warning for implicit) -->
							{#if selectedPreset?.id === 'custom'}
								<div class="form-group">
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">{$LL.admin_clients_new_response_types()}</label>
									<div class="warning-box">
										<p>
											{$LL.admin_clients_new_response_implicit_warning()}
										</p>
									</div>
									<div class="checkbox-list">
										{#each [{ id: 'code' }, { id: 'token' }, { id: 'id_token' }] as response (response.id)}
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
												{responseTypeLabel(response.id)}
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
										label={$LL.admin_clients_new_require_pkce()}
										description={$LL.admin_clients_new_require_pkce_desc()}
									/>
								</div>
							{/if}

							{#if tokenEndpointAuthMethod === 'none'}
								<div class="form-grid">
									<div class="form-group">
										<label for="browserPublicClientMode" class="form-label">
											{$LL.admin_clients_new_browser_public_mode()}
										</label>
										<select
											id="browserPublicClientMode"
											class="form-select"
											bind:value={browserPublicClientMode}
										>
											<option value="">{$LL.admin_clients_new_server_default()}</option>
											<option value="strict">{$LL.admin_clients_new_strict_dpop()}</option>
											<option value="cookie_fallback">
												{$LL.admin_clients_new_cookie_fallback()}
											</option>
										</select>
										<p class="form-hint">
											{$LL.admin_clients_new_browser_public_mode_hint()}
										</p>
									</div>
									<div class="form-group">
										<label for="browserRefreshTokenPolicy" class="form-label">
											{$LL.admin_clients_new_browser_refresh_policy()}
										</label>
										<select
											id="browserRefreshTokenPolicy"
											class="form-select"
											bind:value={browserRefreshTokenPolicy}
										>
											<option value="disabled">{$LL.admin_clients_new_disabled()}</option>
											<option value="dpop_bound">
												{$LL.admin_clients_new_dpop_refresh_tokens()}
											</option>
										</select>
										<p class="form-hint">
											{$LL.admin_clients_new_browser_refresh_hint()}
										</p>
									</div>
								</div>
							{/if}

							<!-- Scope -->
							<div class="form-group">
								<label for="scope" class="form-label">{$LL.admin_clients_new_default_scope()}</label
								>
								<input
									id="scope"
									type="text"
									class="form-input"
									bind:value={scope}
									placeholder="openid profile email"
								/>
							</div>

							<div class="settings-summary settings-summary-subsection">
								<h3 class="settings-summary-title">{$LL.admin_clients_new_oidc_claims_asc()}</h3>
								<div class="advanced-panel" style="padding: 0; border: none;">
									<div class="form-group">
										<label for="identityMappingPolicy" class="form-label">
											OIDC claims mapping policy
										</label>
										<select
											id="identityMappingPolicy"
											class="form-select"
											bind:value={identityMappingPolicySetId}
										>
											<option value="">Tenant default / no client override</option>
											{#each mappingPolicies as policy (policy.id)}
												<option value={policy.id}>
													{policy.displayName} ({policy.lifecycleState})
												</option>
											{/each}
										</select>
										<p class="form-hint">
											Selects the active identity mapping policy used for OIDC UserInfo and token
											claims for this client.
										</p>
									</div>

									<div class="form-group">
										<ToggleSwitch
											bind:checked={allowClaimsWithoutScope}
											label={$LL.admin_clients_new_allow_claims_without_scope()}
											description={$LL.admin_clients_new_allow_claims_without_scope_desc()}
										/>
									</div>

									<div class="form-group">
										<label class="form-label" for="claimsParameterPolicy">
											{$LL.admin_clients_new_claims_policy()}
										</label>
										<textarea
											id="claimsParameterPolicy"
											class="form-input textarea-input"
											rows="5"
											bind:value={claimsParameterPolicyText}
											placeholder="email: claims_allowed&#10;birthdate: claims_allowed"
										></textarea>
										<p class="form-hint">
											{$LL.admin_clients_new_claims_policy_hint()}
										</p>
									</div>

									<div class="form-grid">
										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascEnabled}
												label={$LL.admin_clients_new_enable_asc()}
												description={$LL.admin_clients_new_enable_asc_desc()}
											/>
										</div>

										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascProtectedRequestRequired}
												label={$LL.admin_clients_new_require_protected_asc()}
												description={$LL.admin_clients_new_require_protected_asc_desc()}
											/>
										</div>

										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascSaoEnabled}
												label={$LL.admin_clients_new_enable_sao()}
												description={$LL.admin_clients_new_enable_sao_desc()}
											/>
										</div>

										<div class="form-group">
											<ToggleSwitch
												bind:checked={ascTransformedClaimsEnabled}
												label={$LL.admin_clients_new_enable_transformed_claims()}
												description={$LL.admin_clients_new_enable_transformed_claims_desc()}
											/>
										</div>
									</div>

									<div class="form-group">
										<!-- svelte-ignore a11y_label_has_associated_control -->
										<label class="form-label">
											{$LL.admin_clients_new_allowed_transformed_claims()}
										</label>
										<div class="checkbox-list">
											{#each ASC_TRANSFORMED_CLAIMS as transformedClaim (transformedClaim.id)}
												<label class="checkbox-list-item">
													<input
														type="checkbox"
														checked={ascAllowedTransformedClaims.includes(transformedClaim.id)}
														onchange={() => toggleAscAllowedTransformedClaim(transformedClaim.id)}
													/>
													{transformedClaimLabel(transformedClaim.id)}
												</label>
											{/each}
										</div>
									</div>
								</div>
							</div>

							<div class="settings-summary settings-summary-subsection">
								<h3 class="settings-summary-title">
									{$LL.admin_clients_new_service_downstream_grant()}
								</h3>
								<p class="form-hint" style="margin-bottom: 12px;">
									{$LL.admin_clients_new_service_downstream_hint({
										resource: 'svc://op-userinfo/customer-profile'
									})}
								</p>
								<div class="advanced-panel" style="padding: 0; border: none;">
									<div class="form-group">
										<ToggleSwitch
											bind:checked={downstreamGrantForm.token_exchange_allowed}
											label={$LL.admin_clients_new_enable_token_exchange()}
											description={$LL.admin_clients_new_enable_token_exchange_desc()}
										/>
									</div>

									<div class="form-group">
										<ToggleSwitch
											bind:checked={downstreamGrantForm.client_credentials_allowed}
											label={$LL.admin_clients_new_allow_client_credentials()}
											description={$LL.admin_clients_new_allow_client_credentials_desc()}
										/>
									</div>

									<div class="form-group">
										<label class="form-label" for="delegationMode">
											{$LL.admin_clients_new_delegation_mode()}
										</label>
										<select
											id="delegationMode"
											class="form-select"
											bind:value={downstreamGrantForm.delegation_mode}
										>
											<option value="none">{$LL.admin_clients_new_delegation_none()}</option>
											<option value="delegation">{$LL.admin_clients_new_delegation()}</option>
											<option value="impersonation">{$LL.admin_clients_new_impersonation()}</option>
										</select>
										<p class="form-hint">{$LL.admin_clients_new_delegation_hint()}</p>
									</div>

									<div class="form-grid">
										<div class="form-group">
											<label class="form-label" for="downstreamDefaultAudience">
												{$LL.admin_clients_new_default_audience()}
											</label>
											<input
												id="downstreamDefaultAudience"
												type="text"
												class="form-input"
												bind:value={downstreamGrantForm.default_audience}
												placeholder="svc://op-userinfo/customer-profile"
											/>
											<p class="form-hint">
												{$LL.admin_clients_new_default_audience_hint()}
											</p>
										</div>

										<div class="form-group">
											<label class="form-label" for="downstreamDefaultScope">
												{$LL.admin_clients_new_default_scope()}
											</label>
											<input
												id="downstreamDefaultScope"
												type="text"
												class="form-input"
												bind:value={downstreamGrantForm.default_scope}
												placeholder="openid profile"
											/>
											<p class="form-hint">
												{$LL.admin_clients_new_default_scope_hint()}
											</p>
										</div>
									</div>

									<div class="form-group">
										<label class="form-label" for="allowedScopes">
											{$LL.admin_clients_new_allowed_scopes()}
										</label>
										<input
											id="allowedScopes"
											type="text"
											class="form-input"
											bind:value={downstreamGrantForm.allowed_scopes}
											placeholder="openid profile profile_export"
										/>
										<p class="form-hint">
											{$LL.admin_clients_new_allowed_scopes_hint()}
										</p>
									</div>

									<div class="form-grid">
										<div class="form-group">
											<label class="form-label" for="allowedSubjectTokenClients">
												{$LL.admin_clients_new_allowed_subject_token_clients()}
											</label>
											<textarea
												id="allowedSubjectTokenClients"
												class="form-input textarea-input"
												rows="4"
												bind:value={downstreamGrantForm.allowed_subject_token_clients}
												placeholder="svc-client-a&#10;svc-client-b"
											></textarea>
											<p class="form-hint">
												{$LL.admin_clients_new_allowed_subject_token_clients_hint()}
											</p>
										</div>

										<div class="form-group">
											<label class="form-label" for="allowedTokenExchangeResources">
												{$LL.admin_clients_new_allowed_token_exchange_resources()}
											</label>
											<textarea
												id="allowedTokenExchangeResources"
												class="form-input textarea-input"
												rows="4"
												bind:value={downstreamGrantForm.allowed_token_exchange_resources}
												placeholder="svc://op-userinfo/customer-profile&#10;svc://op-userinfo/customer-export"
											></textarea>
											<p class="form-hint">
												{$LL.admin_clients_new_allowed_token_exchange_resources_hint()}
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
					<a href="/admin/clients" class="btn btn-secondary">{$LL.admin_clients_new_cancel()}</a>
					<button type="submit" class="btn btn-primary" disabled={loading}>
						{loading ? $LL.admin_clients_new_creating() : $LL.admin_clients_new_create_client()}
					</button>
				</div>
			</form>
		</div>
	{:else if step === 3 && createdClient}
		<!-- Step 3: Success -->
		<div class="panel">
			<div class="success-center">
				<div class="success-icon">✅</div>
				<h2 class="success-title">{$LL.admin_clients_new_success_title()}</h2>
				<p class="success-description">
					{$LL.admin_clients_new_success_desc()}
				</p>
			</div>

			<!-- Client ID -->
			<div class="form-group">
				<!-- svelte-ignore a11y_label_has_associated_control -->
				<label class="form-label">{$LL.admin_clients_clientId()}</label>
				<div class="input-copy-group">
					<input type="text" value={createdClient.client_id} readonly class="input-readonly" />
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => copyToClipboard(createdClient!.client_id)}
					>
						{$LL.admin_clients_new_copy()}
					</button>
				</div>
			</div>

			<!-- Client Secret -->
			{#if createdClient.client_secret}
				<div class="form-group">
					<!-- svelte-ignore a11y_label_has_associated_control -->
					<label class="form-label">{$LL.admin_clients_new_client_secret()}</label>
					<div class="warning-box">
						<p>
							<strong>{$LL.admin_clients_new_secret_warning()}</strong>
							{$LL.admin_clients_new_secret_warning_desc()}
						</p>
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
							{$LL.admin_clients_new_copy()}
						</button>
					</div>
				</div>
			{/if}

			<!-- Redirect URIs with CORS Status -->
			{#if createdClient.redirect_uris.length > 0}
				<div class="form-group">
					<!-- svelte-ignore a11y_label_has_associated_control -->
					<label class="form-label">{$LL.admin_clients_new_redirect_origin_status()}</label>
					<ul class="uri-list">
						{#each createdClient.redirect_uris as uri (uri)}
							<li class="uri-item uri-item-with-cors">
								<span class="uri-text">{uri}</span>
								{#if tenantSettings}
									{#if isOriginInCors(uri)}
										<span class="badge badge-success">{$LL.admin_clients_new_origin_ok()}</span>
									{:else}
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => addToCors(uri)}
											disabled={addingToCors === uri}
										>
											{addingToCors === uri
												? $LL.admin_clients_new_adding()
												: $LL.admin_clients_new_add_origin()}
										</button>
									{/if}
								{:else}
									<span class="badge badge-neutral">{$LL.common_loading()}</span>
								{/if}
							</li>
						{/each}
					</ul>
					{#if tenantSettings && createdClient.redirect_uris.some((uri) => !isOriginInCors(uri))}
						<p class="form-hint cors-hint">
							{$LL.admin_clients_new_cors_hint()}
						</p>
					{/if}
				</div>
			{/if}

			<div class="center-actions">
				<a href="/admin/clients" class="btn btn-secondary">{$LL.admin_clients_new_back()}</a>
				<a
					href="/admin/clients/{encodeURIComponent(createdClient.client_id)}"
					class="btn btn-primary"
				>
					{$LL.admin_clients_new_view_details()}
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

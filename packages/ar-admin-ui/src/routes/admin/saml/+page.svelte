<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Modal } from '$lib/components';
	import { getTenantInfo, type TenantInfo } from '$lib/api/admin-info';
	import {
		adminSAMLAPI,
		type SAMLAttributeReleaseRule,
		type SAMLAttributePreset,
		type SAMLEntityIdStyle,
		type SAMLInteractiveLoginUrlPolicy,
		type SAMLFederationTrustProfile,
		type SAMLProvider,
		type SAMLSettings
	} from '$lib/api/admin-saml';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let providers = $state<SAMLProvider[]>([]);
	let presets = $state<SAMLAttributePreset[]>([]);
	let federationTrustProfiles = $state<SAMLFederationTrustProfile[]>([]);
	let samlSettings = $state<SAMLSettings | null>(null);
	let tenantInfo = $state<TenantInfo | null>(null);
	let tenantInfoError = $state('');
	let draftEntityIdStyle = $state<SAMLEntityIdStyle>('metadata_url');
	let loading = $state(true);
	let error = $state('');
	let actionMessage = $state('');
	let copiedKey = $state('');
	let savingSettings = $state(false);
	let draftInteractiveLoginUrlPolicy = $state<SAMLInteractiveLoginUrlPolicy>('tenant_host');
	let selectedPreset = $state<SAMLAttributePreset | null>(null);
	let showCreatePreset = $state(false);
	let creatingPreset = $state(false);
	let presetActionError = $state('');
	let customPresetLabel = $state('');
	let customPresetDescription = $state('');
	let customPresetProfile = $state('custom');
	let customPresetAttributesJson = $state(
		JSON.stringify(
			[
				{
					name: 'urn:oid:0.9.2342.19200300.100.1.3',
					friendlyName: 'mail',
					nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
					source: 'claim',
					claim: 'email',
					required: true
				}
			],
			null,
			2
		)
	);

	onMount(() => {
		void initializeAndLoadSAML();
	});

	async function initializeAndLoadSAML() {
		await settingsContext.initialize();
		await loadSAML();
	}

	async function loadSAML() {
		loading = true;
		error = '';
		tenantInfoError = '';
		try {
			const [settingsResult, providerResult, presetResult, trustProfileResult, tenantInfoResult] =
				await Promise.all([
					adminSAMLAPI.getSettings(),
					adminSAMLAPI.listProviders(),
					adminSAMLAPI.listAttributePresets(),
					adminSAMLAPI.listFederationTrustProfiles(),
					getTenantInfo().catch((err) => {
						tenantInfoError =
							err instanceof Error ? err.message : 'Failed to load SAML endpoint references';
						return null;
					})
				]);
			samlSettings = settingsResult;
			tenantInfo = tenantInfoResult;
			draftEntityIdStyle = settingsResult.entityIdStyle;
			draftInteractiveLoginUrlPolicy = settingsResult.interactiveLoginUrlPolicy;
			providers = providerResult.providers;
			presets = presetResult.presets;
			federationTrustProfiles = trustProfileResult.profiles;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load SAML data';
		} finally {
			loading = false;
		}
	}

	async function copy(text: string, key: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedKey = key;
			setTimeout(() => {
				copiedKey = '';
			}, 2000);
		} catch {
			// Clipboard access is not always available in embedded previews.
		}
	}

	const hasSAMLSettingsChanges = $derived(
		!!samlSettings &&
			(samlSettings.entityIdStyle !== draftEntityIdStyle ||
				samlSettings.interactiveLoginUrlPolicy !== draftInteractiveLoginUrlPolicy)
	);

	async function saveSAMLSettings() {
		if (!samlSettings || !hasSAMLSettingsChanges || savingSettings) return;
		savingSettings = true;
		actionMessage = '';
		error = '';
		try {
			samlSettings = await adminSAMLAPI.updateSettings({
				entityIdStyle: draftEntityIdStyle,
				interactiveLoginUrlPolicy: draftInteractiveLoginUrlPolicy
			});
			draftEntityIdStyle = samlSettings.entityIdStyle;
			draftInteractiveLoginUrlPolicy = samlSettings.interactiveLoginUrlPolicy;
			actionMessage = 'SAML settings updated';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update SAML settings';
		} finally {
			savingSettings = false;
		}
	}

	function navigateToProvider(id: string) {
		goto(`/admin/saml/${id}`);
	}

	function navigateToNew() {
		goto('/admin/saml/new');
	}

	function navigateToTrustProfileEdit(id: string) {
		goto(`/admin/saml/new?trustProfileId=${encodeURIComponent(id)}`);
	}

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'SP' : 'IdP';
	}

	function providerTypeBadge(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'badge badge-info' : 'badge badge-neutral';
	}

	function metadataStatus(provider: SAMLProvider) {
		const diff = provider.config.metadataRefreshStatus?.diff;
		if (provider.config.certificateValidation?.allExpired) return 'Expired';
		if (!provider.config.metadataUrl) return provider.config.metadataXml ? 'Uploaded' : 'Manual';
		if (!diff) return 'Not checked';
		if (diff.expired) return 'Expired';
		if (diff.changed) return 'Changed';
		return 'Current';
	}

	function metadataStatusBadge(provider: SAMLProvider) {
		const status = metadataStatus(provider);
		if (status === 'Current') return 'badge badge-success';
		if (status === 'Expired') return 'badge badge-danger';
		if (status === 'Changed') return 'badge badge-warning';
		return 'badge badge-neutral';
	}

	function providerValidUntil(provider: SAMLProvider) {
		return (
			provider.config.metadataRefreshStatus?.diff.validUntil ||
			provider.config.certificateValidation?.validUntil
		);
	}

	function providerValidUntilBadge(provider: SAMLProvider) {
		if (
			provider.config.metadataRefreshStatus?.diff.expired ||
			provider.config.certificateValidation?.allExpired
		) {
			return 'badge badge-danger';
		}
		return 'badge badge-neutral';
	}

	function buildEntityIdPreview(role: 'idp' | 'sp', style: SAMLEntityIdStyle) {
		if (!samlSettings) return '-';
		const roleUrl = `${samlSettings.generated.issuerUrl}/saml/${role}`;
		return style === 'metadata_url' ? `${roleUrl}/metadata` : roleUrl;
	}

	function entityIdStyleLabel(style: SAMLEntityIdStyle) {
		return style === 'metadata_url' ? 'Metadata URL' : 'Role URL';
	}

	function interactiveLoginPolicyLabel(policy: SAMLInteractiveLoginUrlPolicy) {
		return policy === 'tenant_host' ? 'Tenant Host' : 'UI Base URL';
	}

	function metadataSigningLabel(settings: SAMLSettings) {
		return settings.metadata.signingEnabled ? 'Signed metadata' : 'Unsigned metadata';
	}

	function metadataSigningBadge(settings: SAMLSettings) {
		return settings.metadata.signingEnabled ? 'badge badge-success' : 'badge badge-neutral';
	}

	function attributeSourceLabel(source: string | undefined) {
		switch (source) {
			case 'claim':
				return 'Authrim claim';
			case 'attribute':
				return 'Authrim attribute';
			case 'custom_claim':
				return 'Custom claim';
			case 'custom_field':
				return 'Custom field';
			case 'constant':
				return 'Constant';
			case 'computed':
				return 'Computed resolver';
			default:
				return source || 'Unspecified';
		}
	}

	function attributeSourcePath(rule: SAMLAttributeReleaseRule) {
		switch (rule.source) {
			case 'claim':
				return rule.claim ? `subject.${rule.claim}` : '-';
			case 'attribute':
				return rule.claim ? `subject.attributes.${rule.claim}` : '-';
			case 'custom_claim':
				return rule.claim ? `subject.customClaims.${rule.claim}` : '-';
			case 'custom_field':
				return rule.claim ? `subject.customFields.${rule.claim}` : '-';
			case 'constant':
				return Array.isArray(rule.value) ? rule.value.join(', ') : rule.value || '-';
			case 'computed':
				return rule.computed ? `computed.${rule.computed}` : '-';
			default:
				return rule.claim || rule.computed || '-';
		}
	}

	function attributeSourceHint(rule: SAMLAttributeReleaseRule) {
		if (rule.source === 'computed' && rule.computed === 'eduPersonScopedAffiliation') {
			return 'Uses direct eduPersonScopedAffiliation when present; otherwise combines affiliation and scope claims.';
		}
		if (rule.source === 'claim' && (rule.claim === 'sub' || rule.claim === 'user_id')) {
			return 'Alias of subject.id.';
		}
		if (rule.source === 'constant') {
			return 'Static value released to the SP.';
		}
		return '';
	}

	function formatDate(value: string | number | undefined) {
		if (!value) return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleDateString();
	}

	function formatDateTime(value: string | number | undefined) {
		if (!value) return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleString();
	}

	function trustProfilePolicy(profile: SAMLFederationTrustProfile) {
		return profile.policy ?? 'strict';
	}

	function viewPreset(preset: SAMLAttributePreset) {
		selectedPreset = preset;
	}

	function closePresetView() {
		selectedPreset = null;
	}

	function openCreatePreset() {
		presetActionError = '';
		showCreatePreset = true;
	}

	function closeCreatePreset() {
		showCreatePreset = false;
		presetActionError = '';
	}

	function parseCustomPresetRules(): SAMLAttributeReleaseRule[] {
		const parsed = JSON.parse(customPresetAttributesJson) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error('Attributes JSON must be an array');
		}
		for (const rule of parsed) {
			if (
				!rule ||
				typeof rule !== 'object' ||
				typeof (rule as SAMLAttributeReleaseRule).name !== 'string' ||
				typeof (rule as SAMLAttributeReleaseRule).source !== 'string'
			) {
				throw new Error('Each attribute rule must include name and source');
			}
		}
		return parsed as SAMLAttributeReleaseRule[];
	}

	async function createCustomPreset() {
		if (!customPresetLabel.trim()) {
			presetActionError = 'Preset name is required';
			return;
		}

		creatingPreset = true;
		presetActionError = '';
		try {
			const attributes = parseCustomPresetRules();
			const result = await adminSAMLAPI.createAttributePreset({
				label: customPresetLabel.trim(),
				description: customPresetDescription.trim() || undefined,
				profile: customPresetProfile.trim() || 'custom',
				appliesTo: 'sp_attribute_release',
				attributeReleasePolicy: { attributes }
			});
			presets = [...presets, result.preset];
			customPresetLabel = '';
			customPresetDescription = '';
			customPresetProfile = 'custom';
			showCreatePreset = false;
			actionMessage = 'Custom SP attribute release preset created';
		} catch (err) {
			presetActionError =
				err instanceof Error ? err.message : 'Failed to create SAML attribute preset';
		} finally {
			creatingPreset = false;
		}
	}

	async function deleteCustomPreset(preset: SAMLAttributePreset) {
		if (!preset.isCustom) return;
		if (!window.confirm(`Delete custom preset ${preset.label}?`)) return;
		presetActionError = '';
		try {
			await adminSAMLAPI.deleteAttributePreset(preset.id);
			presets = presets.filter((item) => item.id !== preset.id);
			if (selectedPreset?.id === preset.id) selectedPreset = null;
			actionMessage = 'Custom SP attribute release preset deleted';
		} catch (err) {
			presetActionError =
				err instanceof Error ? err.message : 'Failed to delete SAML attribute preset';
		}
	}

</script>

<svelte:head>
	<title>SAML - Admin Dashboard - Authrim</title>
</svelte:head>

{#snippet samlEndpointRow(label: string, value: string, key: string, href?: string)}
	<div class="saml-endpoint-row">
		<span class="saml-endpoint-label">{label}</span>
		<div class="saml-endpoint-value-row">
			{#if href}
				<a href={href} target="_blank" rel="noopener noreferrer" class="saml-endpoint-value">
					{value}
					<i class="i-ph-arrow-square-out"></i>
				</a>
			{:else}
				<span class="saml-endpoint-value">{value}</span>
			{/if}
			<button
				class="copy-btn"
				class:copied={copiedKey === key}
				onclick={() => copy(value, key)}
				title="Copy to clipboard"
			>
				{#if copiedKey === key}
					<i class="i-ph-check"></i>
				{:else}
					<i class="i-ph-copy"></i>
				{/if}
			</button>
		</div>
	</div>
{/snippet}

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">SAML</h1>
			<p class="page-description">
				Register external SAML IdPs for sign-in and SAML SPs that trust Authrim as their IdP.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={navigateToNew}>
				<i class="i-ph-plus"></i>
				Add Provider/Federation
			</button>
			<button class="btn btn-secondary" onclick={loadSAML} disabled={loading}>
				<i class="i-ph-arrow-clockwise"></i>
				Refresh
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if actionMessage}
		<div class="alert alert-success">{actionMessage}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else}
		{#if providers.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No SAML providers configured.</p>
				<p class="empty-state-hint">
					Add an IdP for external SAML sign-in, or add an SP that trusts Authrim as its IdP.
				</p>
				<div class="empty-actions">
					<button class="btn btn-primary" onclick={navigateToNew}>Add Provider/Federation</button>
				</div>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Type</th>
						<th>Status</th>
						<th>Metadata</th>
						<th>Entity ID</th>
						<th>Valid Until</th>
					</tr>
				</thead>
				<tbody>
					{#each providers as provider (provider.id)}
						<tr
							onclick={() => navigateToProvider(provider.id)}
							onkeydown={(event) => event.key === 'Enter' && navigateToProvider(provider.id)}
							tabindex="0"
							role="button"
						>
							<td>
								<div class="provider-cell">
									<div class="provider-icon-fallback">
										{providerTypeLabel(provider.providerType)}
									</div>
									<div>
										<div class="cell-primary">{provider.name}</div>
										{#if provider.config.description}
											<div class="cell-secondary">{provider.config.description}</div>
										{/if}
									</div>
								</div>
							</td>
							<td>
								<span class={providerTypeBadge(provider.providerType)}>
									{providerTypeLabel(provider.providerType)}
								</span>
							</td>
							<td>
								<span class={provider.enabled ? 'badge badge-success' : 'badge badge-neutral'}>
									{provider.enabled ? 'Enabled' : 'Disabled'}
								</span>
							</td>
							<td>
								<span class={metadataStatusBadge(provider)}>{metadataStatus(provider)}</span>
							</td>
							<td class="mono truncate" style="max-width: 280px;">
								{provider.config.entityId || '-'}
							</td>
							<td>
								{#if providerValidUntil(provider)}
									<span class={providerValidUntilBadge(provider)}>
										{formatDate(providerValidUntil(provider))}
									</span>
								{:else}
									-
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{/if}

		<div class="panel presets-panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">SP Attribute Release Presets</h2>
					<p class="form-hint">
						Reusable templates for attributes Authrim releases when acting as a SAML IdP for SPs.
					</p>
				</div>
				<div class="preset-header-actions">
					<span class="badge badge-neutral">{presets.length}</span>
					<button class="btn btn-secondary btn-sm" onclick={openCreatePreset}>
						<i class="i-ph-plus"></i>
						Add Custom
					</button>
				</div>
			</div>

			{#if presetActionError}
				<div class="alert alert-error">{presetActionError}</div>
			{/if}

			{#if presets.length === 0}
				<div class="empty-state compact-empty">No attribute presets available.</div>
			{:else}
				<div class="data-table-container compact-table">
					<table class="data-table">
						<thead>
							<tr>
								<th>Preset</th>
								<th>Profile</th>
								<th>Mode</th>
								<th>Stability</th>
								<th>Attributes</th>
								<th class="text-right">Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each presets as preset (preset.id)}
								<tr>
									<td>
										<div class="cell-primary">{preset.label}</div>
										<div class="cell-secondary">{preset.description}</div>
									</td>
									<td><span class="badge badge-info">{preset.profile}</span></td>
									<td>{preset.applicationMode}</td>
									<td>
										<span class={preset.isCustom ? 'badge badge-neutral' : 'badge badge-warning'}>
											{preset.isCustom ? 'custom' : preset.stability}
										</span>
									</td>
									<td>{preset.attributeReleasePolicy.attributes.length}</td>
									<td class="text-right">
										<div class="row-actions">
											<button class="btn btn-secondary btn-sm" onclick={() => viewPreset(preset)}>
												View
											</button>
											{#if preset.isCustom}
												<button
													class="btn btn-danger btn-sm"
													onclick={() => deleteCustomPreset(preset)}
												>
													Delete
												</button>
											{/if}
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<div class="panel federation-trust-panel">
			<div class="panel-header compact-panel-header">
				<div>
					<h2 class="panel-title">Federation Trust Profiles</h2>
					<p class="form-hint">
						Trust anchors used to verify signed aggregate metadata before importing federation
						entities.
					</p>
				</div>
				<div class="preset-header-actions">
					<span class="badge badge-neutral">{federationTrustProfiles.length}</span>
				</div>
			</div>

			{#if federationTrustProfiles.length === 0}
				<div class="empty-state compact-empty">
					No federation trust profiles configured.
				</div>
			{:else}
				<div class="data-table-container compact-table trust-profile-table">
					<table class="data-table">
						<thead>
							<tr>
								<th>Profile</th>
								<th>Status</th>
								<th>Policy</th>
								<th>Metadata URL Pattern</th>
								<th>Updated</th>
							</tr>
						</thead>
						<tbody>
							{#each federationTrustProfiles as profile (profile.id)}
								<tr
									onclick={() => navigateToTrustProfileEdit(profile.id)}
									onkeydown={(event) =>
										event.key === 'Enter' && navigateToTrustProfileEdit(profile.id)}
									tabindex="0"
									role="button"
								>
									<td>
										<div class="cell-primary">{profile.name}</div>
										{#if profile.description}
											<div class="cell-secondary">{profile.description}</div>
										{/if}
									</td>
									<td>
										<span class={profile.enabled ? 'badge badge-success' : 'badge badge-neutral'}>
											{profile.enabled ? 'Enabled' : 'Disabled'}
										</span>
									</td>
									<td>
										<span class="badge badge-info">{trustProfilePolicy(profile)}</span>
									</td>
									<td class="mono truncate" style="max-width: 300px;">
										{profile.metadataUrlPatterns.join(', ')}
									</td>
									<td>{formatDateTime(profile.updatedAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<div class="panel saml-endpoints-panel">
			<div class="panel-header compact-panel-header">
				<div>
					<h2 class="panel-title">SAML 2.0 Endpoint References</h2>
					<p class="form-hint">
						Tenant SAML endpoint URLs shown in Admin Info, repeated here for SAML setup work.
					</p>
				</div>
				{#if tenantInfo?.components.saml}
					<span class="badge badge-success">Deployed</span>
				{:else}
					<span class="badge badge-neutral">Not deployed</span>
				{/if}
			</div>

			{#if tenantInfoError}
				<div class="alert alert-error">{tenantInfoError}</div>
			{:else if tenantInfo?.components.saml}
				<div class="saml-endpoint-grid">
					{@render samlEndpointRow('SSO (Single Sign-On)', tenantInfo.saml.sso, 'saml_sso')}
					{@render samlEndpointRow(
						'IdP Metadata',
						tenantInfo.saml.idp_metadata,
						'saml_idp_metadata',
						tenantInfo.saml.idp_metadata
					)}
					{@render samlEndpointRow(
						'SP Metadata',
						tenantInfo.saml.sp_metadata ?? tenantInfo.saml.metadata,
						'saml_sp_metadata',
						tenantInfo.saml.sp_metadata ?? tenantInfo.saml.metadata
					)}
					{@render samlEndpointRow(
						'ACS (Assertion Consumer Service)',
						tenantInfo.saml.acs,
						'saml_acs'
					)}
					{@render samlEndpointRow('SLO (Single Logout)', tenantInfo.saml.slo, 'saml_slo')}
				</div>
			{:else}
				<div class="empty-state compact-empty">SAML worker is not deployed for this tenant.</div>
			{/if}
		</div>

		{#if samlSettings}
			<div class="panel saml-settings-panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">SAML Published Entity IDs</h2>
						<p class="form-hint">
							Tenant-wide SAML defaults used in generated metadata and interactive login redirects.
						</p>
					</div>
					<div class="metadata-publication-badges">
						<span class="badge badge-info">{entityIdStyleLabel(samlSettings.entityIdStyle)}</span>
						<span class="badge badge-info">
							Login {interactiveLoginPolicyLabel(samlSettings.interactiveLoginUrlPolicy)}
						</span>
					</div>
				</div>

				<div class="saml-login-policy">
					<div>
						<div class="preview-heading">Interactive Login Redirect</div>
						<p class="form-hint">
							Controls where SAML sends users when an SP-initiated or IdP-initiated flow needs
							interactive login. SAML defaults to tenant host so the login UI can resolve the
							tenant from the request host.
						</p>
					</div>
					<div class="entity-id-style-options" role="radiogroup" aria-label="SAML login redirect policy">
						<label class="entity-id-style-option">
							<input
								type="radio"
								name="interactiveLoginUrlPolicy"
								checked={draftInteractiveLoginUrlPolicy === 'tenant_host'}
								onchange={() => (draftInteractiveLoginUrlPolicy = 'tenant_host')}
								disabled={savingSettings}
							/>
							<span>
								<strong>Tenant Host</strong>
								<small>Use this tenant's /login URL. Default for SAML.</small>
							</span>
						</label>
						<label class="entity-id-style-option">
							<input
								type="radio"
								name="interactiveLoginUrlPolicy"
								checked={draftInteractiveLoginUrlPolicy === 'ui_base_url'}
								onchange={() => (draftInteractiveLoginUrlPolicy = 'ui_base_url')}
								disabled={savingSettings}
							/>
							<span>
								<strong>UI Base URL</strong>
								<small>Use global UI_URL /login with tenant_hint.</small>
							</span>
						</label>
					</div>
				</div>

				<div class="entity-id-settings-layout">
					<div class="entity-id-style-options" role="radiogroup" aria-label="SAML entityID style">
						<label class="entity-id-style-option">
							<input
								type="radio"
								name="entityIdStyle"
								checked={draftEntityIdStyle === 'metadata_url'}
								onchange={() => (draftEntityIdStyle = 'metadata_url')}
								disabled={savingSettings}
							/>
							<span>
								<strong>Metadata URL</strong>
								<small>/saml/idp/metadata and /saml/sp/metadata</small>
							</span>
						</label>
						<label class="entity-id-style-option">
							<input
								type="radio"
								name="entityIdStyle"
								checked={draftEntityIdStyle === 'role_url'}
								onchange={() => (draftEntityIdStyle = 'role_url')}
								disabled={savingSettings}
							/>
							<span>
								<strong>Role URL</strong>
								<small>/saml/idp and /saml/sp</small>
							</span>
						</label>
					</div>

					<div class="entity-id-current">
						<div class="entity-id-preview-group">
							<div class="preview-heading">Current entityIDs</div>
							<div class="entity-id-row">
								<span class="preview-label">IdP</span>
								<span class="mono truncate">{samlSettings.generated.idpEntityId}</span>
							</div>
							<div class="entity-id-row">
								<span class="preview-label">SP</span>
								<span class="mono truncate">{samlSettings.generated.spEntityId}</span>
							</div>
						</div>

						{#if draftEntityIdStyle !== samlSettings.entityIdStyle}
							<div class="entity-id-preview-group pending-preview">
								<div class="preview-heading">After save</div>
								<div class="entity-id-row">
									<span class="preview-label">IdP</span>
									<span class="mono truncate">{buildEntityIdPreview('idp', draftEntityIdStyle)}</span>
								</div>
								<div class="entity-id-row">
									<span class="preview-label">SP</span>
									<span class="mono truncate">{buildEntityIdPreview('sp', draftEntityIdStyle)}</span>
								</div>
							</div>
						{/if}
					</div>
				</div>

				<div class="entity-id-warning">
					<i class="i-ph-warning-circle"></i>
					<span>
						Changing published entityIDs can affect SAML trust. Existing SP/IdP configurations may
						need updated metadata, audience settings, issuer settings, and certificate validation
						review before the change is used in production.
					</span>
				</div>

				<div class="metadata-publication-summary">
					<div class="metadata-publication-header">
						<div>
							<div class="preview-heading">SAML Metadata Publication</div>
							<p class="form-hint">
								Generated IdP/SP metadata currently publishes validity dates. XML signature is
								opt-in for strict environments.
							</p>
						</div>
						<div class="metadata-publication-badges">
							<span class={metadataSigningBadge(samlSettings)}>
								{metadataSigningLabel(samlSettings)}
							</span>
							<span
								class={samlSettings.metadata.validUntilEnabled
									? 'badge badge-success'
									: 'badge badge-neutral'}
							>
								validUntil {samlSettings.metadata.validUntilEnabled ? 'Enabled' : 'Disabled'}
							</span>
						</div>
					</div>

					<div class="metadata-publication-grid">
						<div>
							<span class="preview-label">IdP validUntil</span>
							<strong>{formatDateTime(samlSettings.metadata.idpValidUntil)}</strong>
						</div>
						<div>
							<span class="preview-label">SP validUntil</span>
							<strong>{formatDateTime(samlSettings.metadata.spValidUntil)}</strong>
						</div>
						<div>
							<span class="preview-label">Validity window</span>
							<strong>{samlSettings.metadata.validityDays} days</strong>
						</div>
						<div>
							<span class="preview-label">cacheDuration</span>
							<strong>{samlSettings.metadata.cacheDuration}</strong>
						</div>
					</div>
				</div>

				<div class="form-actions compact-actions">
					<button
						class="btn btn-primary btn-sm"
						onclick={saveSAMLSettings}
						disabled={savingSettings || !hasSAMLSettingsChanges}
					>
						{savingSettings ? 'Saving...' : 'Save SAML Settings'}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<Modal
	open={!!selectedPreset}
	onClose={closePresetView}
	title={selectedPreset?.label || 'SP Attribute Release Preset'}
	size="xl"
>
	{#if selectedPreset}
		<div class="preset-summary">
			<span class="badge badge-info">{selectedPreset.profile}</span>
			<span class="badge badge-neutral">{selectedPreset.appliesTo}</span>
			<span class={selectedPreset.isCustom ? 'badge badge-neutral' : 'badge badge-warning'}>
				{selectedPreset.isCustom ? 'custom' : selectedPreset.stability}
			</span>
		</div>
		<p class="modal-description">{selectedPreset.description}</p>
		<div class="mapping-context">
			<div>
				<span class="mapping-label">Direction</span>
				<strong>Authrim user data -> SAML AttributeStatement</strong>
			</div>
			<p>
				This preset controls outbound attribute release to SAML SPs. User import mapping for
				SAML, SCIM, or CSV will be handled by a separate mapping workflow.
			</p>
		</div>

		<div class="data-table-container preset-rules-table">
			<table class="data-table">
				<thead>
					<tr>
						<th>SAML Attribute</th>
						<th>Authrim Mapping</th>
						<th>Name Format</th>
						<th>Required</th>
					</tr>
				</thead>
				<tbody>
					{#each selectedPreset.attributeReleasePolicy.attributes as rule, index (`${rule.name}-${rule.source || ''}-${index}`)}
						<tr>
							<td>
								<div class="cell-primary">{rule.friendlyName || rule.name}</div>
								<div class="cell-secondary mono">{rule.name}</div>
							</td>
							<td>
								<div class="mapping-cell">
									<span class="badge badge-neutral">{attributeSourceLabel(rule.source)}</span>
									<span class="mono mapping-path">{attributeSourcePath(rule)}</span>
								</div>
								{#if attributeSourceHint(rule)}
									<div class="cell-secondary">{attributeSourceHint(rule)}</div>
								{/if}
							</td>
							<td class="mono truncate" style="max-width: 280px;">{rule.nameFormat || '-'}</td>
							<td>{rule.required ? 'Yes' : 'No'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</Modal>

<Modal
	open={showCreatePreset}
	onClose={closeCreatePreset}
	title="Create Custom SP Attribute Release Preset"
	size="xl"
>
	{#if presetActionError}
		<div class="alert alert-error">{presetActionError}</div>
	{/if}

	<div class="form-grid">
		<div class="form-group">
			<label for="customPresetLabel" class="form-label">Preset Name *</label>
			<input id="customPresetLabel" bind:value={customPresetLabel} class="form-input" />
		</div>
		<div class="form-group">
			<label for="customPresetProfile" class="form-label">Profile</label>
			<input id="customPresetProfile" bind:value={customPresetProfile} class="form-input" />
		</div>
		<div class="form-group form-group-full">
			<label for="customPresetDescription" class="form-label">Description</label>
			<textarea
				id="customPresetDescription"
				bind:value={customPresetDescription}
				class="form-input form-textarea"
				rows="3"
			></textarea>
		</div>
		<div class="form-group form-group-full">
			<label for="customPresetAttributes" class="form-label">Attribute Rules JSON *</label>
			<textarea
				id="customPresetAttributes"
				bind:value={customPresetAttributesJson}
				class="form-input form-textarea monospace"
				rows="14"
			></textarea>
			<p class="form-hint">
				Enter an array of SAML attribute release rules. Each rule needs at least name and source.
			</p>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreatePreset} disabled={creatingPreset}>
			Cancel
		</button>
		<button class="btn btn-primary" onclick={createCustomPreset} disabled={creatingPreset}>
			{creatingPreset ? 'Creating...' : 'Create Preset'}
		</button>
	{/snippet}
</Modal>

<style>
	.provider-cell {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.provider-icon-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-md);
		background: var(--primary-light);
		color: var(--primary);
		font-size: 0.75rem;
		font-weight: 700;
		flex: 0 0 auto;
	}

	.cell-primary {
		font-weight: 600;
		color: var(--text-primary);
	}

	.cell-secondary {
		margin-top: 2px;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		max-width: 420px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-actions,
	.empty-actions,
	.preset-header-actions,
	.preset-summary {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;
	}

	.presets-panel,
	.saml-settings-panel,
	.saml-endpoints-panel,
	.federation-trust-panel {
		margin-top: 16px;
	}

	.compact-panel-header {
		align-items: flex-start;
	}

	.saml-login-policy {
		display: grid;
		grid-template-columns: minmax(240px, 1fr) minmax(240px, 360px);
		gap: 20px;
		margin-top: 16px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--border-color);
	}

	.entity-id-settings-layout {
		display: grid;
		grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
		gap: 20px;
		margin-top: 16px;
		align-items: start;
	}

	.entity-id-style-options {
		display: grid;
		gap: 8px;
	}

	.entity-id-style-option {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr);
		gap: 10px;
		align-items: flex-start;
		padding: 10px 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
		cursor: pointer;
	}

	.entity-id-style-option input {
		margin-top: 2px;
	}

	.entity-id-style-option strong,
	.entity-id-style-option small {
		display: block;
	}

	.entity-id-style-option strong {
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.entity-id-style-option small {
		margin-top: 2px;
		color: var(--text-secondary);
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.entity-id-current {
		display: grid;
		gap: 10px;
		min-width: 0;
	}

	.entity-id-preview-group {
		display: grid;
		gap: 6px;
		padding: 10px 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
		min-width: 0;
	}

	.pending-preview {
		border-color: rgba(245, 158, 11, 0.45);
		background: rgba(245, 158, 11, 0.08);
	}

	.preview-heading {
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.entity-id-row {
		display: grid;
		grid-template-columns: 120px minmax(0, 1fr);
		gap: 10px;
		align-items: center;
	}

	.preview-label {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.entity-id-warning {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		margin-top: 12px;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.entity-id-warning i {
		margin-top: 2px;
		color: var(--warning);
		flex: 0 0 auto;
	}

	.metadata-publication-summary {
		display: grid;
		gap: 12px;
		margin-top: 14px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	.metadata-publication-header {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: flex-start;
	}

	.metadata-publication-badges {
		display: inline-flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		flex: 0 0 auto;
	}

	.metadata-publication-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
	}

	.metadata-publication-grid > div {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.metadata-publication-grid strong {
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.saml-endpoint-grid {
		display: grid;
		gap: 2px;
		margin-top: 16px;
	}

	.saml-endpoint-row {
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr);
		gap: 12px;
		align-items: center;
		padding: 7px 0;
		border-bottom: 1px solid var(--border-color);
	}

	.saml-endpoint-row:last-child {
		border-bottom: 0;
	}

	.saml-endpoint-label {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.saml-endpoint-value-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.saml-endpoint-value {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		flex: 1;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-decoration: none;
	}

	a.saml-endpoint-value {
		color: var(--primary);
	}

	a.saml-endpoint-value:hover {
		text-decoration: underline;
	}

	.copy-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		flex: 0 0 auto;
	}

	.copy-btn:hover {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.copy-btn.copied {
		border-color: var(--success);
		color: var(--success);
	}

	.compact-actions {
		justify-content: flex-end;
	}

	.compact-table {
		border-radius: var(--radius-md);
	}

	.compact-empty {
		padding: 24px;
	}

	.preset-rules-table {
		margin-top: 16px;
	}

	.mapping-context {
		display: grid;
		gap: 6px;
		margin-top: 12px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	.mapping-context > div {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.mapping-context p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.mapping-label {
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.mapping-cell {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		flex-wrap: wrap;
	}

	.mapping-path {
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.form-textarea {
		min-height: auto;
		resize: vertical;
		line-height: 1.45;
	}

	.monospace {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	@media (max-width: 900px) {
		.data-table-container {
			overflow-x: auto;
		}

		.data-table {
			min-width: 920px;
		}

		.entity-id-settings-layout,
		.saml-login-policy,
		.entity-id-row,
		.saml-endpoint-row,
		.metadata-publication-grid {
			grid-template-columns: 1fr;
		}

		.metadata-publication-header {
			display: grid;
		}

		.metadata-publication-badges {
			justify-content: flex-start;
		}
	}
</style>

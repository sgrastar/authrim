<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Modal } from '$lib/components';
	import {
		adminSAMLAPI,
		type SAMLAttributeReleaseRule,
		type SAMLAttributePreset,
		type SAMLFederationTrustProfile,
		type SAMLProvider
	} from '$lib/api/admin-saml';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let providers = $state<SAMLProvider[]>([]);
	let presets = $state<SAMLAttributePreset[]>([]);
	let federationTrustProfiles = $state<SAMLFederationTrustProfile[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actionMessage = $state('');
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
		try {
			const [providerResult, presetResult, trustProfileResult] = await Promise.all([
				adminSAMLAPI.listProviders(),
				adminSAMLAPI.listAttributePresets(),
				adminSAMLAPI.listFederationTrustProfiles()
			]);
			providers = providerResult.providers;
			presets = presetResult.presets;
			federationTrustProfiles = trustProfileResult.profiles;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load SAML data';
		} finally {
			loading = false;
		}
	}

	function navigateToProvider(id: string) {
		goto(`/admin/saml/${id}`);
	}

	function navigateToLocalMetadata() {
		goto('/admin/saml/local');
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

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">SAML</h1>
			<p class="page-description">
				Register external SAML IdPs for sign-in and SAML SPs that trust Authrim as their IdP.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={navigateToLocalMetadata}>
				<i class="i-ph-identification-card"></i>
				SAML Entity Info
			</button>
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
				<div class="empty-state compact-empty">No federation trust profiles configured.</div>
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
				This preset controls outbound attribute release to SAML SPs. User import mapping for SAML,
				SCIM, or CSV will be handled by a separate mapping workflow.
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
	.federation-trust-panel {
		margin-top: 16px;
	}

	.compact-panel-header {
		align-items: flex-start;
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
	}
</style>

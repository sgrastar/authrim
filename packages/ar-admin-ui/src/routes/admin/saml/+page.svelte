<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Modal } from '$lib/components';
	import {
		adminSAMLAPI,
		type SAMLFederationTrustProfile,
		type SAMLAttributeReleaseRule,
		type SAMLAttributePreset,
		type SAMLProvider,
		type SAMLProviderConfig
	} from '$lib/api/admin-saml';

	let providers = $state<SAMLProvider[]>([]);
	let presets = $state<SAMLAttributePreset[]>([]);
	let trustProfiles = $state<SAMLFederationTrustProfile[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actionMessage = $state('');
	let busyProviderId = $state<string | null>(null);
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
	let trustProfileName = $state('');
	let trustProfilePatterns = $state('https://metadata.gakunin.nii.ac.jp/*');
	let trustProfileCertificate = $state('');
	let creatingTrustProfile = $state(false);

	onMount(() => {
		void loadSAML();
	});

	async function loadSAML() {
		loading = true;
		error = '';
		try {
			const [providerResult, presetResult] = await Promise.all([
				adminSAMLAPI.listProviders(),
				adminSAMLAPI.listAttributePresets()
			]);
			providers = providerResult.providers;
			presets = presetResult.presets;
			try {
				trustProfiles = (await adminSAMLAPI.listFederationTrustProfiles()).profiles;
			} catch {
				trustProfiles = [];
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load SAML data';
		} finally {
			loading = false;
		}
	}

	async function refreshMetadata(provider: SAMLProvider, event?: Event) {
		event?.stopPropagation();
		busyProviderId = provider.id;
		actionMessage = '';
		error = '';
		try {
			const result = await adminSAMLAPI.refreshMetadata(provider.id);
			updateProviderConfig(provider.id, result.config);
			actionMessage = result.expired
				? `${provider.name}: metadata is expired`
				: `${provider.name}: metadata ${result.changed ? 'changed' : 'unchanged'}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to refresh metadata';
		} finally {
			busyProviderId = null;
		}
	}

	async function promoteNext(provider: SAMLProvider, event?: Event) {
		event?.stopPropagation();
		busyProviderId = provider.id;
		actionMessage = '';
		error = '';
		try {
			const result = await adminSAMLAPI.promoteSigningNext(provider.id);
			updateProviderConfig(provider.id, result.config);
			actionMessage = `${provider.name}: next certificate promoted`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to promote next certificate';
		} finally {
			busyProviderId = null;
		}
	}

	async function retireBackup(provider: SAMLProvider, event?: Event) {
		event?.stopPropagation();
		busyProviderId = provider.id;
		actionMessage = '';
		error = '';
		try {
			const result = await adminSAMLAPI.retireSigningBackup(provider.id);
			updateProviderConfig(provider.id, result.config);
			actionMessage = `${provider.name}: backup certificate retired`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to retire backup certificate';
		} finally {
			busyProviderId = null;
		}
	}

	function updateProviderConfig(providerId: string, config: SAMLProviderConfig) {
		providers = providers.map((provider) =>
			provider.id === providerId ? { ...provider, config } : provider
		);
	}

	function navigateToProvider(id: string) {
		goto(`/admin/saml/${id}`);
	}

	function navigateToNew() {
		goto('/admin/saml/new');
	}

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'SP' : 'IdP';
	}

	function providerTypeBadge(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'badge badge-info' : 'badge badge-neutral';
	}

	function metadataStatus(provider: SAMLProvider) {
		const diff = provider.config.metadataRefreshStatus?.diff;
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

	function signingSummary(provider: SAMLProvider) {
		const policy = provider.config.signingKeyPolicy;
		if (!policy?.active && !policy?.next && !policy?.backup) return 'None';
		const states = [];
		if (policy.active) states.push('active');
		if (policy.next) states.push('next');
		if (policy.backup) states.push('backup');
		return states.join(' / ');
	}

	function formatDate(value: string | number | undefined) {
		if (!value) return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleDateString();
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

	async function createTrustProfile() {
		if (!trustProfileName.trim() || !trustProfileCertificate.trim()) {
			error = 'Trust profile name and certificate are required';
			return;
		}
		creatingTrustProfile = true;
		error = '';
		try {
			const profile = await adminSAMLAPI.createFederationTrustProfile({
				name: trustProfileName.trim(),
				metadataUrlPatterns: trustProfilePatterns
					.split('\n')
					.map((item) => item.trim())
					.filter(Boolean),
				certificates: [{ certificate: trustProfileCertificate.trim() }],
				enabled: true
			});
			trustProfiles = [...trustProfiles, profile];
			trustProfileName = '';
			trustProfileCertificate = '';
			actionMessage = 'Federation trust profile created';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create federation trust profile';
		} finally {
			creatingTrustProfile = false;
		}
	}

	async function deleteTrustProfile(profile: SAMLFederationTrustProfile) {
		if (!window.confirm(`Delete federation trust profile ${profile.name}?`)) return;
		try {
			await adminSAMLAPI.deleteFederationTrustProfile(profile.id);
			trustProfiles = trustProfiles.filter((item) => item.id !== profile.id);
			actionMessage = 'Federation trust profile deleted';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete federation trust profile';
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
			<button class="btn btn-primary" onclick={navigateToNew}>
				<i class="i-ph-plus"></i>
				Add Provider
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
	{:else if providers.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No SAML providers configured.</p>
				<p class="empty-state-hint">
					Add an IdP for external SAML sign-in, or add an SP that trusts Authrim as its IdP.
				</p>
				<div class="empty-actions">
					<button class="btn btn-primary" onclick={navigateToNew}>Add Provider</button>
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
						<th>Signing</th>
						<th class="text-right">Actions</th>
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
							<td>{formatDate(provider.config.metadataRefreshStatus?.diff.validUntil)}</td>
							<td class="muted">{signingSummary(provider)}</td>
							<td class="text-right" onclick={(event) => event.stopPropagation()}>
								<div class="row-actions">
									<button
										class="btn btn-secondary btn-sm"
										onclick={(event) => refreshMetadata(provider, event)}
										disabled={!provider.config.metadataUrl || busyProviderId === provider.id}
									>
										Metadata
									</button>
									<button
										class="btn btn-secondary btn-sm"
										onclick={(event) => promoteNext(provider, event)}
										disabled={!provider.config.signingKeyPolicy?.next ||
											busyProviderId === provider.id}
									>
										Promote
									</button>
									<button
										class="btn btn-secondary btn-sm"
										onclick={(event) => retireBackup(provider, event)}
										disabled={!provider.config.signingKeyPolicy?.backup ||
											busyProviderId === provider.id}
									>
										Retire
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
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

		<div class="panel trust-profiles-panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">Federation Trust Profiles</h2>
					<p class="form-hint">
						Trust anchors for signed aggregate metadata imports, scoped by metadata URL pattern.
					</p>
				</div>
				<span class="badge badge-neutral">{trustProfiles.length}</span>
			</div>

			<div class="trust-profile-layout">
				<div class="trust-profile-form">
					<div class="form-group">
						<label for="trustProfileName" class="form-label">Name *</label>
						<input
							id="trustProfileName"
							bind:value={trustProfileName}
							class="form-input"
							placeholder="GakuNin Test Federation"
						/>
					</div>
					<div class="form-group">
						<label for="trustProfilePatterns" class="form-label">Metadata URL Patterns *</label>
						<textarea
							id="trustProfilePatterns"
							bind:value={trustProfilePatterns}
							class="form-input form-textarea monospace"
							rows="3"
						></textarea>
					</div>
					<div class="form-group">
						<label for="trustProfileCertificate" class="form-label">Signing Certificate PEM *</label>
						<textarea
							id="trustProfileCertificate"
							bind:value={trustProfileCertificate}
							class="form-input form-textarea monospace"
							rows="6"
							placeholder="-----BEGIN CERTIFICATE-----"
						></textarea>
					</div>
					<div class="form-actions compact-actions">
						<button
							class="btn btn-primary btn-sm"
							onclick={createTrustProfile}
							disabled={creatingTrustProfile}
						>
							<i class="i-ph-shield-check"></i>
							{creatingTrustProfile ? 'Creating...' : 'Add Trust Profile'}
						</button>
					</div>
				</div>

				{#if trustProfiles.length === 0}
					<div class="empty-state compact-empty">No federation trust profiles configured.</div>
				{:else}
					<div class="trust-profile-list">
						{#each trustProfiles as profile (profile.id)}
							<div class="trust-profile-item">
								<div class="trust-profile-main">
									<div class="cell-primary">{profile.name}</div>
									<div class="cell-secondary">{profile.metadataUrlPatterns.join(', ')}</div>
									<div class="trust-profile-meta">
										<span class={profile.enabled ? 'badge badge-success' : 'badge badge-neutral'}>
											{profile.enabled ? 'Enabled' : 'Disabled'}
										</span>
										<span class="badge badge-info">{profile.policy || 'environment policy'}</span>
										{#if profile.certificates[0]?.fingerprintSha256}
											<span class="mono fingerprint">
												{profile.certificates[0].fingerprintSha256}
											</span>
										{/if}
									</div>
								</div>
								<button class="btn btn-danger btn-sm" onclick={() => deleteTrustProfile(profile)}>
									Delete
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
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

		<div class="data-table-container preset-rules-table">
			<table class="data-table">
				<thead>
					<tr>
						<th>Attribute Name</th>
						<th>Friendly Name</th>
						<th>Source</th>
						<th>Claim / Resolver</th>
						<th>Required</th>
					</tr>
				</thead>
				<tbody>
					{#each selectedPreset.attributeReleasePolicy.attributes as rule, index (`${rule.name}-${rule.source || ''}-${index}`)}
						<tr>
							<td class="mono truncate" style="max-width: 320px;">{rule.name}</td>
							<td>{rule.friendlyName || '-'}</td>
							<td><span class="badge badge-neutral">{rule.source}</span></td>
							<td>{rule.claim || rule.computed || '-'}</td>
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

	.trust-profiles-panel,
	.presets-panel {
		margin-top: 16px;
	}

	.trust-profile-layout {
		display: grid;
		grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
		gap: 16px;
		align-items: start;
	}

	.trust-profile-form {
		display: grid;
		gap: 12px;
	}

	.trust-profile-list {
		display: grid;
		gap: 10px;
	}

	.trust-profile-item {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	.trust-profile-main {
		min-width: 0;
	}

	.trust-profile-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
	}

	.fingerprint {
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.compact-actions {
		justify-content: flex-start;
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
		.trust-profile-layout {
			grid-template-columns: 1fr;
		}

		.data-table-container {
			overflow-x: auto;
		}

		.data-table {
			min-width: 920px;
		}
	}
</style>

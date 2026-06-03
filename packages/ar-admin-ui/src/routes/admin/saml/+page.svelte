<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type SAMLFederationTrustProfile,
		type SAMLProvider
	} from '$lib/api/admin-saml';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let providers = $state<SAMLProvider[]>([]);
	let federationTrustProfiles = $state<SAMLFederationTrustProfile[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actionMessage = $state('');

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
			const [providerResult, trustProfileResult] = await Promise.all([
				adminSAMLAPI.listProviders(),
				adminSAMLAPI.listFederationTrustProfiles()
			]);
			providers = providerResult.providers;
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
				<div class="panel-header-actions">
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

	{/if}
</div>

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
	.panel-header-actions {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;
	}

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

	@media (max-width: 900px) {
		.data-table-container {
			overflow-x: auto;
		}

		.data-table {
			min-width: 920px;
		}
	}
</style>

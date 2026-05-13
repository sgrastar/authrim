<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type SAMLAttributePreset,
		type SAMLProvider,
		type SAMLProviderConfig
	} from '$lib/api/admin-saml';

	let providers = $state<SAMLProvider[]>([]);
	let presets = $state<SAMLAttributePreset[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actionMessage = $state('');
	let busyProviderId = $state<string | null>(null);

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
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load SAML operations data';
		} finally {
			loading = false;
		}
	}

	async function refreshMetadata(provider: SAMLProvider) {
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

	async function promoteNext(provider: SAMLProvider) {
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

	async function retireBackup(provider: SAMLProvider) {
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

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'Service Provider' : 'Identity Provider';
	}

	function metadataStatus(provider: SAMLProvider) {
		const diff = provider.config.metadataRefreshStatus?.diff;
		if (!provider.config.metadataUrl) return 'local';
		if (!diff) return 'not checked';
		if (diff.expired) return 'expired';
		if (diff.changed) return 'changed';
		return 'current';
	}

	function statusClass(status: string) {
		if (status === 'expired') return 'danger';
		if (status === 'changed') return 'warn';
		if (status === 'current') return 'ok';
		return 'muted';
	}

	function formatDate(value: string | number | undefined) {
		if (!value) return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleString();
	}

	function formatExpiry(seconds: number | undefined) {
		if (typeof seconds !== 'number') return '-';
		const days = Math.floor(seconds / 86400);
		if (days >= 1) return `${days}d`;
		const hours = Math.floor(seconds / 3600);
		return `${hours}h`;
	}
</script>

<svelte:head>
	<title>SAML - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="page-container">
	<div class="page-header">
		<div>
			<h1 class="page-title">SAML</h1>
		</div>
		<button class="btn btn-secondary" onclick={loadSAML} disabled={loading}>
			<i class="i-ph-arrow-clockwise"></i>
			Refresh
		</button>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if actionMessage}
		<div class="alert alert-success">{actionMessage}</div>
	{/if}

	{#if loading}
		<div class="loading-state">Loading SAML operations...</div>
	{:else}
		<section class="section">
			<div class="section-header">
				<h2>Providers</h2>
				<span class="count">{providers.length}</span>
			</div>

			{#if providers.length === 0}
				<div class="empty-state">No SAML providers found.</div>
			{:else}
				<div class="provider-grid">
					{#each providers as provider (provider.id)}
						<article class="provider-card">
							<div class="provider-top">
								<div>
									<h3>{provider.name}</h3>
									<p>{provider.config.entityId || '-'}</p>
								</div>
								<div class="badges">
									<span class="badge">{providerTypeLabel(provider.providerType)}</span>
									<span class="badge" class:disabled={!provider.enabled}>
										{provider.enabled ? 'enabled' : 'disabled'}
									</span>
								</div>
							</div>

							<div class="details">
								<div>
									<span>Metadata</span>
									<strong class={statusClass(metadataStatus(provider))}>
										{metadataStatus(provider)}
									</strong>
								</div>
								<div>
									<span>Valid until</span>
									<strong>{formatDate(provider.config.metadataRefreshStatus?.diff.validUntil)}</strong>
								</div>
								<div>
									<span>Expires in</span>
									<strong>{formatExpiry(provider.config.metadataRefreshStatus?.diff.expiresInSeconds)}</strong>
								</div>
								<div>
									<span>Last checked</span>
									<strong>{formatDate(provider.config.metadataRefreshStatus?.lastCheckedAt)}</strong>
								</div>
							</div>

							{#if provider.providerType === 'saml_sp'}
								<div class="attribute-summary">
									<span>
										Requested attributes:
										<strong>{provider.config.metadataRequestedAttributes?.length ?? 0}</strong>
									</span>
									<span>
										Release suggestions:
										<strong>
											{provider.config.metadataAttributeReleasePolicySuggestion?.attributes.length ?? 0}
										</strong>
									</span>
								</div>
							{/if}

							<div class="key-row">
								<span>Signing</span>
								<div class="badges">
									<span class="badge" class:disabled={!provider.config.signingKeyPolicy?.active}>
										active
									</span>
									<span class="badge" class:disabled={!provider.config.signingKeyPolicy?.next}>
										next
									</span>
									<span class="badge" class:disabled={!provider.config.signingKeyPolicy?.backup}>
										backup
									</span>
								</div>
							</div>

							<div class="actions">
								<button
									class="btn btn-secondary"
									onclick={() => refreshMetadata(provider)}
									disabled={!provider.config.metadataUrl || busyProviderId === provider.id}
								>
									<i class="i-ph-arrows-clockwise"></i>
									Metadata
								</button>
								<button
									class="btn btn-secondary"
									onclick={() => promoteNext(provider)}
									disabled={!provider.config.signingKeyPolicy?.next || busyProviderId === provider.id}
								>
									<i class="i-ph-arrow-up"></i>
									Promote
								</button>
								<button
									class="btn btn-secondary"
									onclick={() => retireBackup(provider)}
									disabled={!provider.config.signingKeyPolicy?.backup || busyProviderId === provider.id}
								>
									<i class="i-ph-trash"></i>
									Retire
								</button>
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</section>

		<section class="section">
			<div class="section-header">
				<h2>Attribute Presets</h2>
				<span class="count">{presets.length}</span>
			</div>

			<div class="preset-grid">
				{#each presets as preset (preset.id)}
					<article class="preset-card">
						<div class="preset-top">
							<h3>{preset.label}</h3>
							<span class="badge">{preset.profile}</span>
						</div>
						<p>{preset.description}</p>
						<div class="attribute-summary">
							<span>
								Attributes:
								<strong>{preset.attributeReleasePolicy.attributes.length}</strong>
							</span>
							<span>
								Mode:
								<strong>{preset.applicationMode}</strong>
							</span>
							<span>
								Stability:
								<strong>{preset.stability}</strong>
							</span>
						</div>
					</article>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.page-container {
		padding: 24px;
		max-width: 1280px;
		margin: 0 auto;
	}

	.page-header,
	.section-header,
	.provider-top,
	.preset-top,
	.key-row,
	.actions,
	.badges,
	.attribute-summary {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.page-header,
	.section-header,
	.provider-top,
	.preset-top,
	.key-row {
		justify-content: space-between;
	}

	.page-title {
		margin: 0;
		font-size: 28px;
		font-weight: 700;
		color: var(--text-primary);
	}

	.section {
		margin-top: 24px;
	}

	.section-header h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 650;
		color: var(--text-primary);
	}

	.count,
	.badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 3px 8px;
		border-radius: 6px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
	}

	.badge.disabled {
		opacity: 0.45;
	}

	.provider-grid,
	.preset-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 16px;
		margin-top: 14px;
	}

	.provider-card,
	.preset-card {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		padding: 16px;
		background: var(--bg-primary);
	}

	.provider-card h3,
	.preset-card h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
		color: var(--text-primary);
	}

	.provider-card p,
	.preset-card p {
		margin: 4px 0 0;
		color: var(--text-secondary);
		font-size: 13px;
		overflow-wrap: anywhere;
	}

	.details {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin-top: 16px;
	}

	.details div {
		display: grid;
		gap: 3px;
	}

	.details span,
	.key-row span,
	.attribute-summary span {
		color: var(--text-secondary);
		font-size: 12px;
	}

	.details strong,
	.attribute-summary strong {
		color: var(--text-primary);
		font-size: 13px;
		font-weight: 650;
	}

	.ok {
		color: #047857 !important;
	}

	.warn {
		color: #a16207 !important;
	}

	.danger {
		color: #b91c1c !important;
	}

	.muted {
		color: var(--text-secondary) !important;
	}

	.attribute-summary {
		flex-wrap: wrap;
		margin-top: 14px;
	}

	.key-row,
	.actions {
		margin-top: 14px;
	}

	.actions {
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border-radius: 6px;
		border: 1px solid var(--border-color);
		padding: 8px 12px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.btn-secondary {
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.alert,
	.loading-state,
	.empty-state {
		margin-top: 16px;
		border-radius: 8px;
		padding: 12px 14px;
		font-size: 14px;
	}

	.alert-error {
		background: #fef2f2;
		color: #991b1b;
		border: 1px solid #fecaca;
	}

	.alert-success {
		background: #ecfdf5;
		color: #065f46;
		border: 1px solid #a7f3d0;
	}

	.loading-state,
	.empty-state {
		color: var(--text-secondary);
		background: var(--bg-secondary);
	}

	@media (max-width: 720px) {
		.page-container {
			padding: 16px;
		}

		.page-header,
		.provider-top,
		.preset-top,
		.key-row {
			align-items: flex-start;
			flex-direction: column;
		}

		.provider-grid,
		.preset-grid {
			grid-template-columns: 1fr;
		}

		.details {
			grid-template-columns: 1fr;
		}
	}
</style>

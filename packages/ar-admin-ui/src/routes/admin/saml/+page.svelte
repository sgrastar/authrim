<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type SAMLFederationTrustProfile,
		type SAMLProvider
	} from '$lib/api/admin-saml';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';

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
			error = err instanceof Error ? err.message : $LL.admin_saml_error_load();
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
		return type === 'saml_sp'
			? $LL.admin_saml_provider_type_sp()
			: $LL.admin_saml_provider_type_idp();
	}

	function providerTypeBadge(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'badge badge-info' : 'badge badge-neutral';
	}

	function metadataStatus(provider: SAMLProvider) {
		const diff = provider.config.metadataRefreshStatus?.diff;
		if (provider.config.certificateValidation?.allExpired) return $LL.admin_saml_metadata_expired();
		if (!provider.config.metadataUrl) {
			return provider.config.metadataXml
				? $LL.admin_saml_metadata_uploaded()
				: $LL.admin_saml_metadata_manual();
		}
		if (!diff) return $LL.admin_saml_metadata_not_checked();
		if (diff.expired) return $LL.admin_saml_metadata_expired();
		if (diff.changed) return $LL.admin_saml_metadata_changed();
		return $LL.admin_saml_metadata_current();
	}

	function metadataStatusBadge(provider: SAMLProvider) {
		const status = metadataStatus(provider);
		if (status === $LL.admin_saml_metadata_current()) return 'badge badge-success';
		if (status === $LL.admin_saml_metadata_expired()) return 'badge badge-danger';
		if (status === $LL.admin_saml_metadata_changed()) return 'badge badge-warning';
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
		return date.toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function formatDateTime(value: string | number | undefined) {
		if (!value) return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function trustProfilePolicy(profile: SAMLFederationTrustProfile) {
		return profile.policy ?? 'strict';
	}
</script>

<svelte:head>
	<title>{$LL.admin_saml_page_title()}</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_saml_title()}</h1>
			<p class="page-description">
				{$LL.admin_saml_description()}
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={navigateToLocalMetadata}>
				<i class="i-ph-identification-card"></i>
				{$LL.admin_saml_entity_info()}
			</button>
			<button class="btn btn-primary" onclick={navigateToNew}>
				<i class="i-ph-plus"></i>
				{$LL.admin_saml_add_provider_federation()}
			</button>
			<button class="btn btn-secondary" onclick={loadSAML} disabled={loading}>
				<i class="i-ph-arrow-clockwise"></i>
				{$LL.admin_saml_refresh()}
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
			<p>{$LL.admin_saml_loading()}</p>
		</div>
	{:else}
		{#if providers.length === 0}
			<div class="panel">
				<div class="empty-state">
					<p class="empty-state-description">{$LL.admin_saml_empty_providers()}</p>
					<p class="empty-state-hint">
						{$LL.admin_saml_empty_hint()}
					</p>
					<div class="empty-actions">
						<button class="btn btn-primary" onclick={navigateToNew}>
							{$LL.admin_saml_add_provider_federation()}
						</button>
					</div>
				</div>
			</div>
		{:else}
			<div class="data-table-container">
				<table class="data-table">
					<thead>
						<tr>
							<th>{$LL.admin_saml_name()}</th>
							<th>{$LL.admin_saml_type()}</th>
							<th>{$LL.admin_saml_status()}</th>
							<th>{$LL.admin_saml_metadata()}</th>
							<th>{$LL.admin_saml_entity_id()}</th>
							<th>{$LL.admin_saml_valid_until()}</th>
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
										{provider.enabled ? $LL.admin_saml_enabled() : $LL.admin_saml_disabled()}
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
					<h2 class="panel-title">{$LL.admin_saml_federation_trust_profiles()}</h2>
					<p class="form-hint">
						{$LL.admin_saml_federation_trust_desc()}
					</p>
				</div>
				<div class="panel-header-actions">
					<span class="badge badge-neutral">{federationTrustProfiles.length}</span>
				</div>
			</div>

			{#if federationTrustProfiles.length === 0}
				<div class="empty-state compact-empty">
					{$LL.admin_saml_empty_federation_trust_profiles()}
				</div>
			{:else}
				<div class="data-table-container compact-table trust-profile-table">
					<table class="data-table">
						<thead>
							<tr>
								<th>{$LL.admin_saml_profile()}</th>
								<th>{$LL.admin_saml_status()}</th>
								<th>{$LL.admin_saml_policy()}</th>
								<th>{$LL.admin_saml_metadata_url_pattern()}</th>
								<th>{$LL.admin_saml_updated()}</th>
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
											{profile.enabled ? $LL.admin_saml_enabled() : $LL.admin_saml_disabled()}
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

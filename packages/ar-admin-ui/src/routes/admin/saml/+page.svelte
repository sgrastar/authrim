<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type SAMLFederationTrustProfile,
		type SAMLProvider
	} from '$lib/api/admin-saml';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	let providers = $state<SAMLProvider[]>([]);
	let federationTrustProfiles = $state<SAMLFederationTrustProfile[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actionMessage = $state('');
	let refreshingFederationSourceId = $state('');

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

	async function refreshFederationSource(profile: SAMLFederationTrustProfile) {
		refreshingFederationSourceId = profile.id;
		error = '';
		actionMessage = '';
		try {
			const result = await adminSAMLAPI.refreshFederationMetadataSource(profile.id);
			actionMessage = $LL.admin_saml_federation_refresh_complete({
				entities: result.entityCount,
				updated: result.providersUpdated,
				missing: result.providersMissing,
				failed: result.providersFailed
			});
			await loadSAML();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_metadata_refresh_failed();
		} finally {
			refreshingFederationSourceId = '';
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_saml_page_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<div class="saml-page-actions">
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
{/snippet}

{#snippet trustProfileActions()}
	<span class="badge badge-neutral">{federationTrustProfiles.length}</span>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_saml_title()}
		description={$LL.admin_saml_description()}
		actions={pageActions}
	/>

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
			<AdminSection>
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
			</AdminSection>
		{:else}
			<AdminSection>
				<AdminDataTable width="wide">
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
								data-clickable="true"
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
								<td class="mono admin-data-table__truncate">
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
				</AdminDataTable>
			</AdminSection>
		{/if}

		<AdminSection
			title={$LL.admin_saml_federation_trust_profiles()}
			description={$LL.admin_saml_federation_trust_desc()}
			actions={trustProfileActions}
		>
			{#if federationTrustProfiles.length === 0}
				<div class="empty-state compact-empty">
					{$LL.admin_saml_empty_federation_trust_profiles()}
				</div>
			{:else}
				<AdminDataTable compact width="wide">
					<thead>
						<tr>
							<th>{$LL.admin_saml_profile()}</th>
							<th>{$LL.admin_saml_status()}</th>
							<th>{$LL.admin_saml_policy()}</th>
							<th>{$LL.admin_saml_metadata_source_url()}</th>
							<th>{$LL.admin_saml_metadata_polling()}</th>
							<th>{$LL.admin_saml_updated()}</th>
							<th>{$LL.admin_saml_actions()}</th>
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
								data-clickable="true"
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
								<td class="mono admin-data-table__truncate trust-profile-url-cell">
									{profile.metadataUrl || '-'}
									<div class="cell-secondary">
										{$LL.admin_saml_metadata_url_pattern()}:
										{profile.metadataUrlPatterns.join(', ')}
									</div>
								</td>
								<td>
									<span
										class={profile.polling?.mode === 'manual'
											? 'badge badge-neutral'
											: 'badge badge-success'}
									>
										{profile.polling?.mode === 'manual'
											? $LL.admin_saml_metadata_manual_mode()
											: $LL.admin_saml_metadata_automatic_mode()}
									</span>
									<div class="cell-secondary">
										{$LL.admin_saml_metadata_last_success()}:
										{formatDateTime(profile.polling?.lastSuccessAt)}
									</div>
									{#if profile.polling?.lastErrorCode}
										<div class="form-error">
											{$LL.admin_saml_metadata_last_error()}:
											{profile.polling.lastErrorCode}
										</div>
									{/if}
								</td>
								<td>{formatDateTime(profile.updatedAt)}</td>
								<td>
									<button
										type="button"
										class="btn btn-secondary btn-sm"
										onclick={(event) => {
											event.stopPropagation();
											void refreshFederationSource(profile);
										}}
										disabled={!profile.metadataUrl || refreshingFederationSourceId === profile.id}
									>
										{refreshingFederationSourceId === profile.id
											? $LL.admin_saml_metadata_refreshing()
											: $LL.admin_saml_metadata_refresh_now()}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.saml-page-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
		flex-wrap: wrap;
	}

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
		background: var(--color-accent-muted);
		color: var(--color-accent);
		font-size: 0.75rem;
		font-weight: 700;
		flex: 0 0 auto;
	}

	.cell-primary {
		font-weight: 600;
		color: var(--color-text);
	}

	.cell-secondary {
		margin-top: 2px;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		max-width: min(420px, 42vw);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty-actions {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.compact-empty {
		padding: 24px;
	}

	.trust-profile-url-cell {
		--truncate-max-width: 300px;
	}
</style>

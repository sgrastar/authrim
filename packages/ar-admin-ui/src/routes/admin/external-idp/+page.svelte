<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminExternalProvidersAPI,
		type ExternalIdPProvider,
		PROVIDER_TEMPLATES
	} from '$lib/api/admin-external-providers';
	import { Modal } from '$lib/components';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

	let providers: ExternalIdPProvider[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let providerToDelete: ExternalIdPProvider | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	async function loadProviders() {
		loading = true;
		error = '';

		try {
			const response = await adminExternalProvidersAPI.list();
			providers = response.providers;
		} catch (err) {
			console.error('Failed to load external IdP providers:', err);
			error = $LL.admin_external_idp_error_load();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadProviders();
	});

	function navigateToProvider(id: string) {
		goto(`/admin/external-idp/${id}`);
	}

	function navigateToNew() {
		goto('/admin/external-idp/new');
	}

	function openDeleteDialog(provider: ExternalIdPProvider, event: Event) {
		event.stopPropagation();
		providerToDelete = provider;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		providerToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!providerToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminExternalProvidersAPI.delete(providerToDelete.id);
			showDeleteDialog = false;
			providerToDelete = null;
			await loadProviders();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_external_idp_error_delete();
		} finally {
			deleting = false;
		}
	}

	function getTemplateInfo(slug: string | undefined): string {
		if (!slug) return '';
		const template = PROVIDER_TEMPLATES.find((t) => t.id === slug);
		return template?.name || '';
	}
</script>

<svelte:head>
	<title>{$LL.admin_external_idp_page_title()}</title>
</svelte:head>

{#snippet headerActions()}
	<button class="btn btn-primary" onclick={navigateToNew}>
		<i class="i-ph-plus"></i>
		{$LL.admin_external_idp_add_provider()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_external_idp_title()}
		description={$LL.admin_external_idp_description()}
		actions={headerActions}
	/>
	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_external_idp_loading()}</p>
		</div>
	{:else if providers.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_external_idp_empty()}</p>
				<p class="empty-state-hint">
					{$LL.admin_external_idp_empty_hint()}
				</p>
				<button class="btn btn-primary" onclick={navigateToNew}
					>{$LL.admin_external_idp_add_first()}</button
				>
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_external_idp_name()}</th>
						<th>{$LL.admin_external_idp_type()}</th>
						<th>{$LL.admin_users_status()}</th>
						<th>{$LL.admin_external_idp_priority()}</th>
						<th>{$LL.admin_external_idp_client_id()}</th>
						<th class="text-right">{$LL.admin_users_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each providers as provider (provider.id)}
						<tr
							onclick={() => navigateToProvider(provider.id)}
							onkeydown={(e) => e.key === 'Enter' && navigateToProvider(provider.id)}
							tabindex="0"
							role="button"
						>
							<td>
								<div class="provider-cell">
									{#if provider.iconUrl}
										<img src={provider.iconUrl} alt="" class="provider-icon" />
									{/if}
									<div>
										<div class="cell-primary">{provider.name}</div>
										{#if provider.slug}
											<div class="cell-secondary">
												{getTemplateInfo(provider.slug) || provider.slug}
											</div>
										{/if}
									</div>
								</div>
							</td>
							<td>
								<span
									class={provider.providerType === 'oidc'
										? 'badge badge-info'
										: 'badge badge-neutral'}
								>
									{provider.providerType.toUpperCase()}
								</span>
							</td>
							<td>
								<span class={provider.enabled ? 'badge badge-success' : 'badge badge-neutral'}>
									{provider.enabled ? $LL.admin_saml_enabled() : $LL.admin_saml_disabled()}
								</span>
							</td>
							<td>{provider.priority}</td>
							<td class="mono truncate client-id-cell">
								{provider.clientId}
							</td>
							<td class="text-right" onclick={(e) => e.stopPropagation()}>
								<button
									class="btn btn-danger btn-sm"
									onclick={(e) => openDeleteDialog(provider, e)}
								>
									{$LL.admin_users_delete()}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

<!-- Delete Confirmation Dialog -->
<Modal
	open={showDeleteDialog && !!providerToDelete}
	onClose={closeDeleteDialog}
	title={$LL.admin_external_idp_delete_title()}
	size="md"
>
	{#if providerToDelete}
		{#if deleteError}
			<div class="alert alert-error">{deleteError}</div>
		{/if}

		<p class="modal-description">
			{$LL.admin_external_idp_delete_desc()}
		</p>

		<div class="info-box">
			<div class="info-row">
				<span class="info-label">{$LL.admin_external_idp_provider()}</span>
				<span class="info-value">{providerToDelete.name}</span>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_external_idp_type()}:</span>
				<span class="info-value">{providerToDelete.providerType.toUpperCase()}</span>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_external_idp_client_id()}:</span>
				<code class="info-value">{providerToDelete.clientId}</code>
			</div>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
			{$LL.dialog_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_users_deleting() : $LL.admin_external_idp_delete_provider()}
		</button>
	{/snippet}
</Modal>

<style>
	:global(.admin-data-table-wrap tr[role='button']) {
		cursor: pointer;
	}

	.client-id-cell {
		max-width: 220px;
	}
</style>

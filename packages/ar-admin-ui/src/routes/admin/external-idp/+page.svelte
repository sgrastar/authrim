<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminExternalProvidersAPI,
		type ExternalIdPProvider,
		PROVIDER_TEMPLATES
	} from '$lib/api/admin-external-providers';

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
			error = 'Failed to load external IdP providers';
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
			deleteError = err instanceof Error ? err.message : 'Failed to delete provider';
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
	<title>External IdP - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">External Identity Providers</h1>
			<p class="page-description">
				Configure external identity providers for social login and enterprise SSO (Google, GitHub,
				Microsoft, etc.)
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={navigateToNew}>
				<i class="i-ph-plus"></i>
				Add Provider
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if providers.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No external identity providers configured.</p>
				<p class="empty-state-hint">
					Add a provider to enable social login or enterprise SSO for your users.
				</p>
				<button class="btn btn-primary" onclick={navigateToNew}>Add Your First Provider</button>
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
						<th>Priority</th>
						<th>Client ID</th>
						<th class="text-right">Actions</th>
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
									{provider.enabled ? 'Enabled' : 'Disabled'}
								</span>
							</td>
							<td>{provider.priority}</td>
							<td class="mono truncate" style="max-width: 200px;">
								{provider.clientId}
							</td>
							<td class="text-right" onclick={(e) => e.stopPropagation()}>
								<button
									class="btn btn-danger btn-sm"
									onclick={(e) => openDeleteDialog(provider, e)}
								>
									Delete
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && providerToDelete}
	<div
		class="modal-overlay"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Delete External IdP Provider</h2>
			</div>

			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to delete this external IdP provider? This action cannot be undone
					and users will no longer be able to sign in with this provider.
				</p>

				<div class="info-box">
					<div class="info-row">
						<span class="info-label">Provider:</span>
						<span class="info-value">{providerToDelete.name}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Type:</span>
						<span class="info-value">{providerToDelete.providerType.toUpperCase()}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Client ID:</span>
						<code class="info-value">{providerToDelete.clientId}</code>
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete Provider'}
				</button>
			</div>
		</div>
	</div>
{/if}

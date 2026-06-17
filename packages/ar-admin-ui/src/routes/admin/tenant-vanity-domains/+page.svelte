<script lang="ts">
	import { onMount } from 'svelte';
	import {
		platformTenantVanityDomainsAPI,
		type TenantVanityDomain
	} from '$lib/api/admin-tenant-vanity-domains';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminToolbar
	} from '$lib/components/admin';
	import { tenantStore } from '$lib/stores/tenants.svelte';

	let domains = $state<TenantVanityDomain[]>([]);
	let cloudflareConfigured = $state(false);
	let tenantFilter = $state('');
	let loading = $state(true);
	let error = $state('');
	let success = $state('');
	let syncingId = $state<string | null>(null);
	let verifyingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let accessReady = $state(false);

	const singleTenantMode = $derived(tenantStore.singleTenantMode);

	async function loadDomains() {
		loading = true;
		error = '';
		try {
			const response = await platformTenantVanityDomainsAPI.list(tenantFilter.trim() || undefined);
			domains = response.domains;
			cloudflareConfigured = response.cloudflare_configured;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load vanity domains';
		} finally {
			loading = false;
		}
	}

	async function handleSync(id: string) {
		syncingId = id;
		error = '';
		success = '';
		try {
			await platformTenantVanityDomainsAPI.sync(id);
			success = 'Cloudflare status refreshed.';
			await loadDomains();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to refresh vanity domain';
		} finally {
			syncingId = null;
		}
	}

	async function handleVerify(id: string) {
		verifyingId = id;
		error = '';
		success = '';
		try {
			await platformTenantVanityDomainsAPI.verify(id);
			success = 'Vanity domain marked as verified.';
			await loadDomains();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to verify vanity domain';
		} finally {
			verifyingId = null;
		}
	}

	async function handleDelete(id: string) {
		deletingId = id;
		error = '';
		success = '';
		try {
			await platformTenantVanityDomainsAPI.delete(id);
			success = 'Vanity domain deleted.';
			await loadDomains();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete vanity domain';
		} finally {
			deletingId = null;
		}
	}

	onMount(async () => {
		if (!tenantStore.loaded) {
			await tenantStore.load();
		}

		accessReady = true;

		if (tenantStore.singleTenantMode) {
			loading = false;
			return;
		}

		await loadDomains();
	});
</script>

<svelte:head>
	<title>Tenant Vanity Domains — Admin Dashboard</title>
</svelte:head>

{#snippet headerActions()}
	<button class="btn btn-secondary" onclick={loadDomains} disabled={loading || singleTenantMode}>
		{#if loading}
			<i class="i-ph-circle-notch animate-spin"></i>
		{/if}
		Refresh
	</button>
{/snippet}

{#if accessReady}
	<AdminPageShell>
		<AdminPageHeader
			title="Tenant Vanity Domains"
			description={singleTenantMode
				? 'Available after enabling multi-tenant mode. Use this page to manage cross-tenant vanity domains.'
				: 'Cross-tenant vanity domain status and Cloudflare refresh controls.'}
			actions={headerActions}
		/>

		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if success}
			<div class="alert alert-success">{success}</div>
		{/if}
		{#if singleTenantMode}
			<div class="alert alert-info">
				Enable multi-tenant mode in Setup to add and manage vanity domains. You can start from
				`workers.dev`, add an API custom domain later, and then switch this deployment to
				multi-tenant mode.
			</div>
		{:else if !cloudflareConfigured}
			<div class="alert alert-warning">
				Cloudflare automation is not configured. Domains can still be tracked, but Custom Hostname
				creation and sync require manual Cloudflare setup.
			</div>
		{/if}

		<AdminSection>
			<AdminToolbar>
				<div class="admin-field admin-field--search">
					<label class="admin-field__label" for="tenant-filter">Tenant filter</label>
					<input
						id="tenant-filter"
						class="admin-input"
						type="text"
						bind:value={tenantFilter}
						placeholder="Filter by tenant ID"
						disabled={singleTenantMode}
					/>
				</div>
				<button class="btn btn-primary" onclick={loadDomains} disabled={singleTenantMode}
					>Apply</button
				>
			</AdminToolbar>

			{#if singleTenantMode}
				<p class="empty-text">
					Vanity domains are disabled while this deployment is running in single-tenant mode.
				</p>
			{:else if loading}
				<div class="loading-state"><i class="i-ph-circle-notch animate-spin"></i> Loading...</div>
			{:else if domains.length === 0}
				<p class="empty-text">No vanity domains found.</p>
			{:else}
				<AdminDataTable width="xwide">
					<thead>
						<tr>
							<th>Hostname</th>
							<th>Tenant</th>
							<th>Status</th>
							<th>SSL</th>
							<th>Primary</th>
							<th>Last Sync</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each domains as domain (domain.id)}
							<tr>
								<td class="mono">{domain.hostname}</td>
								<td class="mono">{domain.tenant_id}</td>
								<td>{domain.status}</td>
								<td>{domain.ssl_status ?? 'pending'}</td>
								<td>{domain.is_primary ? 'Yes' : 'No'}</td>
								<td>
									{domain.last_sync_at
										? new Date(domain.last_sync_at * 1000).toLocaleString()
										: 'Never'}
								</td>
								<td>
									<div class="actions">
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => handleSync(domain.id)}
											disabled={syncingId === domain.id}
										>
											Sync
										</button>
										{#if domain.status !== 'active'}
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => handleVerify(domain.id)}
												disabled={verifyingId === domain.id}
											>
												Verify
											</button>
										{/if}
										<button
											class="btn btn-danger btn-sm"
											onclick={() => handleDelete(domain.id)}
											disabled={deletingId === domain.id}
										>
											Delete
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{/if}
		</AdminSection>
	</AdminPageShell>
{/if}

<style>
	.empty-text {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.mono {
		font-family: var(--font-meta, var(--font-mono));
		font-size: 0.8125rem;
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	.loading-state {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}
</style>

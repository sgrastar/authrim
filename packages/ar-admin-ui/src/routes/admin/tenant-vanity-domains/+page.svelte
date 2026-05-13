<script lang="ts">
	import { onMount } from 'svelte';
	import {
		platformTenantVanityDomainsAPI,
		type TenantVanityDomain
	} from '$lib/api/admin-tenant-vanity-domains';
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

{#if accessReady}
<div class="page">
	<div class="page-header">
		<div>
			<h1>Tenant Vanity Domains</h1>
			<p>
				{#if singleTenantMode}
					Available after enabling multi-tenant mode. Use this page to manage cross-tenant vanity domains.
				{:else}
					Cross-tenant vanity domain status and Cloudflare refresh controls.
				{/if}
			</p>
		</div>
		<button
			class="btn btn-secondary"
			onclick={loadDomains}
			disabled={loading || singleTenantMode}
		>
			{#if loading}
				<i class="i-ph-circle-notch animate-spin"></i>
			{/if}
			Refresh
		</button>
	</div>

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

	<section class="card">
		<div class="filter-row">
			<input
				class="form-input"
				type="text"
				bind:value={tenantFilter}
				placeholder="Filter by tenant ID"
				disabled={singleTenantMode}
			/>
			<button class="btn btn-primary" onclick={loadDomains} disabled={singleTenantMode}>Apply</button>
		</div>

		{#if singleTenantMode}
			<p class="empty-text">
				Vanity domains are disabled while this deployment is running in single-tenant mode.
			</p>
		{:else if loading}
			<div class="loading-state"><i class="i-ph-circle-notch animate-spin"></i> Loading...</div>
		{:else if domains.length === 0}
			<p class="empty-text">No vanity domains found.</p>
		{:else}
			<div class="table-wrap">
				<table>
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
											class="btn btn-secondary"
											onclick={() => handleSync(domain.id)}
											disabled={syncingId === domain.id}
										>
											Sync
										</button>
										{#if domain.status !== 'active'}
											<button
												class="btn btn-secondary"
												onclick={() => handleVerify(domain.id)}
												disabled={verifyingId === domain.id}
											>
												Verify
											</button>
										{/if}
										<button
											class="btn btn-danger-outline"
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
				</table>
			</div>
		{/if}
	</section>
</div>
{/if}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 1100px;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	h1 {
		margin: 0 0 4px;
		font-size: 1.5rem;
		color: var(--text-primary);
	}

	.page-header p,
	.empty-text {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 20px;
	}

	.filter-row {
		display: flex;
		gap: 12px;
		margin-bottom: 16px;
	}

	.form-input {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.table-wrap {
		overflow: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	th,
	td {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border-subtle, var(--border));
		text-align: left;
		white-space: nowrap;
	}

	th {
		color: var(--text-secondary);
		font-weight: 600;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px;
		border: none;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		text-decoration: none;
	}

	.btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.btn-primary {
		background: var(--primary);
		color: white;
	}

	.btn-secondary {
		background: var(--bg-subtle);
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.btn-danger-outline {
		background: transparent;
		color: var(--danger);
		border: 1px solid var(--danger);
	}

	.alert {
		padding: 12px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
	}

	.alert-error {
		background: var(--danger-subtle);
		color: var(--danger);
		border: 1px solid var(--danger-border);
	}

	.alert-warning {
		background: var(--warning-subtle);
		color: var(--warning-dark);
		border: 1px solid var(--warning-border);
	}

	.alert-success {
		background: var(--success-subtle);
		color: var(--success);
		border: 1px solid color-mix(in srgb, var(--success) 30%, var(--border));
	}

	.loading-state {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}
</style>

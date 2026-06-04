<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { LL } from '$i18n/i18n-svelte';

	// ==========================================================================
	// State
	// ==========================================================================

	let tenants = $derived(tenantStore.tenants);
	let singleTenantMode = $derived(tenantStore.singleTenantMode);
	let singleTenantReason = $derived(tenantStore.singleTenantReason);
	let tenantD1Pool = $derived(tenantStore.tenantD1Pool);
	let loading = $state(!tenantStore.loaded);
	let error = $state('');

	// ==========================================================================
	// Data Loading
	// ==========================================================================

	onMount(async () => {
		if (!tenantStore.loaded) {
			loading = true;
			error = '';
			try {
				await tenantStore.reload();
			} catch (err) {
				error = err instanceof Error ? err.message : $LL.admin_tenants_load_failed();
			} finally {
				loading = false;
			}
		} else {
			loading = false;
		}
	});

	function lifecycleLabel(state: string): string {
		switch (state) {
			case 'active':
				return $LL.admin_tenants_active();
			case 'suspended':
				return $LL.admin_tenants_suspended();
			case 'frozen':
				return $LL.admin_tenants_frozen();
			case 'migration_read_only':
				return $LL.admin_tenants_migration_read_only();
			case 'provisioning':
				return $LL.admin_tenants_provisioning();
			case 'deleting':
				return $LL.admin_tenants_deleting();
			case 'deleted':
				return $LL.admin_tenants_deleted();
			case 'restore_pending':
				return $LL.admin_tenants_restore_pending();
			case 'restore_validating':
				return $LL.admin_tenants_restore_validating();
			default:
				return state;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_tenants_head_title()}</title>
</svelte:head>

<div class="page">
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_tenants_title()}</h1>
			<p class="page-description">{$LL.admin_tenants_description()}</p>
		</div>
		{#if !singleTenantMode}
			<a href="/admin/tenants/new" class="btn btn-primary">
				<i class="i-ph-plus"></i>
				{$LL.admin_tenants_add()}
			</a>
		{:else}
			<button class="btn btn-primary" disabled title={$LL.admin_tenants_add_disabled_title()}>
				<i class="i-ph-plus"></i>
				{$LL.admin_tenants_add()}
			</button>
		{/if}
	</div>

	{#if singleTenantMode}
		<div class="alert alert-info">
			<i class="i-ph-info"></i>
			<div>
				<strong>{$LL.admin_tenants_single_mode_title()}</strong>
				<p>
					{singleTenantReason ?? $LL.admin_tenants_single_mode_fallback()}
					{$LL.admin_tenants_single_mode_setup_hint()}
				</p>
			</div>
		</div>
	{/if}

	{#if tenantD1Pool?.enabled}
		<div class="alert alert-info">
			<i class="i-ph-database"></i>
			<div>
				<strong>{$LL.admin_tenants_d1_slots()}</strong>
				<p>
					{$LL.admin_tenants_d1_slots_available({
						available: tenantD1Pool.available_slots ?? 0,
						capacity: tenantD1Pool.capacity ?? 0
					})}
				</p>
			</div>
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<i class="i-ph-warning-circle"></i>
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			{$LL.admin_tenants_loading()}
		</div>
	{:else if tenants.length === 0}
		<div class="empty-state">
			<i class="i-ph-buildings"></i>
			<p>{$LL.admin_tenants_empty()}</p>
		</div>
	{:else}
		<div class="table-container">
			<table class="table">
				<thead>
					<tr>
						<th>{$LL.admin_tenants_id()}</th>
						<th>{$LL.admin_tenants_code()}</th>
						<th>{$LL.admin_tenants_name()}</th>
						<th>{$LL.admin_tenants_description_label()}</th>
						<th>{$LL.admin_tenants_status()}</th>
						<th>{$LL.admin_tenants_default()}</th>
					</tr>
				</thead>
				<tbody>
					{#each tenants as tenant (tenant.id)}
						<tr
							class="tenant-row"
							onclick={() => goto(`/admin/tenants/${encodeURIComponent(tenant.id)}`)}
							role="link"
							tabindex="0"
							onkeydown={(e) =>
								e.key === 'Enter' && goto(`/admin/tenants/${encodeURIComponent(tenant.id)}`)}
							aria-label={$LL.admin_tenants_view_aria({ name: tenant.name })}
						>
							<td class="tenant-id">{tenant.id}</td>
							<td class="tenant-id">{tenant.tenant_code}</td>
							<td class="tenant-name">{tenant.name}</td>
							<td class="tenant-description">{tenant.description ?? '—'}</td>
							<td>
								{#if tenant.lifecycle_state === 'active'}
									<span class="badge badge-active">{$LL.admin_tenants_active()}</span>
								{:else}
									<span class="badge badge-inactive">{lifecycleLabel(tenant.lifecycle_state)}</span>
								{/if}
							</td>
							<td>
								{#if tenant.is_default}
									<span
										class="default-star is-default"
										title={$LL.admin_tenants_default_tenant()}
										aria-label={$LL.admin_tenants_default_tenant()}
									>
										<i class="i-ph-star-fill"></i>
									</span>
								{:else}
									<span
										class="default-star"
										title={$LL.admin_tenants_not_default()}
										aria-label={$LL.admin_tenants_not_default()}
									>
										<i class="i-ph-star"></i>
									</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.page-title {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0 0 4px;
	}

	.page-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	/* Table */
	.table-container {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.table {
		width: 100%;
		border-collapse: collapse;
	}

	.table th {
		padding: 12px 16px;
		text-align: left;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		background: var(--bg-subtle);
		border-bottom: 1px solid var(--border);
	}

	.table td {
		padding: 14px 16px;
		font-size: 0.875rem;
		color: var(--text-primary);
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
	}

	.table tr:last-child td {
		border-bottom: none;
	}

	/* Clickable rows */
	.tenant-row {
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.tenant-row:hover td {
		background: var(--bg-subtle);
	}

	.tenant-row:focus {
		outline: none;
	}

	.tenant-row:focus-visible td {
		background: var(--primary-light);
	}

	.tenant-id {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.tenant-name {
		font-weight: 500;
	}

	.tenant-description {
		color: var(--text-secondary);
		max-width: 240px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Badges */
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.badge-active {
		background: var(--success-subtle);
		color: var(--success);
	}

	.badge-inactive {
		background: var(--bg-subtle);
		color: var(--text-muted);
	}

	/* Default star */
	.default-star {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}

	.default-star :global(i) {
		width: 18px;
		height: 18px;
	}

	.default-star.is-default {
		color: var(--warning);
	}

	/* Buttons */
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
		border: none;
		text-decoration: none;
		font-family: var(--font-body);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn :global(i) {
		width: 16px;
		height: 16px;
	}

	.btn-primary {
		background: var(--primary);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-dark);
	}

	/* Alert */
	.alert {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		background: var(--danger-subtle);
		color: var(--danger);
		border: 1px solid var(--danger-border);
	}

	.alert-info {
		background: var(--info-subtle, var(--primary-light));
		color: var(--info, var(--primary));
		border: 1px solid var(--info-border, var(--primary-light));
	}

	/* Loading / Empty */
	.loading-state,
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 48px;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.loading-state :global(i),
	.empty-state :global(i) {
		width: 32px;
		height: 32px;
	}
</style>

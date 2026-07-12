<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { AdminDataTable, AdminPageHeader, AdminPageShell } from '$lib/components/admin';
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

<AdminPageShell>
	<AdminPageHeader title={$LL.admin_tenants_title()} description={$LL.admin_tenants_description()}>
		{#snippet actions()}
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
		{/snippet}
	</AdminPageHeader>

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
		<AdminDataTable width="wide">
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
						data-clickable="true"
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
		</AdminDataTable>
	{/if}
</AdminPageShell>

<style>
	.tenant-id {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.tenant-name {
		font-weight: 600;
	}

	.tenant-description {
		color: var(--color-text-muted);
		max-width: 240px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Badges */
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
	}

	.badge-active {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.badge-inactive {
		background: var(--color-surface-raised);
		color: var(--color-text-muted);
	}

	.default-star {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-subtle);
	}

	.default-star :global(i) {
		width: 18px;
		height: 18px;
	}

	.default-star.is-default {
		color: var(--color-warning);
	}

	.alert {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.85rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
		color: var(--color-text);
		font-size: 0.875rem;
		margin-bottom: 1rem;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		border-color: color-mix(in srgb, var(--color-danger) 28%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 9%, var(--color-surface));
		color: var(--color-danger);
	}

	.alert-info {
		border-color: color-mix(in srgb, var(--color-accent) 26%, var(--color-border));
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
		color: var(--color-text);
	}

	.alert-info :global(i) {
		color: var(--color-accent);
	}

	.alert p {
		margin: 0.2rem 0 0;
		color: var(--color-text-muted);
		line-height: 1.6;
	}

	.loading-state,
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.loading-state :global(i),
	.empty-state :global(i) {
		width: 32px;
		height: 32px;
	}

	.empty-state p {
		margin: 0;
	}
</style>

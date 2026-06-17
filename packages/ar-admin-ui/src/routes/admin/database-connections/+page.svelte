<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminDatabaseConnectionsAPI,
		type DatabaseConnection
	} from '$lib/api/admin-database-connections';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let items = $state<DatabaseConnection[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			const response = await adminDatabaseConnectionsAPI.list();
			items = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_database_connections_load_failed();
			items = [];
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function openConnection(id: string) {
		goto(`/admin/database-connections/${encodeURIComponent(id)}`);
	}

	function createConnection() {
		goto('/admin/database-connections/new');
	}

	function formatConfigSummary(item: DatabaseConnection): string {
		const bindingRef = typeof item.config.bindingRef === 'string' ? item.config.bindingRef : null;
		const logicalSource =
			typeof item.config.logicalSource === 'string' ? item.config.logicalSource : null;
		const role = typeof item.config.role === 'string' ? item.config.role : null;
		return [bindingRef, logicalSource, role].filter(Boolean).join(' / ') || '-';
	}

	function tenantAssignments(item: DatabaseConnection) {
		return item.tenant_assignments ?? [];
	}
</script>

<svelte:head>
	<title>{$LL.admin_database_connections_page_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<button class="btn btn-secondary" onclick={load} disabled={loading}>
		{$LL.admin_database_connections_refresh()}
	</button>
	<button class="btn btn-primary" onclick={createConnection}>
		{$LL.admin_database_connections_create_connection()}
	</button>
{/snippet}

{#snippet connectionsActions()}
	<span class="badge badge-neutral">{items.length}</span>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_database_connections_title()}
		description={$LL.admin_database_connections_description()}
		actions={pageActions}
	/>
	{#if error}<div class="alert alert-error">{error}</div>{/if}

	<AdminSection title={$LL.admin_database_connections_connections()} actions={connectionsActions}>
		{#if loading}
			<p class="text-muted">{$LL.admin_database_connections_loading()}</p>
		{:else if items.length === 0}
			<p class="text-muted">{$LL.admin_database_connections_empty()}</p>
		{:else}
			<div class="item-list">
				{#each items as item (item.id)}
					<button class="item-row" onclick={() => openConnection(item.id)}>
						<div class="item-name">
							<strong>{item.display_name}</strong>
							<small>{item.name}</small>
						</div>
						<span class="text-muted meta-text">{formatConfigSummary(item)}</span>
						<div
							class="tenant-badges"
							aria-label={$LL.admin_database_connections_tenant_assignments_aria()}
						>
							{#if tenantAssignments(item).length === 0}
								<span class="text-muted meta-text">-</span>
							{:else}
								{#each tenantAssignments(item) as tenant (`${tenant.kind}:${tenant.id}`)}
									<span
										class="badge {tenant.kind === 'platform' ? 'badge-info' : 'badge-neutral'}"
										title={tenant.id}
									>
										{tenant.name}
									</span>
								{/each}
							{/if}
						</div>
						<span class="badge badge-neutral">{item.provider}</span>
						{#if item.read_only}
							<span class="badge badge-muted">{$LL.admin_database_connections_setup()}</span>
						{:else}
							<span class="badge {item.status === 'active' ? 'badge-success' : 'badge-neutral'}"
								>{item.status}</span
							>
						{/if}
						<span class="row-chevron" aria-hidden="true">›</span>
					</button>
				{/each}
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
	.alert {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-control);
		font-size: 0.875rem;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
	}

	.item-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--shadow-panel);
		overflow: hidden;
	}

	.item-row {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) minmax(180px, 0.9fr) minmax(180px, 1fr) auto auto 1rem;
		align-items: center;
		gap: 0.75rem;
		padding: 0.8rem 1rem;
		border: none;
		border-bottom: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-text);
		text-align: left;
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.item-row:last-child {
		border-bottom: none;
	}

	.item-row:hover {
		background: var(--color-surface-muted);
	}

	.item-name strong {
		display: block;
		font-weight: 600;
		color: var(--color-text);
	}

	.item-name small,
	.text-muted {
		color: var(--color-text-muted);
	}

	.item-name small,
	.meta-text {
		font-size: 0.75rem;
	}

	.row-chevron {
		color: var(--color-text-muted);
		font-size: 1.25rem;
		line-height: 1;
	}

	.tenant-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		min-width: 0;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.badge-neutral,
	.badge-muted {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.badge-info {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
	}

	.badge-success {
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
	}

	@media (max-width: 900px) {
		.item-row {
			grid-template-columns: 1fr auto;
		}

		.item-row > .text-muted,
		.item-row > .badge {
			justify-self: start;
		}

		.row-chevron {
			grid-column: 2;
			grid-row: 1;
		}
	}
</style>

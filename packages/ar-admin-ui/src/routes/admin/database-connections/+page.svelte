<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminDatabaseConnectionsAPI,
		type DatabaseConnection
	} from '$lib/api/admin-database-connections';
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

<div class="page-shell">
	<header class="page-header">
		<div class="page-title-group">
			<h1 class="page-title">{$LL.admin_database_connections_title()}</h1>
			<p class="page-description">{$LL.admin_database_connections_description()}</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={load} disabled={loading}>
				{$LL.admin_database_connections_refresh()}
			</button>
			<button class="btn btn-primary" onclick={createConnection}>
				{$LL.admin_database_connections_create_connection()}
			</button>
		</div>
	</header>

	{#if error}<div class="alert alert-error">{error}</div>{/if}

	<div class="panel">
		<div class="panel-header">
			<h2 class="panel-title">{$LL.admin_database_connections_connections()}</h2>
			<span class="badge badge-neutral">{items.length}</span>
		</div>
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
						<span class="text-muted text-sm">{formatConfigSummary(item)}</span>
						<div
							class="tenant-badges"
							aria-label={$LL.admin_database_connections_tenant_assignments_aria()}
						>
							{#if tenantAssignments(item).length === 0}
								<span class="text-muted text-sm">-</span>
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
	</div>
</div>

<style>
	.page-shell {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.page-header,
	.page-actions,
	.panel-header {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.page-header,
	.panel-header {
		justify-content: space-between;
	}

	.page-actions {
		gap: 0.5rem;
	}

	.page-title {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
	}

	.page-description {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.alert {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-sm);
		font-size: 0.875rem;
	}

	.alert-error {
		background: rgba(239, 68, 68, 0.08);
		color: #991b1b;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		padding: 1.5rem;
	}

	.panel-title {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}

	.item-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.item-row {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) minmax(180px, 0.9fr) minmax(180px, 1fr) auto auto 1rem;
		align-items: center;
		gap: 0.75rem;
		padding: 0.8rem 1rem;
		border: none;
		border-bottom: 1px solid var(--border);
		background: var(--bg-card);
		text-align: left;
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.item-row:last-child {
		border-bottom: none;
	}

	.item-row:hover {
		background: var(--bg-subtle);
	}

	.item-name strong {
		display: block;
		font-weight: 600;
		color: var(--text-primary);
	}

	.item-name small,
	.text-muted {
		color: var(--text-secondary);
	}

	.item-name small,
	.text-sm {
		font-size: 0.75rem;
	}

	.row-chevron {
		color: var(--text-secondary);
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
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}

	.badge-info {
		background: rgba(59, 130, 246, 0.1);
		color: #1d4ed8;
	}

	.badge-success {
		background: rgba(16, 185, 129, 0.1);
		color: #065f46;
	}

	@media (max-width: 900px) {
		.page-header {
			align-items: flex-start;
			flex-direction: column;
		}

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

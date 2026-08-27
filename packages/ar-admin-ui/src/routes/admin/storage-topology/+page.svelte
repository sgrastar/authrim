<script lang="ts">
	import { onMount } from 'svelte';
	import { adminControlPlaneAPI, type ControlStorageTopology } from '$lib/api/admin-control-plane';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';

	let topology = $state<ControlStorageTopology | null>(null);
	let selectedTenantId = $state('all');
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state('');

	let selectedTenant = $derived(
		topology?.tenants.find((tenant) => tenant.tenantId === selectedTenantId) ?? null
	);
	let visibleTenantShards = $derived.by(() => {
		if (!topology || selectedTenantId === 'all') return topology?.tenantShards ?? [];
		if (selectedTenant?.isolationPolicy === 'shared_pool') {
			return topology.tenantShards.filter((shard) => shard.allocationScope === 'shared_pool');
		}
		return topology.tenantShards.filter((shard) => shard.ownerTenantId === selectedTenantId);
	});
	let visibleOperations = $derived.by(() => {
		if (!topology || selectedTenantId === 'all') return topology?.operations ?? [];
		if (selectedTenant?.isolationPolicy === 'shared_pool') {
			return topology.operations.filter(
				(operation) => operation.tenantId === null && operation.dataRole !== 'lookup'
			);
		}
		return topology.operations.filter((operation) => operation.tenantId === selectedTenantId);
	});

	onMount(() => {
		void loadTopology();
		const timer = window.setInterval(() => void loadTopology(true), 30_000);
		return () => window.clearInterval(timer);
	});

	async function loadTopology(background = false) {
		if (refreshing) return;
		refreshing = true;
		if (!background) loading = true;
		try {
			topology = (await adminControlPlaneAPI.getStorageTopology()).topology;
			if (
				selectedTenantId !== 'all' &&
				!topology.tenants.some((tenant) => tenant.tenantId === selectedTenantId)
			) {
				selectedTenantId = 'all';
			}
			error = '';
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Storage topology could not be loaded.';
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	function formatCount(value: number | null): string {
		return value === null ? 'Unavailable' : new Intl.NumberFormat().format(value);
	}

	function formatBytes(value: number | null): string {
		if (value === null) return '-';
		if (value === 0) return '0 B';
		const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
		const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
		return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
	}

	function formatDate(value: number): string {
		const date = new Date(value * 1000);
		return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
	}

	function formatProviderDate(value: string | null): string {
		if (!value) return '-';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
	}

	function formatLatency(start: number, end: number | null): string {
		if (end === null || end < start) return '-';
		const seconds = end - start;
		return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	}

	function utilization(allocated: number | null, target: number | null): string {
		if (allocated === null || target === null || target === 0) return '-';
		return `${Math.min(999, Math.round((allocated / target) * 100))}%`;
	}

	function statusClass(status: string): string {
		if (['active', 'ready', 'healthy', 'eligible', 'succeeded'].includes(status)) {
			return 'status status-good';
		}
		if (['failed', 'blocked', 'degraded', 'unavailable'].includes(status)) {
			return 'status status-bad';
		}
		if (
			['requested', 'provisioning', 'creating', 'queued', 'running', 'waiting_retry'].includes(
				status
			)
		) {
			return 'status status-progress';
		}
		return 'status';
	}
</script>

<svelte:head><title>Storage Topology - Authrim Admin</title></svelte:head>

{#snippet pageActions()}
	<button
		class="btn btn-secondary"
		type="button"
		disabled={refreshing}
		onclick={() => loadTopology()}
	>
		<i class="i-ph-arrows-clockwise" class:spin={refreshing} aria-hidden="true"></i>
		<span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title="Storage Topology"
		description="Live Control inventory for D1 capacity, tenant assignments, spare databases, and provisioning latency. This page is read-only and refreshes every 30 seconds."
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error" role="alert">{error}</div>
	{/if}

	{#if loading && !topology}
		<div class="loading-panel" aria-live="polite">Loading storage topology…</div>
	{:else if topology}
		<div class="snapshot-meta">
			<span>Environment <code>{topology.environmentId}</code></span>
			<span>Snapshot {formatDate(topology.generatedAt)}</span>
		</div>

		<div class="summary-grid" aria-label="Storage topology summary">
			<article class="summary-card">
				<span>Environment D1</span>
				<strong>{formatCount(topology.summary.providerD1Count)}</strong>
				<small
					>{topology.summary.providerInventoryAvailable
						? 'Cloudflare inventory'
						: 'Provider API unavailable'}</small
				>
			</article>
			<article class="summary-card">
				<span>Control managed</span>
				<strong>{formatCount(topology.summary.controlManagedD1Count)}</strong>
				<small
					>{topology.summary.tenantShardCount} tenant · {topology.summary.lookupShardCount} lookup</small
				>
			</article>
			<article class="summary-card">
				<span>Accounts</span>
				<strong>{formatCount(topology.summary.accountCount)}</strong>
				<small>Committed user allocations</small>
			</article>
			<article class="summary-card">
				<span>Ready spares</span>
				<strong>{topology.summary.readySpareCount} / {topology.policy.maxReadySpares}</strong>
				<small>Ready and unassigned</small>
			</article>
			<article
				class="summary-card"
				class:summary-card-alert={topology.summary.provisioningD1Count > 0}
			>
				<span>Provisioning</span>
				<strong>{formatCount(topology.summary.provisioningD1Count)}</strong>
				<small>{topology.summary.inFlightOperationCount} operation(s) in flight</small>
			</article>
			<article
				class="summary-card"
				class:summary-card-danger={topology.summary.failedD1Count > 0 ||
					topology.summary.blockedOperationCount > 0}
			>
				<span>Failed / blocked</span>
				<strong>{topology.summary.failedD1Count} / {topology.summary.blockedOperationCount}</strong>
				<small>Resources / operations</small>
			</article>
		</div>

		<dl class="policy-grid">
			<div>
				<dt>Target accounts / D1</dt>
				<dd>{formatCount(topology.policy.targetAccountCount)}</dd>
			</div>
			<div>
				<dt>Concurrent provisioning</dt>
				<dd>{topology.policy.maxConcurrentProvisioning}</dd>
			</div>
			<div>
				<dt>Maximum D1</dt>
				<dd>{formatCount(topology.policy.maxD1Resources)}</dd>
			</div>
			<div>
				<dt>Daily create budget</dt>
				<dd>{formatCount(topology.policy.dailyD1CreateBudget)}</dd>
			</div>
		</dl>

		<AdminSection
			title="Tenant placement"
			description="Choose a tenant to narrow the shard and provisioning tables. Shared tenants display their shared pool."
		>
			<div class="filter-row">
				<label for="tenant-filter">Tenant</label>
				<select id="tenant-filter" class="form-select" bind:value={selectedTenantId}>
					<option value="all">All tenants</option>
					{#each topology.tenants as tenant (tenant.tenantId)}
						<option value={tenant.tenantId}>{tenant.tenantId} ({tenant.isolationPolicy})</option>
					{/each}
				</select>
			</div>
			<AdminDataTable width="wide">
				<thead
					><tr
						><th>Tenant</th><th>Isolation</th><th>State</th><th class="text-right">Accounts</th><th
							class="text-right">Assigned D1</th
						></tr
					></thead
				>
				<tbody>
					{#each topology.tenants as tenant (tenant.tenantId)}
						<tr>
							<td><code>{tenant.tenantId}</code></td>
							<td>{tenant.isolationPolicy}</td>
							<td><span class={statusClass(tenant.policyState)}>{tenant.policyState}</span></td>
							<td class="text-right">{formatCount(tenant.accountCount)}</td>
							<td class="text-right">{formatCount(tenant.assignedShardCount)}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		<AdminSection
			title="Tenant D1 shards"
			description={`${visibleTenantShards.length} shard(s) in the current filter.`}
		>
			<AdminDataTable width="xwide">
				<thead
					><tr
						><th>Database</th><th>Role</th><th>Scope / owner</th><th>Status</th><th>Health</th><th
							>Allocation</th
						><th class="text-right">Allocated / target</th><th class="text-right">Use</th><th
							class="text-right">Storage</th
						></tr
					></thead
				>
				<tbody>
					{#each visibleTenantShards as shard (shard.shardId)}
						<tr>
							<td
								><span class="database-name">{shard.databaseName}</span><small
									>{shard.providerDatabaseId ?? 'Provider ID pending'}</small
								></td
							>
							<td>{shard.dataRole}</td>
							<td>{shard.allocationScope}<small>{shard.ownerTenantId ?? 'shared'}</small></td>
							<td><span class={statusClass(shard.status)}>{shard.status}</span></td>
							<td
								><span class={statusClass(shard.healthStatus ?? 'unknown')}
									>{shard.healthStatus ?? '-'}</span
								></td
							>
							<td
								><span class={statusClass(shard.allocationStatus ?? 'unknown')}
									>{shard.allocationStatus ?? '-'}</span
								></td
							>
							<td class="text-right"
								>{formatCount(shard.allocatedAccountCount)} / {formatCount(
									shard.targetAccountCount
								)}</td
							>
							<td class="text-right"
								>{utilization(shard.allocatedAccountCount, shard.targetAccountCount)}</td
							>
							<td class="text-right">{formatBytes(shard.storageBytes)}</td>
						</tr>
					{:else}
						<tr><td colspan="9" class="empty-cell">No tenant D1 shards match this filter.</td></tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		<AdminSection
			title="Lookup D1 shards"
			description="Physical Lookup inventory and active bucket distribution."
		>
			<AdminDataTable width="wide">
				<thead
					><tr
						><th>Database</th><th>Status</th><th>Residency</th><th class="text-right"
							>Capacity weight</th
						><th class="text-right">Active buckets</th><th>Updated</th></tr
					></thead
				>
				<tbody>
					{#each topology.lookupShards as shard (shard.lookupShardId)}
						<tr>
							<td
								><span class="database-name">{shard.databaseName}</span><small
									>{shard.providerDatabaseId ?? 'Provider ID pending'}</small
								></td
							>
							<td><span class={statusClass(shard.status)}>{shard.status}</span></td>
							<td>{shard.residencyPartition}</td>
							<td class="text-right">{shard.capacityWeight}</td>
							<td class="text-right">{formatCount(shard.activeBucketCount)}</td>
							<td>{formatDate(shard.updatedAt)}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		<AdminSection
			title="Recent provisioning"
			description="Decision, provider creation, and ready timing for the latest 100 D1 operations."
		>
			<AdminDataTable width="xwide">
				<thead
					><tr
						><th>Database</th><th>Tenant / role</th><th>Status</th><th>Decision</th><th
							class="text-right">Decision → create</th
						><th class="text-right">Decision → ready</th><th class="text-right">Attempts</th><th
							>Last error</th
						></tr
					></thead
				>
				<tbody>
					{#each visibleOperations as operation (operation.operationId)}
						<tr>
							<td
								><span class="database-name">{operation.databaseName}</span><small
									>{operation.operationId}</small
								></td
							>
							<td>{operation.tenantId ?? 'shared / lookup'}<small>{operation.dataRole}</small></td>
							<td
								><span class={statusClass(operation.status)}>{operation.status}</span><small
									>{operation.provisioningState}</small
								></td
							>
							<td>{formatDate(operation.decidedAt)}</td>
							<td class="text-right"
								>{formatLatency(operation.decidedAt, operation.createStartedAt)}</td
							>
							<td class="text-right">{formatLatency(operation.decidedAt, operation.readyAt)}</td>
							<td class="text-right">{operation.attemptCount}</td>
							<td><code>{operation.lastErrorCode ?? '-'}</code></td>
						</tr>
					{:else}
						<tr
							><td colspan="8" class="empty-cell">No provisioning operations match this filter.</td
							></tr
						>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		<AdminSection
			title="Cloudflare D1 inventory"
			description="Actual provider resources with the environment prefix. A provider API failure does not hide Control state."
		>
			{#if topology.summary.providerInventoryAvailable}
				<AdminDataTable width="wide">
					<thead
						><tr
							><th>Database</th><th>Provider ID</th><th class="text-right">Size</th><th>Created</th
							><th>Control inventory</th></tr
						></thead
					>
					<tbody>
						{#each topology.providerDatabases as database (database.databaseId)}
							<tr>
								<td>{database.databaseName}</td>
								<td><code>{database.databaseId}</code></td>
								<td class="text-right">{formatBytes(database.fileSizeBytes)}</td>
								<td>{formatProviderDate(database.createdAt)}</td>
								<td
									><span class={database.managedByControl ? 'status status-good' : 'status'}
										>{database.managedByControl ? 'Managed shard' : 'Fixed / unmanaged'}</span
									></td
								>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{:else}
				<div class="alert alert-warning">
					Cloudflare inventory is temporarily unavailable. Control-managed tenant and Lookup state
					remains current above.
				</div>
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.snapshot-meta,
	.filter-row {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
		color: var(--color-text-muted);
		font-size: 0.8rem;
	}

	.snapshot-meta {
		margin-bottom: 16px;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
	}

	.summary-card {
		display: grid;
		gap: 5px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}

	.summary-card-alert {
		border-color: color-mix(in srgb, var(--color-warning) 55%, var(--color-border));
	}
	.summary-card-danger {
		border-color: color-mix(in srgb, var(--color-danger) 55%, var(--color-border));
	}
	.summary-card span,
	.summary-card small {
		color: var(--color-text-muted);
	}
	.summary-card strong {
		font-family: var(--font-display);
		font-size: 1.55rem;
	}
	.summary-card small {
		font-size: 0.74rem;
	}

	.policy-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
		gap: 1px;
		margin: 12px 0 24px;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-border);
	}

	.policy-grid div {
		padding: 11px 14px;
		background: var(--color-surface-raised);
	}
	.policy-grid dt {
		color: var(--color-text-muted);
		font-size: 0.72rem;
	}
	.policy-grid dd {
		margin: 3px 0 0;
		font-weight: 700;
	}

	.filter-row {
		margin-bottom: 12px;
	}
	.filter-row label {
		color: var(--color-text);
		font-weight: 700;
	}
	.filter-row select {
		min-width: min(100%, 360px);
	}

	.database-name {
		display: block;
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	td small {
		display: block;
		max-width: 280px;
		margin-top: 3px;
		overflow: hidden;
		color: var(--color-text-muted);
		font-size: 0.7rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	td code,
	.snapshot-meta code {
		font-size: 0.75rem;
	}

	.status {
		display: inline-flex;
		padding: 3px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: var(--color-surface-raised);
		font-size: 0.7rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.status-good {
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		color: var(--color-success);
	}
	.status-progress {
		border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
		color: var(--color-warning);
	}
	.status-bad {
		border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
		color: var(--color-danger);
	}
	.empty-cell {
		padding: 28px !important;
		color: var(--color-text-muted);
		text-align: center;
	}
	.loading-panel {
		padding: 48px;
		color: var(--color-text-muted);
		text-align: center;
	}
	.spin {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingSchemaReadinessRow,
		type IdentityMappingSchemaReadinessSummary
	} from '$lib/api/admin-identity-mapping';

	type GateFilter = IdentityMappingSchemaReadinessRow['gateState'] | 'all';

	let rows = $state<IdentityMappingSchemaReadinessRow[]>([]);
	let summary = $state<IdentityMappingSchemaReadinessSummary>({
		total: 0,
		pass: 0,
		attention: 0,
		blocked: 0,
		deferred: 0
	});
	let activeStatus = $state<GateFilter>('all');
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	onMount(() => {
		void loadSchemaReadiness();
	});

	async function loadSchemaReadiness() {
		loading = true;
		errorMessage = null;
		try {
			const result = await adminIdentityMappingAPI.getSchemaReadiness();
			rows = result.rows;
			summary = result.summary;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load schema readiness';
		} finally {
			loading = false;
		}
	}

	const visibleRows = $derived(
		activeStatus === 'all' ? rows : rows.filter((row) => row.gateState === activeStatus)
	);
	const statuses = $derived(['all', ...new Set(rows.map((row) => row.gateState))] as const);
</script>

<svelte:head>
	<title>Schema Readiness - Authrim Admin</title>
</svelte:head>

<div class="readiness-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/identity-mapping">Back to Identity Mapping</a>
			<p class="eyebrow">Identity Mapping</p>
			<h1>Schema Readiness</h1>
			<p class="summary">
				Check inventory IDs, expected connection points, and gate notes before activating Tier 2
				mapping policies.
			</p>
		</div>
		<div class="status-panel">
			<div>
				<span>Blocked</span>
				<strong>{summary.blocked}</strong>
			</div>
			<div>
				<span>Deferred</span>
				<strong>{summary.deferred}</strong>
			</div>
			<div>
				<span>Attention</span>
				<strong>{summary.attention}</strong>
			</div>
			<div>
				<span>Total</span>
				<strong>{summary.total}</strong>
			</div>
		</div>
	</div>

	<section class="readiness-panel">
		<div class="filter-bar" aria-label="Schema readiness filters">
			{#each statuses as status (status)}
				<button
					type="button"
					class:active={activeStatus === status}
					onclick={() => (activeStatus = status)}
				>
					{status.replace('_', ' ')}
				</button>
			{/each}
			<button type="button" onclick={loadSchemaReadiness} disabled={loading}>Refresh</button>
		</div>

		{#if loading}
			<div class="empty-state">Loading schema-readiness inventory from the control plane.</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else}
			<div class="table-shell">
				<table>
					<thead>
						<tr>
							<th>Inventory ID</th>
							<th>Area</th>
							<th>Status</th>
							<th>Gate State</th>
							<th>Schema Object</th>
							<th>Connection</th>
							<th>Gate</th>
						</tr>
					</thead>
					<tbody>
						{#each visibleRows as row (row.id)}
							<tr>
								<td><strong>{row.id}</strong></td>
								<td>{row.area}</td>
								<td><span class="status status-{row.status}">{row.status}</span></td>
								<td>
									<span class="status status-{row.gateState}">{row.gateState}</span>
								</td>
								<td>
									{#if row.schemaObject}
										<code>{row.schemaObject}</code>
										<small>{row.schemaPresent ? 'present' : 'missing'}</small>
									{:else}
										<span class="muted">service / adapter</span>
									{/if}
								</td>
								<td>{row.expectedConnectionPr}</td>
								<td>{row.gate}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>

<style>
	.readiness-page {
		display: grid;
		gap: 18px;
	}

	.page-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.back-link {
		display: inline-flex;
		margin-bottom: 12px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.eyebrow,
	.status-panel span,
	th {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h1,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
	}

	.summary,
	td {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.summary {
		max-width: 760px;
		margin-top: 8px;
		font-size: 14px;
	}

	.status-panel,
	.readiness-panel,
	.table-shell {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		min-width: 260px;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		padding: 14px;
	}

	.status-panel strong {
		display: block;
		margin-top: 4px;
		color: var(--text-primary);
		font-size: 22px;
	}

	.readiness-panel {
		display: grid;
		gap: 14px;
		padding: 16px;
	}

	.empty-state {
		padding: 18px;
		border: 1px dashed var(--border-color);
		border-radius: 8px;
		color: var(--text-secondary);
	}

	.filter-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	button {
		min-height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-secondary);
		background: var(--bg-card);
		font-weight: 800;
		text-transform: capitalize;
	}

	button.active {
		color: var(--text-primary);
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	.table-shell {
		overflow: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		padding: 12px;
		border-bottom: 1px solid var(--border-color);
		text-align: left;
		vertical-align: top;
	}

	tr:last-child td {
		border-bottom: 0;
	}

	td strong {
		color: var(--text-primary);
	}

	td small {
		display: block;
		margin-top: 4px;
		color: var(--text-muted);
		font-size: 12px;
	}

	code {
		color: var(--text-primary);
		font-size: 12px;
	}

	.muted {
		color: var(--text-muted);
	}

	.status {
		display: inline-flex;
		padding: 4px 8px;
		border-radius: 999px;
		background: var(--bg-muted);
		color: var(--text-primary);
		font-weight: 800;
	}

	.status-closed,
	.status-tested,
	.status-api_connected,
	.status-repo_connected,
	.status-service_connected,
	.status-pass {
		color: #047857;
		background: rgba(16, 185, 129, 0.14);
	}

	.status-deferred,
	.status-reserved_planned,
	.status-adapter_deferred {
		color: #92400e;
		background: rgba(245, 158, 11, 0.16);
	}

	.status-attention,
	.status-schema_added,
	.status-existing_to_migrate,
	.status-breaking_planned {
		color: #9a3412;
		background: rgba(249, 115, 22, 0.16);
	}

	.status-blocked {
		color: #b91c1c;
		background: rgba(239, 68, 68, 0.14);
	}

	@media (max-width: 900px) {
		.page-heading,
		.status-panel {
			display: grid;
		}

		.status-panel {
			min-width: 0;
		}
	}
</style>

<script lang="ts">
	type ReadinessStatus =
		| 'closed'
		| 'tested'
		| 'ui_connected'
		| 'api_connected'
		| 'deferred'
		| 'blocked';

	interface ReadinessRow {
		id: string;
		area: string;
		status: ReadinessStatus;
		connection: string;
		gate: string;
	}

	const rows: ReadinessRow[] = [
		{
			id: 'UIM-SCH-001',
			area: 'Canonical identity subjects',
			status: 'closed',
			connection: 'Tier 1 canonical repository',
			gate: 'Runtime readers use canonical storage'
		},
		{
			id: 'UIM-SCH-024',
			area: 'Mapping policy activations',
			status: 'api_connected',
			connection: 'PR12 operations view',
			gate: 'Activation, rollback, and degraded status visible'
		},
		{
			id: 'UIM-SCH-047',
			area: 'Activation leases',
			status: 'tested',
			connection: 'Policy activation API',
			gate: 'Concurrent activation has negative coverage'
		},
		{
			id: 'UIM-SCH-068',
			area: 'Lifecycle signal ledger',
			status: 'tested',
			connection: 'Implemented lifecycle signals',
			gate: 'SSF/CAEP/RISC adapters remain deferred'
		},
		{
			id: 'UIM-SCH-072',
			area: 'Federation trust anchors',
			status: 'api_connected',
			connection: 'Federation Trust view',
			gate: 'SAML trust sources and anchors are inspectable'
		},
		{
			id: 'UIM-SCH-073',
			area: 'Federation metadata documents',
			status: 'ui_connected',
			connection: 'Federation Trust metadata ledger',
			gate: 'Documents and entity summaries are visible from the trust source detail'
		},
		{
			id: 'UIM-SCH-086',
			area: 'SSF/CAEP/RISC adapter',
			status: 'deferred',
			connection: 'adapter_deferred',
			gate: 'No runtime endpoint exposure until resume criteria are met'
		}
	];

	let activeStatus = $state<ReadinessStatus | 'all'>('all');

	const visibleRows = $derived(
		activeStatus === 'all' ? rows : rows.filter((row) => row.status === activeStatus)
	);
	const blockedCount = $derived(rows.filter((row) => row.status === 'blocked').length);
	const deferredCount = $derived(rows.filter((row) => row.status === 'deferred').length);
	const statuses = $derived(['all', ...new Set(rows.map((row) => row.status))] as const);
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
				<strong>{blockedCount}</strong>
			</div>
			<div>
				<span>Deferred</span>
				<strong>{deferredCount}</strong>
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
		</div>

		<div class="table-shell">
			<table>
				<thead>
					<tr>
						<th>Inventory ID</th>
						<th>Area</th>
						<th>Status</th>
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
							<td>{row.connection}</td>
							<td>{row.gate}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
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
	.status-ui_connected,
	.status-api_connected {
		color: #047857;
		background: rgba(16, 185, 129, 0.14);
	}

	.status-deferred {
		color: #92400e;
		background: rgba(245, 158, 11, 0.16);
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

<script lang="ts">
	import { onMount } from 'svelte';
	import { Modal } from '$lib/components';
	import {
		adminOperationalLogsAPI,
		type OperationalLogDetail,
		type OperationalLogSummary
	} from '$lib/api/admin-operational-logs';

	let loading = $state(true);
	let error = $state('');
	let logs = $state<OperationalLogSummary[]>([]);
	let total = $state(0);

	let subjectTypeFilter = $state('');
	let subjectIdFilter = $state('');
	let actionFilter = $state('');
	let actorIdFilter = $state('');

	let showDetailModal = $state(false);
	let detailLoading = $state(false);
	let detailError = $state('');
	let selectedLog = $state<OperationalLogDetail | null>(null);

	async function loadLogs() {
		loading = true;
		error = '';
		try {
			const response = await adminOperationalLogsAPI.list({
				subjectType: subjectTypeFilter || undefined,
				subjectId: subjectIdFilter.trim() || undefined,
				action: actionFilter.trim() || undefined,
				actorId: actorIdFilter.trim() || undefined,
				limit: 100
			});
			logs = response.items;
			total = response.total;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load operational logs';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadLogs();
	});

	async function openDetail(log: OperationalLogSummary) {
		showDetailModal = true;
		detailLoading = true;
		detailError = '';
		selectedLog = null;
		try {
			selectedLog = await adminOperationalLogsAPI.get(log.id);
		} catch (err) {
			detailError = err instanceof Error ? err.message : 'Failed to load operational log detail';
		} finally {
			detailLoading = false;
		}
	}

	function closeDetail() {
		showDetailModal = false;
		detailLoading = false;
		detailError = '';
		selectedLog = null;
	}

	function formatDateTime(value: number): string {
		return new Date(value * 1000).toLocaleString();
	}
</script>

<svelte:head>
	<title>Operational Logs - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Operational Logs</h1>
			<p class="page-description">
				View short-retention reason-detail records stored separately from immutable audit logs.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={loadLogs} disabled={loading}>Refresh</button>
		</div>
	</div>

	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label class="form-label" for="subject-type">Subject Type</label>
				<select
					id="subject-type"
					class="form-select"
					bind:value={subjectTypeFilter}
					onchange={loadLogs}
				>
					<option value="">All</option>
					<option value="user">User</option>
					<option value="client">Client</option>
					<option value="session">Session</option>
				</select>
			</div>
			<div class="form-group">
				<label class="form-label" for="subject-id">Subject ID</label>
				<input
					id="subject-id"
					class="form-input"
					bind:value={subjectIdFilter}
					onchange={loadLogs}
				/>
			</div>
			<div class="form-group">
				<label class="form-label" for="action">Action</label>
				<input id="action" class="form-input" bind:value={actionFilter} onchange={loadLogs} />
			</div>
			<div class="form-group">
				<label class="form-label" for="actor-id">Actor ID</label>
				<input id="actor-id" class="form-input" bind:value={actorIdFilter} onchange={loadLogs} />
			</div>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<div class="panel">
		<div class="panel-header">
			<h2 class="panel-title">Entries</h2>
			<span class="panel-meta">{total} total</span>
		</div>

		{#if loading}
			<div class="empty-state">Loading operational logs…</div>
		{:else if logs.length === 0}
			<div class="empty-state">No operational logs matched the current filters.</div>
		{:else}
			<div class="table-wrapper">
				<table class="data-table">
					<thead>
						<tr>
							<th>Action</th>
							<th>Subject</th>
							<th>Actor</th>
							<th>Created</th>
							<th>Expires</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each logs as log (log.id)}
							<tr>
								<td>{log.action}</td>
								<td>
									<div class="cell-primary">{log.subject_type}</div>
									<div class="cell-secondary">{log.subject_id}</div>
								</td>
								<td>{log.actor_id}</td>
								<td>{formatDateTime(log.created_at)}</td>
								<td>{formatDateTime(log.expires_at)}</td>
								<td class="row-actions">
									<button class="btn btn-sm btn-secondary" onclick={() => openDetail(log)}>
										View Detail
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

<Modal open={showDetailModal} onClose={closeDetail} title="Operational Log Detail" size="md">
	{#if detailLoading}
		<div class="empty-state">Loading operational log detail…</div>
	{:else if detailError}
		<div class="alert alert-error">{detailError}</div>
	{:else if selectedLog}
		<div class="detail-grid">
			<div>
				<strong>Action</strong>
				<div>{selectedLog.action}</div>
			</div>
			<div>
				<strong>Subject</strong>
				<div>{selectedLog.subject_type}:{selectedLog.subject_id}</div>
			</div>
			<div>
				<strong>Actor</strong>
				<div>{selectedLog.actor_id}</div>
			</div>
			<div>
				<strong>Request ID</strong>
				<div>{selectedLog.request_id ?? '-'}</div>
			</div>
			<div>
				<strong>Created</strong>
				<div>{formatDateTime(selectedLog.created_at)}</div>
			</div>
			<div>
				<strong>Expires</strong>
				<div>{formatDateTime(selectedLog.expires_at)}</div>
			</div>
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">Reason Detail</h3>
			<pre class="detail-block">{selectedLog.reason_detail}</pre>
		</div>
	{/if}
</Modal>

<style>
	.filter-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 1rem;
	}

	.table-wrapper {
		overflow-x: auto;
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
	}

	.data-table th,
	.data-table td {
		padding: 0.75rem;
		border-bottom: 1px solid var(--color-border-subtle);
		text-align: left;
		vertical-align: top;
	}

	.panel-header,
	.page-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.panel-meta,
	.cell-secondary {
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	.cell-primary {
		font-weight: 600;
	}

	.empty-state {
		padding: 2rem;
		text-align: center;
		color: var(--color-text-secondary);
	}

	.detail-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.detail-block {
		margin: 0;
		padding: 1rem;
		background: var(--color-surface-subtle);
		border-radius: 0.75rem;
		white-space: pre-wrap;
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Modal } from '$lib/components';
	import {
		adminOperationalLogsAPI,
		type OperationalLogDetail,
		type OperationalLogSummary
	} from '$lib/api/admin-operational-logs';
	import { LL } from '$i18n/i18n-svelte';

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
			error = err instanceof Error ? err.message : $LL.admin_operational_logs_load_failed();
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
			detailError =
				err instanceof Error ? err.message : $LL.admin_operational_logs_detail_load_failed();
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
	<title>{$LL.admin_operational_logs_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_operational_logs_title()}</h1>
			<p class="page-description">
				{$LL.admin_operational_logs_description()}
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={loadLogs} disabled={loading}
				>{$LL.admin_operational_logs_refresh()}</button
			>
		</div>
	</div>

	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label class="form-label" for="subject-type"
					>{$LL.admin_operational_logs_subject_type()}</label
				>
				<select
					id="subject-type"
					class="form-select"
					bind:value={subjectTypeFilter}
					onchange={loadLogs}
				>
					<option value="">{$LL.admin_operational_logs_all()}</option>
					<option value="user">{$LL.admin_operational_logs_subject_user()}</option>
					<option value="client">{$LL.admin_operational_logs_subject_client()}</option>
					<option value="session">{$LL.admin_operational_logs_subject_session()}</option>
				</select>
			</div>
			<div class="form-group">
				<label class="form-label" for="subject-id">{$LL.admin_operational_logs_subject_id()}</label>
				<input
					id="subject-id"
					class="form-input"
					bind:value={subjectIdFilter}
					onchange={loadLogs}
				/>
			</div>
			<div class="form-group">
				<label class="form-label" for="action">{$LL.admin_operational_logs_action()}</label>
				<input id="action" class="form-input" bind:value={actionFilter} onchange={loadLogs} />
			</div>
			<div class="form-group">
				<label class="form-label" for="actor-id">{$LL.admin_operational_logs_actor_id()}</label>
				<input id="actor-id" class="form-input" bind:value={actorIdFilter} onchange={loadLogs} />
			</div>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<div class="panel">
		<div class="panel-header">
			<h2 class="panel-title">{$LL.admin_operational_logs_entries()}</h2>
			<span class="panel-meta">{$LL.admin_operational_logs_total_count({ count: total })}</span>
		</div>

		{#if loading}
			<div class="empty-state">{$LL.admin_operational_logs_loading()}</div>
		{:else if logs.length === 0}
			<div class="empty-state">{$LL.admin_operational_logs_empty()}</div>
		{:else}
			<div class="table-wrapper">
				<table class="data-table">
					<thead>
						<tr>
							<th>{$LL.admin_operational_logs_action()}</th>
							<th>{$LL.admin_operational_logs_subject()}</th>
							<th>{$LL.admin_operational_logs_actor()}</th>
							<th>{$LL.admin_operational_logs_created()}</th>
							<th>{$LL.admin_operational_logs_expires()}</th>
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
										{$LL.admin_operational_logs_view_detail()}
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

<Modal
	open={showDetailModal}
	onClose={closeDetail}
	title={$LL.admin_operational_logs_detail_title()}
	size="md"
>
	{#if detailLoading}
		<div class="empty-state">{$LL.admin_operational_logs_detail_loading()}</div>
	{:else if detailError}
		<div class="alert alert-error">{detailError}</div>
	{:else if selectedLog}
		<div class="detail-grid">
			<div>
				<strong>{$LL.admin_operational_logs_action()}</strong>
				<div>{selectedLog.action}</div>
			</div>
			<div>
				<strong>{$LL.admin_operational_logs_subject()}</strong>
				<div>{selectedLog.subject_type}:{selectedLog.subject_id}</div>
			</div>
			<div>
				<strong>{$LL.admin_operational_logs_actor()}</strong>
				<div>{selectedLog.actor_id}</div>
			</div>
			<div>
				<strong>{$LL.admin_operational_logs_request_id()}</strong>
				<div>{selectedLog.request_id ?? '-'}</div>
			</div>
			<div>
				<strong>{$LL.admin_operational_logs_created()}</strong>
				<div>{formatDateTime(selectedLog.created_at)}</div>
			</div>
			<div>
				<strong>{$LL.admin_operational_logs_expires()}</strong>
				<div>{formatDateTime(selectedLog.expires_at)}</div>
			</div>
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">{$LL.admin_operational_logs_reason_detail()}</h3>
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

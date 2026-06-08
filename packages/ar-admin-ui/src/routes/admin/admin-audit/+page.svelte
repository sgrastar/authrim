<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminAdminAuditAPI,
		type AdminAuditLogEntry,
		type AdminAuditLogListParams,
		type AdminAuditLogStats,
		getSeverityBadgeClass,
		getResultBadgeClass,
		formatAction
	} from '$lib/api/admin-admin-audit';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let entries: AdminAuditLogEntry[] = $state([]);
	let total = $state(0);
	let totalPages = $state(0);
	let loading = $state(true);
	let error = $state('');

	// Statistics
	let stats: AdminAuditLogStats | null = $state(null);
	let statsLoading = $state(false);
	let showStats = $state(true);

	// Filter state
	let adminUserIdFilter = $state('');
	let actionFilter = $state('');
	let resourceTypeFilter = $state('');
	let resultFilter = $state<'' | 'success' | 'failure'>('');
	let severityFilter = $state<'' | 'debug' | 'info' | 'warn' | 'error' | 'critical'>('');
	let startDate = $state('');
	let endDate = $state('');
	let currentPage = $state(1);
	const limit = 20;

	// Filter panel visibility
	let showFilters = $state(true);

	// Available actions and resource types (loaded dynamically)
	let availableActions: string[] = $state([]);
	let availableResourceTypes: string[] = $state([]);

	// Debounce timer
	let searchTimeout: ReturnType<typeof setTimeout>;

	// Detail modal
	let selectedEntry: AdminAuditLogEntry | null = $state(null);
	let showDetailModal = $state(false);
	let detailLoading = $state(false);
	let detailError = $state('');

	async function loadAuditLogs() {
		loading = true;
		error = '';

		try {
			const params: AdminAuditLogListParams = {
				page: currentPage,
				limit
			};

			if (adminUserIdFilter.trim()) {
				params.admin_user_id = adminUserIdFilter.trim();
			}
			if (actionFilter) {
				params.action = actionFilter;
			}
			if (resourceTypeFilter) {
				params.resource_type = resourceTypeFilter;
			}
			if (resultFilter) {
				params.result = resultFilter;
			}
			if (severityFilter) {
				params.severity = severityFilter;
			}
			if (startDate) {
				params.start_date = new Date(startDate).toISOString();
			}
			if (endDate) {
				const endDateParsed = Date.parse(endDate);
				params.end_date = new Date(endDateParsed + 86399999).toISOString();
			}

			const response = await adminAdminAuditAPI.list(params);
			entries = response.items;
			total = response.total;
			totalPages = response.totalPages;
		} catch (err) {
			console.error('Failed to load admin audit logs:', err);
			error = $LL.admin_admin_audit_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadFilterOptions() {
		try {
			const [actionsResponse, resourceTypesResponse] = await Promise.all([
				adminAdminAuditAPI.listActions(),
				adminAdminAuditAPI.listResourceTypes()
			]);
			availableActions = actionsResponse.items;
			availableResourceTypes = resourceTypesResponse.items;
		} catch (err) {
			console.error('Failed to load filter options:', err);
		}
	}

	async function loadStats() {
		statsLoading = true;
		try {
			stats = await adminAdminAuditAPI.getStats(7);
		} catch (err) {
			console.error('Failed to load stats:', err);
		} finally {
			statsLoading = false;
		}
	}

	onMount(() => {
		loadAuditLogs();
		loadFilterOptions();
		loadStats();
	});

	function handleSearchInput() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 1;
			loadAuditLogs();
		}, 300);
	}

	function handleFilterChange() {
		currentPage = 1;
		loadAuditLogs();
	}

	function clearFilters() {
		adminUserIdFilter = '';
		actionFilter = '';
		resourceTypeFilter = '';
		resultFilter = '';
		severityFilter = '';
		startDate = '';
		endDate = '';
		currentPage = 1;
		loadAuditLogs();
	}

	function goToPage(page: number) {
		currentPage = page;
		loadAuditLogs();
	}

	function formatDateTime(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}

	function truncateId(id: string | null, length: number = 8): string {
		if (!id) return '-';
		if (id.length <= length) return id;
		return id.substring(0, length) + '...';
	}

	function getActorType(entry: AdminAuditLogEntry): 'admin_user' | 'machine' | 'system' {
		if (entry.actor_type === 'machine' || entry.machine_principal_id) return 'machine';
		if (entry.actor_type === 'system' || entry.admin_user_id === 'system') return 'system';
		return 'admin_user';
	}

	function getActorLabel(entry: AdminAuditLogEntry): string {
		const actorType = getActorType(entry);
		if (actorType === 'machine') {
			return (
				entry.machine_client_id ||
				entry.actor_display_name ||
				entry.machine_principal_id ||
				$LL.admin_admin_audit_machine()
			);
		}
		if (actorType === 'system') return $LL.admin_admin_audit_system();
		return (
			entry.admin_email ||
			entry.admin_user_name ||
			entry.actor_display_name ||
			entry.admin_user_id ||
			'-'
		);
	}

	async function openDetail(entry: AdminAuditLogEntry) {
		selectedEntry = entry;
		showDetailModal = true;
		detailLoading = true;
		detailError = '';
		try {
			selectedEntry = await adminAdminAuditAPI.get(entry.id);
		} catch (err) {
			console.error('Failed to load admin audit log detail:', err);
			detailError = err instanceof Error ? err.message : $LL.admin_admin_audit_detail_load_failed();
		} finally {
			detailLoading = false;
		}
	}

	function closeDetailModal() {
		showDetailModal = false;
		selectedEntry = null;
		detailLoading = false;
		detailError = '';
	}

	function formatJsonForDisplay(data: Record<string, unknown> | null): string {
		if (!data) return '-';
		return JSON.stringify(data, null, 2);
	}

	function formatResult(result: AdminAuditLogEntry['result']) {
		return result === 'success' ? $LL.admin_admin_audit_success() : $LL.admin_admin_audit_failure();
	}

	function formatSeverity(severity: AdminAuditLogEntry['severity']) {
		switch (severity) {
			case 'debug':
				return $LL.admin_admin_audit_severity_debug();
			case 'info':
				return $LL.admin_admin_audit_severity_info();
			case 'warn':
				return $LL.admin_admin_audit_severity_warn();
			case 'error':
				return $LL.admin_admin_audit_severity_error();
			case 'critical':
				return $LL.admin_admin_audit_severity_critical();
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_admin_audit_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_admin_audit_title()}</h1>
			<p class="page-description">{$LL.admin_admin_audit_description()}</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={() => (showStats = !showStats)}>
				<i class={showStats ? 'i-ph-chart-bar-horizontal' : 'i-ph-chart-bar'}></i>
				{showStats ? $LL.admin_admin_audit_hide_stats() : $LL.admin_admin_audit_show_stats()}
			</button>
			<button class="btn btn-secondary" onclick={() => (showFilters = !showFilters)}>
				<i class={showFilters ? 'i-ph-funnel-simple-x' : 'i-ph-funnel-simple'}></i>
				{showFilters ? $LL.admin_admin_audit_hide_filters() : $LL.admin_admin_audit_show_filters()}
			</button>
		</div>
	</div>

	<!-- Statistics Panel -->
	{#if showStats}
		<div class="stats-grid">
			{#if statsLoading}
				<div class="stat-card">
					<div class="stat-loading">
						<i class="i-ph-circle-notch loading-spinner"></i>
					</div>
				</div>
			{:else if stats}
				<div class="stat-card">
					<div class="stat-value">{stats.total_entries.toLocaleString()}</div>
					<div class="stat-label">{$LL.admin_admin_audit_total_entries()}</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">{stats.recent_entries.toLocaleString()}</div>
					<div class="stat-label">
						{$LL.admin_admin_audit_last_days({ days: stats.time_range_days })}
					</div>
				</div>
				<div class="stat-card">
					<div class="stat-value stat-success">
						{stats.result_breakdown.success || 0}
					</div>
					<div class="stat-label">{$LL.admin_admin_audit_success()}</div>
				</div>
				<div class="stat-card">
					<div class="stat-value stat-danger">
						{stats.result_breakdown.failure || 0}
					</div>
					<div class="stat-label">{$LL.admin_admin_audit_failures()}</div>
				</div>
			{/if}
		</div>

		{#if stats && stats.top_actions.length > 0}
			<div class="panel">
				<h3 class="panel-title">{$LL.admin_admin_audit_top_actions()}</h3>
				<div class="top-actions-list">
					{#each stats.top_actions.slice(0, 5) as actionStat (actionStat.action)}
						<div class="top-action-item">
							<span class="action-name">{formatAction(actionStat.action)}</span>
							<span class="action-count">{actionStat.count}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	<!-- Filters -->
	{#if showFilters}
		<div class="panel">
			<div class="filter-row">
				<div class="form-group">
					<label for="admin_user_id" class="form-label">
						{$LL.admin_admin_audit_actor_filter()}
					</label>
					<input
						id="admin_user_id"
						type="text"
						class="form-input"
						placeholder={$LL.admin_admin_audit_actor_filter_placeholder()}
						bind:value={adminUserIdFilter}
						oninput={handleSearchInput}
					/>
				</div>

				<div class="form-group">
					<label for="action" class="form-label">{$LL.admin_admin_audit_action()}</label>
					<select
						id="action"
						class="form-select"
						bind:value={actionFilter}
						onchange={handleFilterChange}
					>
						<option value="">{$LL.admin_admin_audit_all_actions()}</option>
						{#each availableActions as action (action)}
							<option value={action}>{formatAction(action)}</option>
						{/each}
					</select>
				</div>

				<div class="form-group">
					<label for="resource_type" class="form-label">
						{$LL.admin_admin_audit_resource_type()}
					</label>
					<select
						id="resource_type"
						class="form-select"
						bind:value={resourceTypeFilter}
						onchange={handleFilterChange}
					>
						<option value="">{$LL.admin_admin_audit_all_types()}</option>
						{#each availableResourceTypes as resourceType (resourceType)}
							<option value={resourceType}>{resourceType}</option>
						{/each}
					</select>
				</div>
			</div>

			<div class="filter-row">
				<div class="form-group">
					<label for="result" class="form-label">{$LL.admin_admin_audit_result()}</label>
					<select
						id="result"
						class="form-select"
						bind:value={resultFilter}
						onchange={handleFilterChange}
					>
						<option value="">{$LL.admin_admin_audit_all_results()}</option>
						<option value="success">{$LL.admin_admin_audit_success()}</option>
						<option value="failure">{$LL.admin_admin_audit_failure()}</option>
					</select>
				</div>

				<div class="form-group">
					<label for="severity" class="form-label">{$LL.admin_admin_audit_severity()}</label>
					<select
						id="severity"
						class="form-select"
						bind:value={severityFilter}
						onchange={handleFilterChange}
					>
						<option value="">{$LL.admin_admin_audit_all_severities()}</option>
						<option value="debug">{$LL.admin_admin_audit_severity_debug()}</option>
						<option value="info">{$LL.admin_admin_audit_severity_info()}</option>
						<option value="warn">{$LL.admin_admin_audit_severity_warn()}</option>
						<option value="error">{$LL.admin_admin_audit_severity_error()}</option>
						<option value="critical">{$LL.admin_admin_audit_severity_critical()}</option>
					</select>
				</div>

				<div class="form-group">
					<label for="start_date" class="form-label">{$LL.admin_admin_audit_start_date()}</label>
					<input
						id="start_date"
						type="date"
						class="form-input"
						bind:value={startDate}
						onchange={handleFilterChange}
					/>
				</div>

				<div class="form-group">
					<label for="end_date" class="form-label">{$LL.admin_admin_audit_end_date()}</label>
					<input
						id="end_date"
						type="date"
						class="form-input"
						bind:value={endDate}
						onchange={handleFilterChange}
					/>
				</div>
			</div>

			<div class="filter-actions">
				<button class="btn btn-secondary" onclick={clearFilters}>
					<i class="i-ph-x"></i>
					{$LL.admin_admin_audit_clear_filters()}
				</button>
			</div>

			<p class="filter-hint">
				{$LL.admin_admin_audit_filter_hint()}
			</p>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_admin_audit_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if entries.length === 0}
		<div class="panel">
			<div class="empty-state">
				<i class="i-ph-clipboard-text empty-state-icon"></i>
				<p class="empty-state-description">{$LL.admin_admin_audit_empty()}</p>
				{#if adminUserIdFilter || actionFilter || resourceTypeFilter || resultFilter || severityFilter || startDate || endDate}
					<button class="btn btn-secondary" onclick={clearFilters}>
						{$LL.admin_admin_audit_clear_filters()}
					</button>
				{/if}
			</div>
		</div>
	{:else}
		<!-- Audit Logs Table -->
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_admin_audit_date_time()}</th>
						<th>{$LL.admin_admin_audit_action()}</th>
						<th>{$LL.admin_admin_audit_actor()}</th>
						<th>{$LL.admin_admin_audit_resource()}</th>
						<th>{$LL.admin_admin_audit_result()}</th>
						<th>{$LL.admin_admin_audit_severity()}</th>
						<th>{$LL.admin_admin_audit_ip_address()}</th>
					</tr>
				</thead>
				<tbody>
					{#each entries as entry (entry.id)}
						<tr
							onclick={() => openDetail(entry)}
							onkeydown={(e) => e.key === 'Enter' && openDetail(entry)}
							tabindex="0"
							role="button"
						>
							<td class="muted nowrap">{formatDateTime(entry.created_at)}</td>
							<td>
								<span class="badge badge-info">{formatAction(entry.action)}</span>
							</td>
							<td>
								{#if getActorType(entry) === 'machine'}
									<span class="cell-primary">{getActorLabel(entry)}</span>
									<span class="cell-secondary mono"
										>{truncateId(entry.machine_principal_id || entry.actor_id || null)}</span
									>
								{:else if getActorType(entry) === 'admin_user'}
									<span class="cell-primary">{getActorLabel(entry)}</span>
								{:else}
									<span class="muted">{$LL.admin_admin_audit_system()}</span>
								{/if}
							</td>
							<td class="muted">
								{#if entry.resource_type}
									<span class="cell-primary">{entry.resource_type}</span>
									{#if entry.resource_id}
										<span class="mono cell-secondary">({truncateId(entry.resource_id)})</span>
									{/if}
								{:else}
									-
								{/if}
							</td>
							<td>
								<span class={getResultBadgeClass(entry.result)}>{formatResult(entry.result)}</span>
							</td>
							<td>
								<span class={getSeverityBadgeClass(entry.severity)}>
									{formatSeverity(entry.severity)}
								</span>
							</td>
							<td class="muted">{entry.ip_address || '-'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="pagination">
				<p class="pagination-info">
					{$LL.admin_admin_audit_pagination({
						start: (currentPage - 1) * limit + 1,
						end: Math.min(currentPage * limit, total),
						total
					})}
				</p>
				<div class="pagination-buttons">
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage - 1)}
						disabled={currentPage <= 1}
					>
						{$LL.admin_admin_audit_previous()}
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage + 1)}
						disabled={currentPage >= totalPages}
					>
						{$LL.admin_admin_audit_next()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Detail Modal -->
<Modal
	open={showDetailModal && !!selectedEntry}
	onClose={closeDetailModal}
	title={$LL.admin_admin_audit_detail_title()}
	size="lg"
>
	{#if detailLoading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_admin_audit_loading_detail()}</p>
		</div>
	{:else if detailError}
		<div class="alert alert-error">{detailError}</div>
	{:else if selectedEntry}
		<div class="detail-grid">
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_id()}</span>
				<span class="detail-value mono">{selectedEntry.id}</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_date_time()}</span>
				<span class="detail-value">{formatDateTime(selectedEntry.created_at)}</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_action()}</span>
				<span class="detail-value">
					<span class="badge badge-info">{formatAction(selectedEntry.action)}</span>
				</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_result()}</span>
				<span class="detail-value">
					<span class={getResultBadgeClass(selectedEntry.result)}>
						{formatResult(selectedEntry.result)}
					</span>
				</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_severity()}</span>
				<span class="detail-value">
					<span class={getSeverityBadgeClass(selectedEntry.severity)}
						>{formatSeverity(selectedEntry.severity)}</span
					>
				</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_actor()}</span>
				<span class="detail-value">
					{#if getActorType(selectedEntry) === 'machine'}
						{getActorLabel(selectedEntry)}
						<span class="muted">({selectedEntry.machine_principal_type || 'machine'})</span>
					{:else if getActorType(selectedEntry) === 'admin_user'}
						{getActorLabel(selectedEntry)}
					{:else}
						<span class="muted">{$LL.admin_admin_audit_system()}</span>
					{/if}
				</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_admin_user_id()}</span>
				<span class="detail-value mono">{selectedEntry.admin_user_id || '-'}</span>
			</div>
			{#if getActorType(selectedEntry) === 'machine'}
				<div class="detail-item">
					<span class="detail-label">{$LL.admin_admin_audit_machine_principal_id()}</span>
					<span class="detail-value mono"
						>{selectedEntry.machine_principal_id || selectedEntry.actor_id || '-'}</span
					>
				</div>
				<div class="detail-item">
					<span class="detail-label">{$LL.admin_admin_audit_machine_credential_id()}</span>
					<span class="detail-value mono">{selectedEntry.machine_credential_id || '-'}</span>
				</div>
				<div class="detail-item">
					<span class="detail-label">{$LL.admin_admin_audit_machine_client_id()}</span>
					<span class="detail-value mono">{selectedEntry.machine_client_id || '-'}</span>
				</div>
				<div class="detail-item">
					<span class="detail-label">{$LL.admin_admin_audit_machine_client_auth()}</span>
					<span class="detail-value">{selectedEntry.machine_client_auth_method || '-'}</span>
				</div>
			{/if}
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_resource_type()}</span>
				<span class="detail-value">{selectedEntry.resource_type || '-'}</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_resource_id()}</span>
				<span class="detail-value mono">{selectedEntry.resource_id || '-'}</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_ip_address()}</span>
				<span class="detail-value">{selectedEntry.ip_address || '-'}</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_user_agent()}</span>
				<span class="detail-value text-small">{selectedEntry.user_agent || '-'}</span>
			</div>
			<div class="detail-item">
				<span class="detail-label">{$LL.admin_admin_audit_request_id()}</span>
				<span class="detail-value mono">{selectedEntry.request_id || '-'}</span>
			</div>
		</div>

		{#if selectedEntry.before || selectedEntry.after}
			<div class="detail-section">
				<h3 class="detail-section-title">{$LL.admin_admin_audit_change_details()}</h3>
				<div class="change-details">
					{#if selectedEntry.before}
						<div class="change-block">
							<h4 class="change-block-title">{$LL.admin_admin_audit_before()}</h4>
							<pre class="code-block">{formatJsonForDisplay(selectedEntry.before)}</pre>
						</div>
					{/if}
					{#if selectedEntry.after}
						<div class="change-block">
							<h4 class="change-block-title">{$LL.admin_admin_audit_after()}</h4>
							<pre class="code-block">{formatJsonForDisplay(selectedEntry.after)}</pre>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		{#if selectedEntry.metadata}
			<div class="detail-section">
				<h3 class="detail-section-title">{$LL.admin_admin_audit_additional_metadata()}</h3>
				<pre class="code-block">{formatJsonForDisplay(selectedEntry.metadata)}</pre>
			</div>
		{/if}
	{/if}
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDetailModal}>
			{$LL.admin_admin_audit_close()}
		</button>
	{/snippet}
</Modal>

<style>
	/* Page-specific styles for Admin Audit */

	/* Stats Grid */
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.stat-card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 1.25rem;
		text-align: center;
	}

	.stat-value {
		font-size: 2rem;
		font-weight: 700;
		color: var(--text-primary);
		line-height: 1.2;
	}

	.stat-value.stat-success {
		color: var(--success);
	}

	.stat-value.stat-danger {
		color: var(--danger);
	}

	.stat-label {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin-top: 0.25rem;
	}

	.stat-loading {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 60px;
	}

	/* Top Actions List */
	.panel-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-secondary);
		margin-bottom: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.top-actions-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.top-action-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border);
	}

	.top-action-item:last-child {
		border-bottom: none;
	}

	.action-name {
		color: var(--text-primary);
	}

	.action-count {
		font-weight: 600;
		color: var(--text-secondary);
		background: var(--bg-subtle);
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-sm);
		font-size: 0.875rem;
	}

	/* Filter Actions */
	.filter-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	/* Detail Grid (for modal) */
	.detail-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1rem;
	}

	.detail-item {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.detail-label {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.detail-value {
		color: var(--text-primary);
	}

	.text-small {
		font-size: 0.875rem;
		word-break: break-all;
	}

	/* Detail Sections */
	.detail-section {
		margin-top: 1.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}

	.detail-section-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-secondary);
		margin-bottom: 1rem;
	}

	.change-details {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 1rem;
	}

	.change-block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.change-block-title {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
	}

	.code-block {
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 1rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Empty State Icon */
	.empty-state-icon {
		font-size: 3rem;
		color: var(--text-secondary);
		margin-bottom: 1rem;
	}

	/* Responsive */
	@media (max-width: 768px) {
		.stats-grid {
			grid-template-columns: repeat(2, 1fr);
		}

		.detail-grid {
			grid-template-columns: 1fr;
		}

		.change-details {
			grid-template-columns: 1fr;
		}
	}
</style>

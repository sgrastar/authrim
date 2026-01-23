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
			error = 'Failed to load admin audit logs';
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

	function openDetail(entry: AdminAuditLogEntry) {
		selectedEntry = entry;
		showDetailModal = true;
	}

	function closeDetailModal() {
		showDetailModal = false;
		selectedEntry = null;
	}

	function formatJsonForDisplay(data: Record<string, unknown> | null): string {
		if (!data) return '-';
		return JSON.stringify(data, null, 2);
	}
</script>

<svelte:head>
	<title>Admin Audit Logs - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Admin Audit Logs</h1>
			<p class="page-description">View administrator activity and security events</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={() => (showStats = !showStats)}>
				<i class={showStats ? 'i-ph-chart-bar-horizontal' : 'i-ph-chart-bar'}></i>
				{showStats ? 'Hide Stats' : 'Show Stats'}
			</button>
			<button class="btn btn-secondary" onclick={() => (showFilters = !showFilters)}>
				<i class={showFilters ? 'i-ph-funnel-simple-x' : 'i-ph-funnel-simple'}></i>
				{showFilters ? 'Hide Filters' : 'Show Filters'}
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
					<div class="stat-label">Total Entries</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">{stats.recent_entries.toLocaleString()}</div>
					<div class="stat-label">Last {stats.time_range_days} Days</div>
				</div>
				<div class="stat-card">
					<div class="stat-value stat-success">
						{stats.result_breakdown.success || 0}
					</div>
					<div class="stat-label">Success</div>
				</div>
				<div class="stat-card">
					<div class="stat-value stat-danger">
						{stats.result_breakdown.failure || 0}
					</div>
					<div class="stat-label">Failures</div>
				</div>
			{/if}
		</div>

		{#if stats && stats.top_actions.length > 0}
			<div class="panel">
				<h3 class="panel-title">Top Actions (Last 7 Days)</h3>
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
					<label for="admin_user_id" class="form-label">Admin User ID</label>
					<input
						id="admin_user_id"
						type="text"
						class="form-input"
						placeholder="Filter by admin user ID..."
						bind:value={adminUserIdFilter}
						oninput={handleSearchInput}
					/>
				</div>

				<div class="form-group">
					<label for="action" class="form-label">Action</label>
					<select
						id="action"
						class="form-select"
						bind:value={actionFilter}
						onchange={handleFilterChange}
					>
						<option value="">All Actions</option>
						{#each availableActions as action (action)}
							<option value={action}>{formatAction(action)}</option>
						{/each}
					</select>
				</div>

				<div class="form-group">
					<label for="resource_type" class="form-label">Resource Type</label>
					<select
						id="resource_type"
						class="form-select"
						bind:value={resourceTypeFilter}
						onchange={handleFilterChange}
					>
						<option value="">All Types</option>
						{#each availableResourceTypes as resourceType (resourceType)}
							<option value={resourceType}>{resourceType}</option>
						{/each}
					</select>
				</div>
			</div>

			<div class="filter-row">
				<div class="form-group">
					<label for="result" class="form-label">Result</label>
					<select
						id="result"
						class="form-select"
						bind:value={resultFilter}
						onchange={handleFilterChange}
					>
						<option value="">All Results</option>
						<option value="success">Success</option>
						<option value="failure">Failure</option>
					</select>
				</div>

				<div class="form-group">
					<label for="severity" class="form-label">Severity</label>
					<select
						id="severity"
						class="form-select"
						bind:value={severityFilter}
						onchange={handleFilterChange}
					>
						<option value="">All Severities</option>
						<option value="debug">Debug</option>
						<option value="info">Info</option>
						<option value="warn">Warning</option>
						<option value="error">Error</option>
						<option value="critical">Critical</option>
					</select>
				</div>

				<div class="form-group">
					<label for="start_date" class="form-label">Start Date</label>
					<input
						id="start_date"
						type="date"
						class="form-input"
						bind:value={startDate}
						onchange={handleFilterChange}
					/>
				</div>

				<div class="form-group">
					<label for="end_date" class="form-label">End Date</label>
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
					Clear Filters
				</button>
			</div>

			<p class="filter-hint">
				Tip: Use date and severity filters to narrow down large result sets for better performance.
			</p>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading admin audit logs...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if entries.length === 0}
		<div class="panel">
			<div class="empty-state">
				<i class="i-ph-clipboard-text empty-state-icon"></i>
				<p class="empty-state-description">No admin audit log entries found</p>
				{#if adminUserIdFilter || actionFilter || resourceTypeFilter || resultFilter || severityFilter || startDate || endDate}
					<button class="btn btn-secondary" onclick={clearFilters}>Clear Filters</button>
				{/if}
			</div>
		</div>
	{:else}
		<!-- Audit Logs Table -->
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Date/Time</th>
						<th>Action</th>
						<th>Admin</th>
						<th>Resource</th>
						<th>Result</th>
						<th>Severity</th>
						<th>IP Address</th>
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
								{#if entry.admin_email}
									<span class="cell-primary">{entry.admin_email}</span>
								{:else if entry.admin_user_id}
									<span class="mono">{truncateId(entry.admin_user_id)}</span>
								{:else}
									<span class="muted">System</span>
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
								<span class={getResultBadgeClass(entry.result)}>{entry.result}</span>
							</td>
							<td>
								<span class={getSeverityBadgeClass(entry.severity)}>{entry.severity}</span>
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
					Showing {(currentPage - 1) * limit + 1} to {Math.min(currentPage * limit, total)} of {total}
					entries
				</p>
				<div class="pagination-buttons">
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage - 1)}
						disabled={currentPage <= 1}
					>
						Previous
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage + 1)}
						disabled={currentPage >= totalPages}
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Detail Modal -->
{#if showDetailModal && selectedEntry}
	<div
		class="modal-overlay"
		onclick={closeDetailModal}
		onkeydown={(e) => e.key === 'Escape' && closeDetailModal()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div class="modal modal-lg" onclick={(e) => e.stopPropagation()} role="document">
			<div class="modal-header">
				<h2 class="modal-title">Audit Log Entry Details</h2>
				<button class="modal-close" onclick={closeDetailModal}>
					<i class="i-ph-x"></i>
				</button>
			</div>
			<div class="modal-body">
				<div class="detail-grid">
					<div class="detail-item">
						<span class="detail-label">ID</span>
						<span class="detail-value mono">{selectedEntry.id}</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Date/Time</span>
						<span class="detail-value">{formatDateTime(selectedEntry.created_at)}</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Action</span>
						<span class="detail-value">
							<span class="badge badge-info">{formatAction(selectedEntry.action)}</span>
						</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Result</span>
						<span class="detail-value">
							<span class={getResultBadgeClass(selectedEntry.result)}>{selectedEntry.result}</span>
						</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Severity</span>
						<span class="detail-value">
							<span class={getSeverityBadgeClass(selectedEntry.severity)}
								>{selectedEntry.severity}</span
							>
						</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Admin User</span>
						<span class="detail-value">
							{#if selectedEntry.admin_email}
								{selectedEntry.admin_email}
							{:else if selectedEntry.admin_user_id}
								<span class="mono">{selectedEntry.admin_user_id}</span>
							{:else}
								<span class="muted">System</span>
							{/if}
						</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Admin User ID</span>
						<span class="detail-value mono">{selectedEntry.admin_user_id || '-'}</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Resource Type</span>
						<span class="detail-value">{selectedEntry.resource_type || '-'}</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Resource ID</span>
						<span class="detail-value mono">{selectedEntry.resource_id || '-'}</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">IP Address</span>
						<span class="detail-value">{selectedEntry.ip_address || '-'}</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">User Agent</span>
						<span class="detail-value text-small">{selectedEntry.user_agent || '-'}</span>
					</div>
					<div class="detail-item">
						<span class="detail-label">Request ID</span>
						<span class="detail-value mono">{selectedEntry.request_id || '-'}</span>
					</div>
				</div>

				{#if selectedEntry.before || selectedEntry.after}
					<div class="detail-section">
						<h3 class="detail-section-title">Change Details</h3>
						<div class="change-details">
							{#if selectedEntry.before}
								<div class="change-block">
									<h4 class="change-block-title">Before</h4>
									<pre class="code-block">{formatJsonForDisplay(selectedEntry.before)}</pre>
								</div>
							{/if}
							{#if selectedEntry.after}
								<div class="change-block">
									<h4 class="change-block-title">After</h4>
									<pre class="code-block">{formatJsonForDisplay(selectedEntry.after)}</pre>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				{#if selectedEntry.metadata}
					<div class="detail-section">
						<h3 class="detail-section-title">Additional Metadata</h3>
						<pre class="code-block">{formatJsonForDisplay(selectedEntry.metadata)}</pre>
					</div>
				{/if}
			</div>
			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeDetailModal}>Close</button>
			</div>
		</div>
	</div>
{/if}

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

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminAuditLogsAPI,
		type AuditLogEntry,
		type Pagination,
		type AuditLogListParams,
		AUDIT_ACTION_TYPES
	} from '$lib/api/admin-audit-logs';

	let entries: AuditLogEntry[] = $state([]);
	let pagination: Pagination | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Filter state
	let userIdFilter = $state('');
	let actionFilter = $state('');
	let startDate = $state('');
	let endDate = $state('');
	let currentPage = $state(1);
	const limit = 20;

	// Filter panel visibility
	let showFilters = $state(true);

	// Debounce timer for user ID search
	let searchTimeout: ReturnType<typeof setTimeout>;

	async function loadAuditLogs() {
		loading = true;
		error = '';

		try {
			const params: AuditLogListParams = {
				page: currentPage,
				limit
			};

			if (userIdFilter.trim()) {
				params.user_id = userIdFilter.trim();
			}
			if (actionFilter) {
				params.action = actionFilter;
			}
			if (startDate) {
				params.start_date = new Date(startDate).toISOString();
			}
			if (endDate) {
				// Set end date to end of day using timestamp calculation to avoid mutating Date
				const endDateParsed = Date.parse(endDate);
				// Add 23:59:59.999 worth of milliseconds (86399999 ms)
				params.end_date = new Date(endDateParsed + 86399999).toISOString();
			}

			const response = await adminAuditLogsAPI.list(params);
			entries = response.entries;
			pagination = response.pagination;
		} catch (err) {
			console.error('Failed to load audit logs:', err);
			error = 'Failed to load audit logs';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadAuditLogs();
	});

	function handleUserIdSearch() {
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
		userIdFilter = '';
		actionFilter = '';
		startDate = '';
		endDate = '';
		currentPage = 1;
		loadAuditLogs();
	}

	function goToPage(page: number) {
		currentPage = page;
		loadAuditLogs();
	}

	function formatDateTime(isoString: string): string {
		return new Date(isoString).toLocaleString();
	}

	function formatAction(action: string): string {
		// Convert action.name format to readable format
		return action
			.split('.')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function getActionBadgeClass(action: string): string {
		// Critical/Danger actions (red)
		if (
			action.includes('delete') ||
			action.includes('revoke') ||
			action.includes('emergency') ||
			action.includes('failed') ||
			action.includes('anonymize')
		) {
			return 'badge badge-danger';
		}
		// Success/Create/Login actions (green)
		if (action.includes('create') || action.includes('queued') || action.includes('login')) {
			return 'badge badge-success';
		}
		// Logout actions (light cyan/teal)
		if (action.includes('logout')) {
			return 'badge badge-info';
		}
		// Update/Change actions (blue)
		if (
			action.includes('update') ||
			action.includes('rotate') ||
			action.includes('regenerate') ||
			action.includes('replay') ||
			action.includes('cloned')
		) {
			return 'badge badge-info';
		}
		// Warning actions (amber)
		if (
			action.includes('suspend') ||
			action.includes('lock') ||
			action.includes('alert') ||
			action.includes('acknowledge')
		) {
			return 'badge badge-warning';
		}
		// Info/Read actions (purple)
		if (action.includes('read') || action.includes('check') || action.includes('test')) {
			return 'badge badge-neutral';
		}
		// Default (gray)
		return 'badge badge-neutral';
	}

	function truncateId(id: string | null, length: number = 8): string {
		if (!id) return '-';
		if (id.length <= length) return id;
		return id.substring(0, length) + '...';
	}
</script>

<svelte:head>
	<title>Audit Logs - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Audit Logs</h1>
			<p class="page-description">View system activity and security events</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={() => (showFilters = !showFilters)}>
				<i class={showFilters ? 'i-ph-funnel-simple-x' : 'i-ph-funnel-simple'}></i>
				{showFilters ? 'Hide Filters' : 'Show Filters'}
			</button>
		</div>
	</div>

	<!-- Filters -->
	{#if showFilters}
		<div class="panel">
			<div class="filter-row">
				<div class="form-group">
					<label for="user_id" class="form-label">Actor User ID</label>
					<input
						id="user_id"
						type="text"
						class="form-input"
						placeholder="Filter by user ID..."
						bind:value={userIdFilter}
						oninput={handleUserIdSearch}
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
						{#each AUDIT_ACTION_TYPES as actionType (actionType.value)}
							<option value={actionType.value}>{actionType.label}</option>
						{/each}
					</select>
				</div>
			</div>

			<div class="filter-row">
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

				<div class="form-group form-group-action">
					<button class="btn btn-secondary" onclick={clearFilters}>
						<i class="i-ph-x"></i>
						Clear Filters
					</button>
				</div>
			</div>

			<p class="filter-hint">
				Tip: Use date filters to narrow down large result sets for better performance.
			</p>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading audit logs...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if entries.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No audit log entries found</p>
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
						<th>Actor</th>
						<th>Resource</th>
						<th>IP Address</th>
					</tr>
				</thead>
				<tbody>
					{#each entries as entry (entry.id)}
						<tr
							onclick={() => goto(`/admin/audit-logs/${entry.id}`)}
							onkeydown={(e) => e.key === 'Enter' && goto(`/admin/audit-logs/${entry.id}`)}
							tabindex="0"
							role="button"
						>
							<td class="muted nowrap">{formatDateTime(entry.createdAt)}</td>
							<td>
								<span class={getActionBadgeClass(entry.action)}>
									{formatAction(entry.action)}
								</span>
							</td>
							<td class="mono">{truncateId(entry.userId)}</td>
							<td class="muted">
								{#if entry.resourceType}
									<span class="cell-primary">{entry.resourceType}</span>
									{#if entry.resourceId}
										<span class="mono cell-secondary">({truncateId(entry.resourceId)})</span>
									{/if}
								{:else}
									-
								{/if}
							</td>
							<td class="muted">{entry.ipAddress || '-'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if pagination && pagination.totalPages > 1}
			<div class="pagination">
				<p class="pagination-info">
					Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(
						pagination.page * pagination.limit,
						pagination.total
					)} of {pagination.total} entries
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
						disabled={currentPage >= pagination.totalPages}
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

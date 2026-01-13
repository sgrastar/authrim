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

	function getActionBadgeStyle(action: string): string {
		if (action.includes('delete') || action.includes('revoke')) {
			return 'background-color: #fee2e2; color: #991b1b;';
		}
		if (action.includes('create')) {
			return 'background-color: #d1fae5; color: #065f46;';
		}
		if (action.includes('update') || action.includes('rotate')) {
			return 'background-color: #dbeafe; color: #1e40af;';
		}
		if (action.includes('suspend') || action.includes('lock')) {
			return 'background-color: #fef3c7; color: #92400e;';
		}
		return 'background-color: #e5e7eb; color: #374151;';
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

<div>
	<div
		style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;"
	>
		<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0;">Audit Logs</h1>
		<button
			onclick={() => (showFilters = !showFilters)}
			style="
				padding: 8px 16px;
				background-color: white;
				border: 1px solid #d1d5db;
				border-radius: 4px;
				font-size: 14px;
				cursor: pointer;
				color: #374151;
			"
		>
			{showFilters ? 'Hide Filters' : 'Show Filters'}
		</button>
	</div>

	<!-- Filters -->
	{#if showFilters}
		<div
			style="background-color: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
		>
			<div style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px;">
				<!-- User ID -->
				<div style="flex: 1; min-width: 200px;">
					<label
						for="user_id"
						style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Actor User ID</label
					>
					<input
						id="user_id"
						type="text"
						placeholder="Filter by user ID..."
						bind:value={userIdFilter}
						oninput={handleUserIdSearch}
						style="
							width: 100%;
							padding: 8px 12px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							font-size: 14px;
							box-sizing: border-box;
						"
					/>
				</div>

				<!-- Action Filter -->
				<div style="min-width: 200px;">
					<label
						for="action"
						style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Action</label
					>
					<select
						id="action"
						bind:value={actionFilter}
						onchange={handleFilterChange}
						style="
							width: 100%;
							padding: 8px 12px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							font-size: 14px;
							background-color: white;
						"
					>
						<option value="">All Actions</option>
						{#each AUDIT_ACTION_TYPES as actionType (actionType.value)}
							<option value={actionType.value}>{actionType.label}</option>
						{/each}
					</select>
				</div>
			</div>

			<div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end;">
				<!-- Start Date -->
				<div style="min-width: 180px;">
					<label
						for="start_date"
						style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Start Date</label
					>
					<input
						id="start_date"
						type="date"
						bind:value={startDate}
						onchange={handleFilterChange}
						style="
							width: 100%;
							padding: 8px 12px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							font-size: 14px;
						"
					/>
				</div>

				<!-- End Date -->
				<div style="min-width: 180px;">
					<label
						for="end_date"
						style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>End Date</label
					>
					<input
						id="end_date"
						type="date"
						bind:value={endDate}
						onchange={handleFilterChange}
						style="
							width: 100%;
							padding: 8px 12px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							font-size: 14px;
						"
					/>
				</div>

				<!-- Clear Filters -->
				<button
					onclick={clearFilters}
					style="
						padding: 8px 16px;
						background-color: #f3f4f6;
						border: 1px solid #d1d5db;
						border-radius: 4px;
						font-size: 14px;
						cursor: pointer;
						color: #374151;
					"
				>
					Clear Filters
				</button>
			</div>

			<p style="font-size: 12px; color: #9ca3af; margin-top: 12px; margin-bottom: 0;">
				Tip: Use date filters to narrow down large result sets for better performance.
			</p>
		</div>
	{/if}

	{#if loading}
		<p style="color: #6b7280; text-align: center; padding: 40px;">Loading audit logs...</p>
	{:else if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;"
		>
			{error}
		</div>
	{:else if entries.length === 0}
		<div
			style="background-color: white; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center;"
		>
			<p style="color: #9ca3af; margin: 0;">No audit log entries found</p>
		</div>
	{:else}
		<!-- Audit Logs Table -->
		<div
			style="background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden;"
		>
			<table style="width: 100%; border-collapse: collapse;">
				<thead>
					<tr style="background-color: #f9fafb; border-bottom: 1px solid #e5e7eb;">
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Date/Time</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Action</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Actor</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Resource</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>IP Address</th
						>
					</tr>
				</thead>
				<tbody>
					{#each entries as entry (entry.id)}
						<tr
							style="border-bottom: 1px solid #e5e7eb; cursor: pointer;"
							onclick={() => goto(`/admin/audit-logs/${entry.id}`)}
							onkeydown={(e) => e.key === 'Enter' && goto(`/admin/audit-logs/${entry.id}`)}
							tabindex="0"
							role="button"
						>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280; white-space: nowrap;">
								{formatDateTime(entry.createdAt)}
							</td>
							<td style="padding: 12px 16px;">
								<span
									style="
									display: inline-block;
									padding: 2px 8px;
									border-radius: 12px;
									font-size: 12px;
									font-weight: 500;
									{getActionBadgeStyle(entry.action)}
								"
								>
									{formatAction(entry.action)}
								</span>
							</td>
							<td
								style="padding: 12px 16px; font-size: 14px; color: #1f2937; font-family: monospace;"
							>
								{truncateId(entry.userId)}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{#if entry.resourceType}
									<span style="color: #374151;">{entry.resourceType}</span>
									{#if entry.resourceId}
										<span style="font-family: monospace; font-size: 12px;">
											({truncateId(entry.resourceId)})
										</span>
									{/if}
								{:else}
									-
								{/if}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{entry.ipAddress || '-'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if pagination && pagination.totalPages > 1}
			<div
				style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding: 0 4px;"
			>
				<p style="color: #6b7280; font-size: 14px; margin: 0;">
					Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(
						pagination.page * pagination.limit,
						pagination.total
					)} of {pagination.total} entries
				</p>
				<div style="display: flex; gap: 8px;">
					<button
						onclick={() => goToPage(currentPage - 1)}
						disabled={currentPage <= 1}
						style="
							padding: 8px 16px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							background-color: white;
							color: {currentPage > 1 ? '#374151' : '#9ca3af'};
							cursor: {currentPage > 1 ? 'pointer' : 'not-allowed'};
							font-size: 14px;
						"
					>
						Previous
					</button>
					<button
						onclick={() => goToPage(currentPage + 1)}
						disabled={currentPage >= pagination.totalPages}
						style="
							padding: 8px 16px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							background-color: white;
							color: {currentPage < pagination.totalPages ? '#374151' : '#9ca3af'};
							cursor: {currentPage < pagination.totalPages ? 'pointer' : 'not-allowed'};
							font-size: 14px;
						"
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

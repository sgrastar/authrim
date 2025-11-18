<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Card, Button } from '$lib/components';
	import { onMount } from 'svelte';
	import { adminAuditLogAPI } from '$lib/api/client';

	interface AuditLogEntry {
		id: string;
		userId?: string;
		user?: {
			id: string;
			email: string;
			name?: string;
			picture?: string;
		};
		action: string;
		resourceType?: string;
		resourceId?: string;
		ipAddress?: string;
		userAgent?: string;
		metadata?: Record<string, unknown>;
		createdAt: string;
	}

	let logs: AuditLogEntry[] = [];
	let loading = true;
	let error = '';
	let filterAction = 'all';
	let filterResourceType = 'all';
	let currentPage = 1;
	let totalPages = 1;
	let totalCount = 0;
	const itemsPerPage = 50;

	// Date range filter
	let startDate = '';
	let endDate = '';

	const actionTypes = [
		'user.created',
		'user.updated',
		'user.deleted',
		'user.login',
		'user.logout',
		'client.created',
		'client.updated',
		'client.deleted',
		'token.issued',
		'token.revoked'
	];

	const resourceTypes = ['user', 'client', 'token', 'session'];

	onMount(async () => {
		// Set default date range (last 7 days)
		const nowTime = Date.now();
		const now = new Date(nowTime);
		endDate = now.toISOString().split('T')[0];
		const weekAgo = new Date(nowTime - 7 * 86400000);
		startDate = weekAgo.toISOString().split('T')[0];

		await loadLogs();
	});

	async function loadLogs() {
		loading = true;
		error = '';

		try {
			// Build API params
			const params: {
				page: number;
				limit: number;
				action?: string;
				resource_type?: string;
				start_date?: string;
				end_date?: string;
			} = {
				page: currentPage,
				limit: itemsPerPage
			};

			if (filterAction !== 'all') {
				params.action = filterAction;
			}

			if (filterResourceType !== 'all') {
				params.resource_type = filterResourceType;
			}

			if (startDate) {
				params.start_date = new Date(startDate).toISOString();
			}

			if (endDate) {
				// Set to end of day (23:59:59.999Z)
				params.end_date = `${endDate}T23:59:59.999Z`;
			}

			// Call API
			const { data, error: apiError } = await adminAuditLogAPI.list(params);

			if (apiError) {
				error = apiError.error_description || 'Failed to load audit logs';
				console.error('Failed to load audit logs:', apiError);
			} else if (data) {
				logs = data.entries;
				totalCount = data.pagination.total;
				totalPages = data.pagination.totalPages;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error loading audit logs:', err);
		} finally {
			loading = false;
		}
	}

	function handleSearch() {
		currentPage = 1;
		loadLogs();
	}

	function formatTimestamp(dateString: string): string {
		return new Date(dateString).toLocaleString();
	}

	function nextPage() {
		if (currentPage < totalPages) {
			currentPage++;
			loadLogs();
		}
	}

	function prevPage() {
		if (currentPage > 1) {
			currentPage--;
			loadLogs();
		}
	}

	async function handleExportCSV() {
		// In real implementation, would generate CSV and trigger download
		alert('CSV export will be implemented with actual API integration');
	}

	async function handleExportJSON() {
		// In real implementation, would generate JSON and trigger download
		alert('JSON export will be implemented with actual API integration');
	}
</script>

<svelte:head>
	<title>{m.admin_audit_title()} - {m.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
				{m.admin_audit_title()}
			</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				View and export system audit logs
			</p>
		</div>
		<div class="flex gap-2">
			<Button variant="secondary" onclick={handleExportCSV}>
				<div class="i-heroicons-arrow-down-tray h-4 w-4"></div>
				Export CSV
			</Button>
			<Button variant="secondary" onclick={handleExportJSON}>
				<div class="i-heroicons-arrow-down-tray h-4 w-4"></div>
				Export JSON
			</Button>
		</div>
	</div>

	<!-- Filters -->
	<Card>
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
			<!-- Action filter -->
			<div>
				<label for="filter-action" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
					Action
				</label>
				<select
				id="filter-action"
					bind:value={filterAction}
					onchange={handleSearch}
					class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
				>
					<option value="all">All Actions</option>
					{#each actionTypes as action (action)}
						<option value={action}>{action}</option>
					{/each}
				</select>
			</div>

			<!-- Resource Type filter -->
			<div>
				<label for="filter-action" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
					Resource Type
				</label>
				<select
					bind:value={filterResourceType}
					onchange={handleSearch}
					class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
				>
					<option value="all">All Types</option>
					{#each resourceTypes as type (type)}
						<option value={type}>{type}</option>
					{/each}
				</select>
			</div>

			<!-- Date range -->
			<div>
				<label for="filter-action" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
					Start Date
				</label>
				<input
					type="date"
					bind:value={startDate}
					onchange={handleSearch}
					class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
				/>
			</div>
			<div>
				<label for="filter-action" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
					End Date
				</label>
				<input
					type="date"
					bind:value={endDate}
					onchange={handleSearch}
					class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
				/>
			</div>
		</div>

		<!-- Error message -->
		{#if error}
			<div class="mt-4 rounded-lg bg-red-50 p-4 dark:bg-red-900/20">
				<p class="text-sm text-red-800 dark:text-red-200">{error}</p>
			</div>
		{/if}
	</Card>

	<!-- Audit log table -->
	<Card>
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_audit_timestamp()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_audit_user()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_audit_action()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_audit_resource()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_audit_ip()}
						</th>
					</tr>
				</thead>
				<tbody>
					{#if loading}
						<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
						{#each Array(10) as _, i (i)}
							<tr class="border-b border-gray-200 dark:border-gray-700">
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-40 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-28 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-28 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
							</tr>
						{/each}
					{:else if logs.length === 0}
						<tr>
							<td colspan="5" class="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
								No audit logs found
							</td>
						</tr>
					{:else}
						{#each logs as log (log.id)}
							<tr class="border-b border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
								<td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
									{formatTimestamp(log.createdAt)}
								</td>
								<td class="px-4 py-3 text-sm text-gray-900 dark:text-white">
									{log.user?.email || 'System'}
								</td>
								<td class="px-4 py-3 font-mono text-sm text-gray-700 dark:text-gray-300">
									{log.action}
								</td>
								<td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
									{log.resourceType || '-'}
								</td>
								<td class="px-4 py-3 font-mono text-sm text-gray-700 dark:text-gray-300">
									{log.ipAddress || '-'}
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if !loading && totalPages > 1}
			<div class="flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-700">
				<div class="text-sm text-gray-700 dark:text-gray-300">
					Showing <span class="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span>
					to
					<span class="font-medium">{Math.min(currentPage * itemsPerPage, totalCount)}</span>
					of
					<span class="font-medium">{totalCount}</span> results
				</div>
				<div class="flex gap-2">
					<button
						class="rounded-lg border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
						disabled={currentPage === 1}
						onclick={prevPage}
					>
						Previous
					</button>
					<button
						class="rounded-lg border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
						disabled={currentPage === totalPages}
						onclick={nextPage}
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	</Card>
</div>

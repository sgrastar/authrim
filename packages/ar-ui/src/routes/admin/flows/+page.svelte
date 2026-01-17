<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminFlowsAPI,
		type Flow,
		type ProfileId,
		getProfileDisplayName,
		getProfileBadgeStyle,
		canDeleteFlow
	} from '$lib/api/admin-flows';

	let flows: Flow[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Pagination
	let page = $state(1);
	let limit = $state(20);
	let total = $state(0);
	let totalPages = $state(0);

	// Filter state
	let filterProfile: ProfileId | 'all' = $state('all');
	let filterActive: 'all' | 'active' | 'inactive' = $state('all');
	let searchQuery = $state('');

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let flowToDelete: Flow | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	async function loadFlows() {
		loading = true;
		error = '';

		try {
			const response = await adminFlowsAPI.list({
				profile_id: filterProfile !== 'all' ? filterProfile : undefined,
				is_active: filterActive === 'all' ? undefined : filterActive === 'active',
				search: searchQuery || undefined,
				page,
				limit
			});
			flows = response.flows;
			total = response.pagination.total;
			totalPages = response.pagination.total_pages;
		} catch (err) {
			console.error('Failed to load flows:', err);
			error = 'Failed to load flows';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadFlows();
	});

	function handleSearch() {
		page = 1;
		loadFlows();
	}

	function handleFilterChange() {
		page = 1;
		loadFlows();
	}

	function navigateToFlow(flow: Flow) {
		goto(`/admin/flows/${flow.id}`);
	}

	function navigateToCreate() {
		goto('/admin/flows/new');
	}

	function openDeleteDialog(flow: Flow, event: Event) {
		event.stopPropagation();
		if (!canDeleteFlow(flow)) {
			return;
		}
		flowToDelete = flow;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		flowToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!flowToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminFlowsAPI.delete(flowToDelete.id);
			closeDeleteDialog();
			await loadFlows();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Failed to delete flow';
		} finally {
			deleting = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function goToPage(newPage: number) {
		if (newPage >= 1 && newPage <= totalPages) {
			page = newPage;
			loadFlows();
		}
	}
</script>

<div class="flows-page">
	<div class="page-header">
		<div class="header-content">
			<h1>Flows</h1>
			<p class="description">Manage authentication and authorization flows.</p>
		</div>
		<button class="btn-primary" onclick={navigateToCreate}>+ Create Flow</button>
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={loadFlows}>Retry</button>
		</div>
	{/if}

	<div class="filter-bar">
		<div class="search-box">
			<input
				type="text"
				placeholder="Search flows..."
				bind:value={searchQuery}
				onkeypress={(e) => e.key === 'Enter' && handleSearch()}
			/>
			<button onclick={handleSearch}>Search</button>
		</div>

		<div class="filters">
			<span class="filter-label">Profile:</span>
			<select bind:value={filterProfile} onchange={handleFilterChange}>
				<option value="all">All</option>
				<option value="human-basic">Human (Basic)</option>
				<option value="human-org">Human (Org)</option>
				<option value="ai-agent">AI Agent</option>
				<option value="iot-device">IoT Device</option>
			</select>

			<span class="filter-label">Status:</span>
			<select bind:value={filterActive} onchange={handleFilterChange}>
				<option value="all">All</option>
				<option value="active">Active</option>
				<option value="inactive">Inactive</option>
			</select>
		</div>
	</div>

	{#if loading}
		<div class="loading">Loading flows...</div>
	{:else if flows.length === 0}
		<div class="empty-state">
			<p>No flows found.</p>
			<button class="btn-primary" onclick={navigateToCreate}>Create your first flow</button>
		</div>
	{:else}
		<div class="flows-table-container">
			<table class="flows-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Profile</th>
						<th>Client</th>
						<th>Status</th>
						<th>Version</th>
						<th>Updated</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each flows as flow (flow.id)}
						<tr class="flow-row" onclick={() => navigateToFlow(flow)}>
							<td class="flow-name">
								<span class="name">{flow.name}</span>
								{#if flow.is_builtin}
									<span class="builtin-badge">Builtin</span>
								{/if}
							</td>
							<td>
								<span class="profile-badge" style={getProfileBadgeStyle(flow.profile_id)}>
									{getProfileDisplayName(flow.profile_id)}
								</span>
							</td>
							<td class="client-cell">
								{flow.client_id || 'Tenant Default'}
							</td>
							<td>
								<span
									class="status-badge"
									class:active={flow.is_active}
									class:inactive={!flow.is_active}
								>
									{flow.is_active ? 'Active' : 'Inactive'}
								</span>
							</td>
							<td class="version-cell">
								{flow.version}
							</td>
							<td class="date-cell">
								{formatDate(flow.updated_at)}
							</td>
							<td class="actions-cell">
								<button
									class="action-btn view-btn"
									onclick={(e) => {
										e.stopPropagation();
										navigateToFlow(flow);
									}}
									title="View details"
								>
									View
								</button>
								{#if canDeleteFlow(flow)}
									<button
										class="action-btn delete-btn"
										onclick={(e) => openDeleteDialog(flow, e)}
										title="Delete flow"
									>
										Delete
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if totalPages > 1}
			<div class="pagination">
				<button disabled={page === 1} onclick={() => goToPage(page - 1)}>Previous</button>
				<span>Page {page} of {totalPages} ({total} total)</span>
				<button disabled={page === totalPages} onclick={() => goToPage(page + 1)}>Next</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && flowToDelete}
	<div class="dialog-overlay" onclick={closeDeleteDialog} role="presentation">
		<div
			class="dialog"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="delete-dialog-title"
		>
			<h2 id="delete-dialog-title">Delete Flow</h2>
			<p>
				Are you sure you want to delete the flow <strong>{flowToDelete.name}</strong>?
			</p>
			<p class="warning-text">This action cannot be undone.</p>

			{#if deleteError}
				<div class="dialog-error">{deleteError}</div>
			{/if}

			<div class="dialog-actions">
				<button class="btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.flows-page {
		padding: 24px;
		max-width: 1200px;
		margin: 0 auto;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 24px;
	}

	.header-content h1 {
		margin: 0 0 8px 0;
		font-size: 24px;
		font-weight: 600;
	}

	.description {
		margin: 0;
		color: #6b7280;
		font-size: 14px;
	}

	.btn-primary {
		padding: 10px 20px;
		background-color: #2563eb;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.btn-primary:hover {
		background-color: #1d4ed8;
	}

	.error-banner {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 16px;
		border-radius: 6px;
		margin-bottom: 16px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.error-banner button {
		padding: 6px 12px;
		background-color: #b91c1c;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.filter-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}

	.search-box {
		display: flex;
		gap: 8px;
	}

	.search-box input {
		padding: 8px 12px;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 14px;
		width: 250px;
	}

	.search-box button {
		padding: 8px 16px;
		background-color: #f3f4f6;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		cursor: pointer;
	}

	.filters {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.filter-label {
		font-size: 14px;
		color: #6b7280;
	}

	.filters select {
		padding: 8px 12px;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 14px;
		background-color: white;
	}

	.loading {
		text-align: center;
		padding: 40px;
		color: #6b7280;
	}

	.empty-state {
		text-align: center;
		padding: 40px;
		color: #6b7280;
		background-color: #f9fafb;
		border-radius: 8px;
	}

	.empty-state button {
		margin-top: 16px;
	}

	.flows-table-container {
		overflow-x: auto;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
	}

	.flows-table {
		width: 100%;
		border-collapse: collapse;
	}

	.flows-table th {
		text-align: left;
		padding: 12px 16px;
		background-color: #f9fafb;
		font-size: 13px;
		font-weight: 600;
		color: #374151;
		border-bottom: 1px solid #e5e7eb;
	}

	.flows-table td {
		padding: 12px 16px;
		border-bottom: 1px solid #e5e7eb;
		font-size: 14px;
	}

	.flow-row {
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.flow-row:hover {
		background-color: #f9fafb;
	}

	.flow-row:last-child td {
		border-bottom: none;
	}

	.flow-name {
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.flow-name .name {
		color: #111827;
	}

	.builtin-badge {
		font-size: 11px;
		padding: 2px 6px;
		background-color: #dbeafe;
		color: #1e40af;
		border-radius: 4px;
	}

	.profile-badge {
		display: inline-block;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 500;
	}

	.client-cell {
		color: #6b7280;
	}

	.status-badge {
		display: inline-block;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 500;
	}

	.status-badge.active {
		background-color: #d1fae5;
		color: #065f46;
	}

	.status-badge.inactive {
		background-color: #f3f4f6;
		color: #6b7280;
	}

	.version-cell {
		color: #6b7280;
		font-family: monospace;
	}

	.date-cell {
		color: #6b7280;
		white-space: nowrap;
	}

	.actions-cell {
		white-space: nowrap;
	}

	.action-btn {
		padding: 4px 8px;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 12px;
		cursor: pointer;
		margin-right: 4px;
		transition: all 0.2s;
	}

	.view-btn {
		background-color: white;
		color: #374151;
	}

	.view-btn:hover {
		background-color: #f3f4f6;
	}

	.delete-btn {
		background-color: white;
		color: #dc2626;
		border-color: #fecaca;
	}

	.delete-btn:hover {
		background-color: #fef2f2;
	}

	.pagination {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 16px;
		margin-top: 16px;
		padding: 16px;
	}

	.pagination button {
		padding: 8px 16px;
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		cursor: pointer;
	}

	.pagination button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pagination span {
		color: #6b7280;
		font-size: 14px;
	}

	/* Dialog styles */
	.dialog-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog {
		background-color: white;
		border-radius: 8px;
		padding: 24px;
		max-width: 400px;
		width: 90%;
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
	}

	.dialog h2 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.dialog p {
		margin: 0 0 12px 0;
		color: #374151;
	}

	.warning-text {
		color: #b91c1c;
		font-size: 14px;
	}

	.dialog-error {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 8px 12px;
		border-radius: 4px;
		margin-bottom: 16px;
		font-size: 14px;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 24px;
	}

	.btn-secondary {
		padding: 8px 16px;
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-secondary:hover {
		background-color: #f3f4f6;
	}

	.btn-danger {
		padding: 8px 16px;
		background-color: #dc2626;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-danger:hover {
		background-color: #b91c1c;
	}

	.btn-danger:disabled,
	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

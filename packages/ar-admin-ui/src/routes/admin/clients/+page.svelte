<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import { adminClientsAPI, type Client, type ClientListParams } from '$lib/api/admin-clients';

	interface Pagination {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	}

	let clients: Client[] = $state([]);
	let pagination: Pagination | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Search state
	let searchQuery = $state('');
	let currentPage = $state(1);

	// Page size options and localStorage key
	const PAGE_SIZE_KEY = 'admin_clients_page_size';
	const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
	let limit = $state(20);

	// Debounce timer for search
	let searchTimeout: ReturnType<typeof setTimeout>;

	// Selection state for bulk delete
	let selectedIds = new SvelteSet<string>();
	let isAllSelected = $derived(clients.length > 0 && selectedIds.size === clients.length);
	let hasSelection = $derived(selectedIds.size > 0);

	// Bulk delete dialog state
	let showBulkDeleteDialog = $state(false);
	let bulkDeleting = $state(false);
	let bulkDeleteError = $state('');
	let bulkDeleteProgress = $state({ current: 0, total: 0, failed: 0 });

	async function loadClients() {
		loading = true;
		error = '';

		try {
			const params: ClientListParams = {
				page: currentPage,
				limit
			};

			if (searchQuery.trim()) {
				params.search = searchQuery.trim();
			}

			const response = await adminClientsAPI.list(params);
			clients = response.clients;
			pagination = response.pagination;
			// Clear selection when loading new data
			selectedIds.clear();
		} catch (err) {
			console.error('Failed to load clients:', err);
			error = 'Failed to load clients';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		// Load saved page size from localStorage
		const savedPageSize = localStorage.getItem(PAGE_SIZE_KEY);
		if (savedPageSize) {
			const parsed = parseInt(savedPageSize, 10);
			if (PAGE_SIZE_OPTIONS.includes(parsed as (typeof PAGE_SIZE_OPTIONS)[number])) {
				limit = parsed;
			}
		}
		loadClients();
	});

	function handlePageSizeChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		const newLimit = parseInt(target.value, 10);
		limit = newLimit;
		localStorage.setItem(PAGE_SIZE_KEY, String(newLimit));
		currentPage = 1;
		loadClients();
	}

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 1;
			loadClients();
		}, 300);
	}

	function goToPage(page: number) {
		currentPage = page;
		loadClients();
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleDateString();
	}

	function formatGrantTypes(grantTypes: string[]): string {
		const shortNames: Record<string, string> = {
			authorization_code: 'Auth Code',
			refresh_token: 'Refresh',
			client_credentials: 'Client Creds',
			'urn:ietf:params:oauth:grant-type:device_code': 'Device'
		};
		return grantTypes.map((gt) => shortNames[gt] || gt).join(', ');
	}

	function getClientTypeBadgeClass(grantTypes: string[]): string {
		if (grantTypes.includes('client_credentials')) {
			return 'badge badge-info'; // M2M
		}
		if (grantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
			return 'badge badge-warning'; // IoT
		}
		return 'badge badge-neutral'; // Standard
	}

	// Selection handlers
	function toggleSelectAll() {
		if (isAllSelected) {
			selectedIds.clear();
		} else {
			selectedIds.clear();
			clients.forEach((c) => selectedIds.add(c.client_id));
		}
	}

	function toggleSelect(clientId: string, event: Event) {
		event.stopPropagation();
		if (selectedIds.has(clientId)) {
			selectedIds.delete(clientId);
		} else {
			selectedIds.add(clientId);
		}
	}

	// Bulk delete handlers
	function openBulkDeleteDialog() {
		bulkDeleteError = '';
		bulkDeleteProgress = { current: 0, total: selectedIds.size, failed: 0 };
		showBulkDeleteDialog = true;
	}

	function closeBulkDeleteDialog() {
		if (!bulkDeleting) {
			showBulkDeleteDialog = false;
		}
	}

	async function executeBulkDelete() {
		bulkDeleting = true;
		bulkDeleteError = '';
		const idsToDelete = Array.from(selectedIds);
		bulkDeleteProgress = { current: 0, total: idsToDelete.length, failed: 0 };

		const failedIds: string[] = [];

		for (let i = 0; i < idsToDelete.length; i++) {
			const clientId = idsToDelete[i];
			try {
				await adminClientsAPI.delete(clientId);
			} catch (err) {
				console.error(`Failed to delete client ${clientId}:`, err);
				failedIds.push(clientId);
			}
			bulkDeleteProgress = {
				current: i + 1,
				total: idsToDelete.length,
				failed: failedIds.length
			};
		}

		bulkDeleting = false;

		if (failedIds.length > 0) {
			bulkDeleteError = `Failed to delete ${failedIds.length} client(s): ${failedIds.join(', ')}`;
		} else {
			showBulkDeleteDialog = false;
			loadClients();
		}
	}

	function getSelectedClients(): Client[] {
		return clients.filter((c) => selectedIds.has(c.client_id));
	}
</script>

<svelte:head>
	<title>OAuth Clients - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">OAuth Clients</h1>
			<p class="page-description">Manage OAuth 2.0 client applications</p>
		</div>
		<div class="page-actions">
			{#if hasSelection}
				<button class="btn btn-danger" onclick={openBulkDeleteDialog}>
					<i class="i-ph-trash"></i>
					Delete Selected ({selectedIds.size})
				</button>
			{/if}
			<a href="/admin/clients/new" class="btn btn-primary">
				<i class="i-ph-plus"></i>
				Create Client
			</a>
		</div>
	</div>

	<!-- Search -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label for="search" class="form-label">Search</label>
				<input
					id="search"
					type="text"
					class="form-input"
					placeholder="Search by client ID or name..."
					bind:value={searchQuery}
					oninput={handleSearch}
				/>
			</div>
			<div class="form-group" style="min-width: 120px; flex: 0;">
				<label for="pageSize" class="form-label">Show</label>
				<select id="pageSize" class="form-select" value={limit} onchange={handlePageSizeChange}>
					{#each PAGE_SIZE_OPTIONS as size (size)}
						<option value={size}>{size} per page</option>
					{/each}
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading clients...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if clients.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No OAuth clients found</p>
				<a href="/admin/clients/new" class="btn btn-primary">Create your first client</a>
			</div>
		</div>
	{:else}
		<!-- Clients Table -->
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>
							<input
								type="checkbox"
								class="checkbox"
								checked={isAllSelected}
								onchange={toggleSelectAll}
								aria-label="Select all clients"
							/>
						</th>
						<th>Client ID</th>
						<th>Name</th>
						<th>Grant Types</th>
						<th>Auth Method</th>
						<th>Created</th>
					</tr>
				</thead>
				<tbody>
					{#each clients as client (client.client_id)}
						<tr
							class:selected={selectedIds.has(client.client_id)}
							onclick={() => goto(`/admin/clients/${encodeURIComponent(client.client_id)}`)}
							onkeydown={(e) =>
								e.key === 'Enter' && goto(`/admin/clients/${encodeURIComponent(client.client_id)}`)}
							tabindex="0"
							role="button"
						>
							<td onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									class="checkbox"
									checked={selectedIds.has(client.client_id)}
									onchange={(e) => toggleSelect(client.client_id, e)}
									aria-label="Select {client.client_name || client.client_id}"
								/>
							</td>
							<td class="mono">
								{client.client_id.length > 20
									? client.client_id.substring(0, 20) + '...'
									: client.client_id}
							</td>
							<td>{client.client_name || '-'}</td>
							<td>
								<span class={getClientTypeBadgeClass(client.grant_types)}>
									{formatGrantTypes(client.grant_types)}
								</span>
							</td>
							<td class="muted">{client.token_endpoint_auth_method || 'none'}</td>
							<td class="muted">{formatDate(client.created_at)}</td>
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
					)} of {pagination.total} clients
				</p>
				<div class="pagination-buttons">
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage - 1)}
						disabled={!pagination.hasPrev}
					>
						Previous
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage + 1)}
						disabled={!pagination.hasNext}
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Bulk Delete Confirmation Dialog -->
{#if showBulkDeleteDialog}
	<div
		class="modal-overlay"
		onclick={closeBulkDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeBulkDeleteDialog()}
		role="dialog"
		aria-modal="true"
		aria-labelledby="bulk-delete-dialog-title"
	>
		<div
			class="modal-content"
			style="max-width: 700px;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 id="bulk-delete-dialog-title" class="modal-title">
					Delete {selectedIds.size} Client(s)
				</h2>
			</div>

			<div class="modal-body">
				{#if bulkDeleting}
					<!-- Progress View -->
					<div>
						<p style="color: var(--text-secondary); margin-bottom: 16px;">Deleting clients...</p>
						<div class="progress-bar" style="margin-bottom: 8px;">
							<div
								class="progress-bar-fill"
								class:warning={bulkDeleteProgress.failed > 0}
								style="width: {(bulkDeleteProgress.current / bulkDeleteProgress.total) * 100}%;"
							></div>
						</div>
						<p style="color: var(--text-secondary); font-size: 0.875rem; margin: 0;">
							{bulkDeleteProgress.current} / {bulkDeleteProgress.total}
							{#if bulkDeleteProgress.failed > 0}
								<span style="color: var(--danger);">({bulkDeleteProgress.failed} failed)</span>
							{/if}
						</p>
					</div>
				{:else}
					<!-- Confirmation View -->
					<p style="color: var(--text-secondary); margin-bottom: 16px;">
						Are you sure you want to delete the following OAuth clients? This action cannot be
						undone.
						<strong style="color: var(--danger);">
							All tokens issued by these clients will become invalid.
						</strong>
					</p>

					<div
						class="panel"
						style="max-height: 200px; overflow-y: auto; padding: 0; margin-bottom: 16px;"
					>
						<ul style="margin: 0; padding: 12px 20px; list-style: disc;">
							{#each getSelectedClients() as client (client.client_id)}
								<li style="margin-bottom: 4px; color: var(--text-primary);">
									<strong class="mono" style="font-size: 0.875rem;">
										{client.client_id.length > 30
											? client.client_id.substring(0, 30) + '...'
											: client.client_id}
									</strong>
									{#if client.client_name}
										<span style="color: var(--text-secondary);">({client.client_name})</span>
									{/if}
								</li>
							{/each}
						</ul>
					</div>

					{#if bulkDeleteError}
						<div class="alert alert-error">{bulkDeleteError}</div>
					{/if}
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeBulkDeleteDialog} disabled={bulkDeleting}>
					Cancel
				</button>
				{#if !bulkDeleting}
					<button class="btn btn-danger" onclick={executeBulkDelete}>
						Delete {selectedIds.size} Client(s)
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

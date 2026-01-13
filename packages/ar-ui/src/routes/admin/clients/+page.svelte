<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminClientsAPI,
		type Client,
		type ClientListParams
	} from '$lib/api/admin-clients';

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
			if (PAGE_SIZE_OPTIONS.includes(parsed as typeof PAGE_SIZE_OPTIONS[number])) {
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
			'authorization_code': 'Auth Code',
			'refresh_token': 'Refresh',
			'client_credentials': 'Client Creds',
			'urn:ietf:params:oauth:grant-type:device_code': 'Device'
		};
		return grantTypes.map(gt => shortNames[gt] || gt).join(', ');
	}

	function getClientTypeBadgeStyle(grantTypes: string[]): string {
		if (grantTypes.includes('client_credentials')) {
			return 'background-color: #e0e7ff; color: #3730a3;'; // M2M - indigo
		}
		if (grantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
			return 'background-color: #fef3c7; color: #92400e;'; // IoT - amber
		}
		return 'background-color: #dbeafe; color: #1e40af;'; // Standard - blue
	}

	// Selection handlers
	function toggleSelectAll() {
		if (isAllSelected) {
			selectedIds.clear();
		} else {
			selectedIds.clear();
			clients.forEach(c => selectedIds.add(c.client_id));
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
		return clients.filter(c => selectedIds.has(c.client_id));
	}
</script>

<svelte:head>
	<title>OAuth Clients - Admin Dashboard - Authrim</title>
</svelte:head>

<div>
	<div
		style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;"
	>
		<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0;">OAuth Clients</h1>
		<div style="display: flex; gap: 8px; align-items: center;">
			{#if hasSelection}
				<button
					onclick={openBulkDeleteDialog}
					style="
						padding: 10px 20px;
						background-color: #dc2626;
						color: white;
						border: none;
						border-radius: 6px;
						font-size: 14px;
						font-weight: 500;
						cursor: pointer;
					"
				>
					Delete Selected ({selectedIds.size})
				</button>
			{/if}
			<a
				href="/admin/clients/new"
				style="
					padding: 10px 20px;
					background-color: #3b82f6;
					color: white;
					text-decoration: none;
					border-radius: 6px;
					font-size: 14px;
					font-weight: 500;
				"
			>
				Create Client
			</a>
		</div>
	</div>

	<!-- Search -->
	<div
		style="background-color: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
	>
		<div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end;">
			<div style="flex: 1; min-width: 200px;">
				<label
					for="search"
					style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;">Search</label
				>
				<input
					id="search"
					type="text"
					placeholder="Search by client ID or name..."
					bind:value={searchQuery}
					oninput={handleSearch}
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
			<div style="min-width: 120px;">
				<label
					for="pageSize"
					style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;">Show</label
				>
				<select
					id="pageSize"
					value={limit}
					onchange={handlePageSizeChange}
					style="
						width: 100%;
						padding: 8px 12px;
						border: 1px solid #d1d5db;
						border-radius: 4px;
						font-size: 14px;
						background-color: white;
						cursor: pointer;
					"
				>
					{#each PAGE_SIZE_OPTIONS as size (size)}
						<option value={size}>{size} per page</option>
					{/each}
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<p style="color: #6b7280; text-align: center; padding: 40px;">Loading clients...</p>
	{:else if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;"
		>
			{error}
		</div>
	{:else if clients.length === 0}
		<div
			style="background-color: white; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center;"
		>
			<p style="color: #9ca3af; margin: 0 0 16px 0;">No OAuth clients found</p>
			<a
				href="/admin/clients/new"
				style="
					display: inline-block;
					padding: 10px 20px;
					background-color: #3b82f6;
					color: white;
					text-decoration: none;
					border-radius: 6px;
					font-size: 14px;
				"
			>
				Create your first client
			</a>
		</div>
	{:else}
		<!-- Clients Table -->
		<div
			style="background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden;"
		>
			<table style="width: 100%; border-collapse: collapse;">
				<thead>
					<tr style="background-color: #f9fafb; border-bottom: 1px solid #e5e7eb;">
						<th style="width: 40px; padding: 12px 8px 12px 16px;">
							<input
								type="checkbox"
								checked={isAllSelected}
								onchange={toggleSelectAll}
								style="cursor: pointer; width: 16px; height: 16px;"
								aria-label="Select all clients"
							/>
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Client ID</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Name</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Grant Types</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Auth Method</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Created</th
						>
					</tr>
				</thead>
				<tbody>
					{#each clients as client (client.client_id)}
						<tr
							style="border-bottom: 1px solid #e5e7eb; cursor: pointer; {selectedIds.has(client.client_id) ? 'background-color: #eff6ff;' : ''}"
							onclick={() => goto(`/admin/clients/${encodeURIComponent(client.client_id)}`)}
							onkeydown={(e) => e.key === 'Enter' && goto(`/admin/clients/${encodeURIComponent(client.client_id)}`)}
							tabindex="0"
							role="button"
						>
							<td style="padding: 12px 8px 12px 16px;" onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									checked={selectedIds.has(client.client_id)}
									onchange={(e) => toggleSelect(client.client_id, e)}
									style="cursor: pointer; width: 16px; height: 16px;"
									aria-label="Select {client.client_name || client.client_id}"
								/>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #1f2937; font-family: monospace;">
								{client.client_id.length > 20 ? client.client_id.substring(0, 20) + '...' : client.client_id}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #1f2937;">
								{client.client_name || '-'}
							</td>
							<td style="padding: 12px 16px;">
								<span
									style="
									display: inline-block;
									padding: 2px 8px;
									border-radius: 12px;
									font-size: 12px;
									font-weight: 500;
									{getClientTypeBadgeStyle(client.grant_types)}
								"
								>
									{formatGrantTypes(client.grant_types)}
								</span>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{client.token_endpoint_auth_method || 'none'}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{formatDate(client.created_at)}
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
					)} of {pagination.total} clients
				</p>
				<div style="display: flex; gap: 8px;">
					<button
						onclick={() => goToPage(currentPage - 1)}
						disabled={!pagination.hasPrev}
						style="
							padding: 8px 16px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							background-color: white;
							color: {pagination.hasPrev ? '#374151' : '#9ca3af'};
							cursor: {pagination.hasPrev ? 'pointer' : 'not-allowed'};
							font-size: 14px;
						"
					>
						Previous
					</button>
					<button
						onclick={() => goToPage(currentPage + 1)}
						disabled={!pagination.hasNext}
						style="
							padding: 8px 16px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							background-color: white;
							color: {pagination.hasNext ? '#374151' : '#9ca3af'};
							cursor: {pagination.hasNext ? 'pointer' : 'not-allowed'};
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

<!-- Bulk Delete Confirmation Dialog -->
{#if showBulkDeleteDialog}
	<div
		style="
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
		"
		onclick={closeBulkDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeBulkDeleteDialog()}
		role="dialog"
		aria-modal="true"
		aria-labelledby="bulk-delete-dialog-title"
	>
		<div
			style="
				background-color: white;
				border-radius: 8px;
				padding: 24px;
				max-width: 700px;
				width: 90%;
				max-height: 80vh;
				overflow-y: auto;
				box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 id="bulk-delete-dialog-title" style="margin: 0 0 16px 0; font-size: 20px; color: #1f2937;">
				Delete {selectedIds.size} Client(s)
			</h2>

			{#if bulkDeleting}
				<!-- Progress View -->
				<div>
					<p style="color: #6b7280; margin-bottom: 16px;">Deleting clients...</p>
					<div style="background-color: #e5e7eb; border-radius: 4px; height: 8px; overflow: hidden; margin-bottom: 8px;">
						<div
							style="
								background-color: {bulkDeleteProgress.failed > 0 ? '#f59e0b' : '#3b82f6'};
								height: 100%;
								width: {(bulkDeleteProgress.current / bulkDeleteProgress.total) * 100}%;
								transition: width 0.3s ease;
							"
						></div>
					</div>
					<p style="color: #6b7280; font-size: 14px; margin: 0;">
						{bulkDeleteProgress.current} / {bulkDeleteProgress.total}
						{#if bulkDeleteProgress.failed > 0}
							<span style="color: #dc2626;">({bulkDeleteProgress.failed} failed)</span>
						{/if}
					</p>
				</div>
			{:else}
				<!-- Confirmation View -->
				<p style="color: #6b7280; margin-bottom: 16px;">
					Are you sure you want to delete the following OAuth clients? This action cannot be undone.
					<strong style="color: #dc2626;">All tokens issued by these clients will become invalid.</strong>
				</p>

				<div style="background-color: #f9fafb; border-radius: 6px; padding: 12px; margin-bottom: 16px; max-height: 200px; overflow-y: auto;">
					<ul style="margin: 0; padding-left: 20px; color: #374151;">
						{#each getSelectedClients() as client (client.client_id)}
							<li style="margin-bottom: 4px;">
								<strong style="font-family: monospace;">{client.client_id.length > 30 ? client.client_id.substring(0, 30) + '...' : client.client_id}</strong>
								{#if client.client_name}
									<span style="color: #6b7280;">({client.client_name})</span>
								{/if}
							</li>
						{/each}
					</ul>
				</div>

				{#if bulkDeleteError}
					<div style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
						{bulkDeleteError}
					</div>
				{/if}

				<div style="display: flex; gap: 8px; justify-content: flex-end;">
					<button
						onclick={closeBulkDeleteDialog}
						style="
							padding: 10px 20px;
							background-color: white;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
							cursor: pointer;
							color: #374151;
						"
					>
						Cancel
					</button>
					<button
						onclick={executeBulkDelete}
						style="
							padding: 10px 20px;
							background-color: #dc2626;
							color: white;
							border: none;
							border-radius: 6px;
							font-size: 14px;
							font-weight: 500;
							cursor: pointer;
						"
					>
						Delete {selectedIds.size} Client(s)
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button, Input, Dialog } from '$lib/components';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { adminClientsAPI } from '$lib/api/client';

	interface Client {
		client_id: string;
		client_name: string;
		grant_types: string[];
		created_at: number;
	}

	let clients: Client[] = [];
	let loading = true;
	let searchQuery = '';
	let currentPage = 1;
	let totalPages = 1;
	let totalCount = 0;
	let itemsPerPage = 20;

	// Selection state
	let selectedClients: SvelteSet<string> = new SvelteSet();
	$: allSelected = clients.length > 0 && clients.every((c) => selectedClients.has(c.client_id));
	$: someSelected = selectedClients.size > 0;

	// Delete dialog state
	let showDeleteDialog = false;
	let deleteDialogMode: 'single' | 'bulk' = 'single';
	let clientToDelete: string | null = null;
	let deleting = false;

	onMount(async () => {
		await loadClients();
	});

	async function loadClients() {
		loading = true;

		try {
			const { data, error } = await adminClientsAPI.list({
				page: currentPage,
				limit: itemsPerPage,
				search: searchQuery || undefined
			});

			if (error) {
				console.error('Failed to load clients:', error);
				clients = [];
				totalCount = 0;
				totalPages = 0;
			} else if (data) {
				clients = data.clients;
				totalCount = data.pagination.total;
				totalPages = data.pagination.totalPages;
			}
		} catch (err) {
			console.error('Error loading clients:', err);
			clients = [];
			totalCount = 0;
			totalPages = 0;
		} finally {
			loading = false;
			// Clear selection when clients change
			selectedClients = new SvelteSet();
		}
	}

	function handleSearch() {
		currentPage = 1;
		loadClients();
	}

	function handlePageSizeChange() {
		currentPage = 1;
		loadClients();
	}

	function formatDateWithMs(timestamp: number): string {
		const date = new Date(timestamp);
		const dateStr = date.toLocaleString('ja-JP', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		const ms = String(date.getMilliseconds()).padStart(3, '0');
		return `${dateStr}.${ms}`;
	}

	function truncateClientId(clientId: string): string {
		if (clientId.length <= 27) return clientId;
		return clientId.slice(0, 12) + '...' + clientId.slice(-12);
	}

	// Selection functions
	function toggleSelectAll() {
		if (allSelected) {
			selectedClients = new SvelteSet();
		} else {
			selectedClients = new SvelteSet(clients.map((c) => c.client_id));
		}
	}

	function toggleClientSelection(clientId: string) {
		const newSet = new SvelteSet(selectedClients);
		if (newSet.has(clientId)) {
			newSet.delete(clientId);
		} else {
			newSet.add(clientId);
		}
		selectedClients = newSet;
	}

	function clearSelection() {
		selectedClients = new SvelteSet();
	}

	// Delete functions
	function openDeleteDialog(clientId: string) {
		clientToDelete = clientId;
		deleteDialogMode = 'single';
		showDeleteDialog = true;
	}

	function openBulkDeleteDialog() {
		if (selectedClients.size === 0) return;
		deleteDialogMode = 'bulk';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		clientToDelete = null;
	}

	async function confirmDelete() {
		deleting = true;
		try {
			if (deleteDialogMode === 'single' && clientToDelete) {
				const { error } = await adminClientsAPI.delete(clientToDelete);
				if (error) {
					alert('Failed to delete client: ' + (error.error_description || 'Unknown error'));
				} else {
					await loadClients();
				}
			} else if (deleteDialogMode === 'bulk') {
				const clientIds = Array.from(selectedClients);
				const { data, error } = await adminClientsAPI.bulkDelete(clientIds);
				if (error) {
					alert('Failed to delete clients: ' + (error.error_description || 'Unknown error'));
				} else if (data) {
					if (data.errors && data.errors.length > 0) {
						alert(
							`Deleted ${data.deleted} of ${data.requested} clients.\nErrors:\n${data.errors.join('\n')}`
						);
					}
					await loadClients();
				}
			}
		} catch (err) {
			console.error('Delete error:', err);
			alert('Failed to delete');
		} finally {
			deleting = false;
			closeDeleteDialog();
		}
	}

	function nextPage() {
		if (currentPage < totalPages) {
			currentPage++;
			loadClients();
		}
	}

	function prevPage() {
		if (currentPage > 1) {
			currentPage--;
			loadClients();
		}
	}

	// Grant type label mapping
	function getGrantTypeLabel(grantType: string): string {
		const labels: Record<string, string> = {
			authorization_code: 'Auth Code',
			refresh_token: 'Refresh',
			client_credentials: 'Client Creds',
			implicit: 'Implicit',
			password: 'Password',
			'urn:ietf:params:oauth:grant-type:device_code': 'Device',
			'urn:openid:params:grant-type:ciba': 'CIBA'
		};
		return labels[grantType] || grantType;
	}
</script>

<svelte:head>
	<title>{$LL.admin_clients_title()} - {$LL.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
				{$LL.admin_clients_title()}
			</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				Manage OAuth 2.0 / OpenID Connect clients
			</p>
		</div>
		<Button variant="primary" onclick={() => (window.location.href = '/admin/clients/new')}>
			{$LL.admin_clients_registerClient()}
		</Button>
	</div>

	<!-- Search and controls -->
	<Card>
		<div class="flex flex-wrap items-center justify-between gap-4">
			<div class="w-full max-w-md">
				{#snippet searchIcon()}
					<div class="i-heroicons-magnifying-glass h-5 w-5 text-gray-400"></div>
				{/snippet}
				<Input
					type="text"
					placeholder={$LL.admin_clients_search()}
					bind:value={searchQuery}
					oninput={handleSearch}
					icon={searchIcon}
				/>
			</div>
			<div class="flex items-center gap-4">
				<!-- Page size selector -->
				<div class="flex items-center gap-2">
					<label for="pageSize" class="text-sm text-gray-600 dark:text-gray-400">Show:</label>
					<select
						id="pageSize"
						bind:value={itemsPerPage}
						onchange={handlePageSizeChange}
						class="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
					>
						<option value={20}>20</option>
						<option value={50}>50</option>
						<option value={100}>100</option>
						<option value={200}>200</option>
					</select>
				</div>

				<!-- Bulk actions -->
				{#if someSelected}
					<div class="flex items-center gap-2">
						<span class="text-sm text-gray-600 dark:text-gray-400">
							{selectedClients.size} selected
						</span>
						<button
							class="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
							onclick={clearSelection}
						>
							Clear
						</button>
						<Button variant="danger" onclick={openBulkDeleteDialog}>Delete Selected</Button>
					</div>
				{/if}
			</div>
		</div>
	</Card>

	<!-- Clients table -->
	<Card>
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3 text-left">
							<input
								type="checkbox"
								checked={allSelected}
								onchange={toggleSelectAll}
								class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
								disabled={loading || clients.length === 0}
							/>
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							{$LL.admin_clients_clientName()}
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							{$LL.admin_clients_clientId()}
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							{$LL.admin_clients_grantTypes()}
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							{$LL.admin_clients_created()}
						</th>
						<th
							class="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							{$LL.admin_clients_actions()}
						</th>
					</tr>
				</thead>
				<tbody>
					{#if loading}
						<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
						{#each Array(5) as _, i (i)}
							<tr class="border-b border-gray-200 dark:border-gray-700">
								<td class="px-4 py-3">
									<div class="h-4 w-4 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-40 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-40 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3 text-right">
									<div class="inline-flex gap-2">
										<div class="h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
									</div>
								</td>
							</tr>
						{/each}
					{:else if clients.length === 0}
						<tr>
							<td colspan="6" class="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
								No clients found
							</td>
						</tr>
					{:else}
						{#each clients as client (client.client_id)}
							<tr
								class="border-b border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
							>
								<td class="px-4 py-3">
									<input
										type="checkbox"
										checked={selectedClients.has(client.client_id)}
										onchange={() => toggleClientSelection(client.client_id)}
										class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
									/>
								</td>
								<td class="px-4 py-3 text-sm whitespace-nowrap">
									<a
										href={`/admin/clients/${client.client_id}`}
										class="font-medium text-primary-600 hover:text-primary-800 dark:text-primary-400 dark:hover:text-primary-300"
									>
										{client.client_name}
									</a>
								</td>
								<td
									class="px-4 py-3 font-mono text-sm text-gray-900 dark:text-white whitespace-nowrap"
									title={client.client_id}
								>
									{truncateClientId(client.client_id)}
								</td>
								<td class="px-4 py-3 whitespace-nowrap">
									<div class="flex flex-wrap gap-1">
										{#each client.grant_types as grantType (grantType)}
											<span
												class="inline-flex items-center rounded-full bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-800 dark:bg-primary-900 dark:text-primary-200"
											>
												{getGrantTypeLabel(grantType)}
											</span>
										{/each}
									</div>
								</td>
								<td
									class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap font-mono"
								>
									{formatDateWithMs(client.created_at)}
								</td>
								<td class="px-4 py-3 text-right whitespace-nowrap">
									<button
										class="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 transition-colors"
										onclick={() => openDeleteDialog(client.client_id)}
									>
										Delete
									</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if !loading && totalCount > 0}
			<div
				class="flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-700"
			>
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

<!-- Delete Confirmation Dialog -->
<Dialog bind:open={showDeleteDialog} title="削除の確認">
	{#if deleteDialogMode === 'single'}
		<p class="text-gray-600 dark:text-gray-300">
			このクライアントを削除しますか？この操作は取り消せません。
		</p>
	{:else}
		<p class="text-gray-600 dark:text-gray-300">
			選択した <span class="font-bold">{selectedClients.size}</span> 件のクライアントを削除しますか？この操作は取り消せません。
		</p>
	{/if}

	<div slot="footer" class="flex justify-end gap-3">
		<Button variant="secondary" onclick={closeDeleteDialog} disabled={deleting}>キャンセル</Button>
		<Button variant="danger" onclick={confirmDelete} disabled={deleting}>
			{#if deleting}
				削除中...
			{:else}
				削除
			{/if}
		</Button>
	</div>
</Dialog>

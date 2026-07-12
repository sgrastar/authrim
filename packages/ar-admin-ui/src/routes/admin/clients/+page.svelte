<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import { adminClientsAPI, type Client, type ClientListParams } from '$lib/api/admin-clients';
	import { Modal } from '$lib/components';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminPagination from '$lib/components/admin/AdminPagination.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminToolbar from '$lib/components/admin/AdminToolbar.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';

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
	let clientKindFilter = $state<'all' | 'custom' | 'system'>('all');

	// Page size options and localStorage key
	const PAGE_SIZE_KEY = 'admin_clients_page_size';
	const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
	let limit = $state(20);

	// Debounce timer for search
	let searchTimeout: ReturnType<typeof setTimeout>;

	// Selection state for bulk delete
	let selectedIds = new SvelteSet<string>();
	let filteredClients = $derived(
		clients.filter((client) => {
			if (clientKindFilter === 'system') return isSystemClient(client);
			if (clientKindFilter === 'custom') return !isSystemClient(client);
			return true;
		})
	);
	let systemClientCount = $derived(clients.filter((client) => isSystemClient(client)).length);
	let customClientCount = $derived(clients.length - systemClientCount);
	let isAllSelected = $derived(
		filteredClients.length > 0 &&
			filteredClients.every((client) => selectedIds.has(client.client_id))
	);
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
			error = $LL.admin_clients_error_load();
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
		return new Date(timestamp).toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function formatGrantTypes(grantTypes: string[]): string {
		const shortNames: Record<string, string> = {
			authorization_code: $LL.admin_clients_grant_auth_code(),
			refresh_token: $LL.admin_clients_grant_refresh(),
			client_credentials: $LL.admin_clients_grant_client_credentials(),
			'urn:ietf:params:oauth:grant-type:device_code': $LL.admin_clients_grant_device()
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

	function getIntegrationBadges(client: Client): string[] {
		const badges: string[] = [];
		if (client.token_exchange_allowed) badges.push($LL.admin_clients_badge_token_exchange());
		if (client.client_credentials_allowed)
			badges.push($LL.admin_clients_badge_client_credentials());
		if (client.default_audience) {
			badges.push($LL.admin_clients_badge_audience({ audience: client.default_audience }));
		}
		return badges;
	}

	function isSystemClient(client: Client): boolean {
		return (
			client.client_name === 'Login UI' || client.client_name === 'Downstream Grant Introspection'
		);
	}

	// Selection handlers
	function toggleSelectAll() {
		if (isAllSelected) {
			filteredClients.forEach((client) => selectedIds.delete(client.client_id));
		} else {
			filteredClients.forEach((client) => selectedIds.add(client.client_id));
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
			bulkDeleteError = $LL.admin_clients_error_delete({
				count: failedIds.length,
				clients: failedIds.join(', ')
			});
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
	<title>{$LL.admin_clients_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_clients_heading()}
		description={$LL.admin_clients_description()}
	>
		{#snippet actions()}
			{#if hasSelection}
				<button class="btn btn-danger" onclick={openBulkDeleteDialog}>
					<i class="i-ph-trash"></i>
					{$LL.admin_clients_delete_selected({ count: selectedIds.size })}
				</button>
			{/if}
			<a href="/admin/clients/new" class="btn btn-primary">
				<i class="i-ph-plus"></i>
				{$LL.admin_clients_create()}
			</a>
		{/snippet}
	</AdminPageHeader>

	<AdminToolbar>
		<div class="admin-field admin-field--search">
			<label for="search" class="admin-field__label">{$LL.admin_clients_search_label()}</label>
			<input
				id="search"
				type="text"
				class="admin-input"
				placeholder={$LL.admin_clients_search_placeholder()}
				bind:value={searchQuery}
				oninput={handleSearch}
			/>
		</div>
		<div class="admin-field admin-field--compact">
			<label for="pageSize" class="admin-field__label">{$LL.admin_clients_page_size_label()}</label>
			<select id="pageSize" class="admin-select" value={limit} onchange={handlePageSizeChange}>
				{#each PAGE_SIZE_OPTIONS as size (size)}
					<option value={size}>{$LL.admin_clients_per_page({ count: size })}</option>
				{/each}
			</select>
		</div>
		<div class="admin-field admin-field--chips">
			<span class="admin-field__label">{$LL.admin_users_filter()}</span>
			<div class="filter-chips" role="group" aria-label={$LL.admin_users_filter()}>
				<button
					type="button"
					class="filter-chip"
					class:active={clientKindFilter === 'all'}
					aria-pressed={clientKindFilter === 'all'}
					onclick={() => (clientKindFilter = 'all')}
				>
					{$LL.admin_roles_filter_all()}
					{clients.length}
				</button>
				<button
					type="button"
					class="filter-chip"
					class:active={clientKindFilter === 'custom'}
					aria-pressed={clientKindFilter === 'custom'}
					onclick={() => (clientKindFilter = 'custom')}
				>
					{$LL.admin_roles_filter_custom()}
					{customClientCount}
				</button>
				<button
					type="button"
					class="filter-chip"
					class:active={clientKindFilter === 'system'}
					aria-pressed={clientKindFilter === 'system'}
					onclick={() => (clientKindFilter = 'system')}
				>
					{$LL.admin_clients_system()}
					{systemClientCount}
				</button>
			</div>
		</div>
	</AdminToolbar>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_clients_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if clients.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_clients_empty()}</p>
				<a href="/admin/clients/new" class="btn btn-primary">{$LL.admin_clients_create_first()}</a>
			</div>
		</AdminSection>
	{:else if filteredClients.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_clients_empty()}</p>
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>
							<input
								type="checkbox"
								class="checkbox"
								checked={isAllSelected}
								onchange={toggleSelectAll}
								aria-label={$LL.admin_clients_select_all()}
							/>
						</th>
						<th>{$LL.admin_clients_clientId()}</th>
						<th>{$LL.admin_clients_clientName()}</th>
						<th>{$LL.admin_clients_grantTypes()}</th>
						<th>{$LL.admin_clients_auth_method()}</th>
						<th>{$LL.admin_clients_created()}</th>
						<th class="text-right"></th>
					</tr>
				</thead>
				<tbody>
					{#each filteredClients as client (client.client_id)}
						<tr
							class:selected={selectedIds.has(client.client_id)}
							data-clickable="true"
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
									aria-label={$LL.admin_clients_select_client({
										client: client.client_name || client.client_id
									})}
								/>
							</td>
							<td class="admin-mono nowrap">
								{client.client_id.length > 20
									? client.client_id.substring(0, 20) + '...'
									: client.client_id}
							</td>
							<td>
								<div class="client-name-cell">
									<span>{client.client_name || '-'}</span>
									{#if isSystemClient(client)}
										<span class="system-client-badge">{$LL.admin_clients_system()}</span>
									{/if}
								</div>
								{#if client.description}
									<div class="client-description">{client.description}</div>
								{/if}
							</td>
							<td>
								<span class={getClientTypeBadgeClass(client.grant_types)}>
									{formatGrantTypes(client.grant_types)}
								</span>
								{#if getIntegrationBadges(client).length > 0}
									<div class="client-capability-list">
										{#each getIntegrationBadges(client) as badge (badge)}
											<span class="client-capability-badge">{badge}</span>
										{/each}
									</div>
								{/if}
							</td>
							<td class="admin-muted admin-mono">{client.token_endpoint_auth_method || 'none'}</td>
							<td class="admin-muted nowrap">{formatDate(client.created_at)}</td>
							<td class="text-right row-action-cell" aria-hidden="true">...</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		<!-- Pagination -->
		{#if pagination && pagination.totalPages > 1}
			<AdminPagination
				label={$LL.admin_clients_page_title()}
				info={$LL.admin_clients_pagination({
					start: (pagination.page - 1) * pagination.limit + 1,
					end: Math.min(pagination.page * pagination.limit, pagination.total),
					total: pagination.total
				})}
				previousLabel={$LL.common_previous()}
				nextLabel={$LL.common_next()}
				hasPrevious={pagination.hasPrev}
				hasNext={pagination.hasNext}
				onPrevious={() => goToPage(currentPage - 1)}
				onNext={() => goToPage(currentPage + 1)}
			/>
		{/if}
	{/if}
</AdminPageShell>

<!-- Bulk Delete Confirmation Dialog -->
<Modal
	open={showBulkDeleteDialog}
	onClose={closeBulkDeleteDialog}
	title={$LL.admin_clients_delete_title({ count: selectedIds.size })}
	size="lg"
>
	{#if bulkDeleting}
		<!-- Progress View -->
		<div>
			<p class="modal-muted-block">
				{$LL.admin_clients_deleting()}
			</p>
			<progress
				class="modal-progress"
				class:warning={bulkDeleteProgress.failed > 0}
				value={bulkDeleteProgress.current}
				max={bulkDeleteProgress.total}
			>
				{bulkDeleteProgress.current} / {bulkDeleteProgress.total}
			</progress>
			<p class="modal-progress-text">
				{bulkDeleteProgress.current} / {bulkDeleteProgress.total}
				{#if bulkDeleteProgress.failed > 0}
					<span class="modal-danger-text">
						{$LL.admin_clients_delete_failed_count({ count: bulkDeleteProgress.failed })}
					</span>
				{/if}
			</p>
		</div>
	{:else}
		<!-- Confirmation View -->
		<p class="modal-muted-block">
			{$LL.admin_clients_delete_confirm()}
			<strong class="modal-danger-text">
				{$LL.admin_clients_delete_token_warning()}
			</strong>
		</p>

		<div class="selected-client-list">
			<ul>
				{#each getSelectedClients() as client (client.client_id)}
					<li>
						<strong class="admin-mono selected-client-id">
							{client.client_id.length > 30
								? client.client_id.substring(0, 30) + '...'
								: client.client_id}
						</strong>
						{#if client.client_name}
							<span class="admin-muted">({client.client_name})</span>
						{/if}
					</li>
				{/each}
			</ul>
		</div>

		{#if bulkDeleteError}
			<div class="alert alert-error">{bulkDeleteError}</div>
		{/if}
	{/if}
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeBulkDeleteDialog} disabled={bulkDeleting}>
			{$LL.common_cancel()}
		</button>
		{#if !bulkDeleting}
			<button class="btn btn-danger" onclick={executeBulkDelete}>
				{$LL.admin_clients_delete_action({ count: selectedIds.size })}
			</button>
		{/if}
	{/snippet}
</Modal>

<style>
	.admin-mono {
		font-family: var(--font-meta, var(--font-mono));
		font-size: 0.82rem;
	}

	.nowrap {
		white-space: nowrap;
	}

	.admin-muted {
		color: var(--color-text-muted);
	}

	.filter-chips {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--filter-chip-gap, 8px);
	}

	.filter-chip {
		min-height: var(--filter-chip-height, 32px);
		padding: var(--filter-chip-padding, 5px 14px);
		border: 1px solid var(--filter-chip-border, var(--color-border));
		border-radius: var(--filter-chip-radius, var(--radius-control));
		background: var(--filter-chip-bg, transparent);
		color: var(--filter-chip-color, var(--color-text-muted));
		font-family: var(--filter-chip-font, var(--font-meta, var(--font-body)));
		font-size: var(--filter-chip-size, 0.76rem);
		font-weight: 700;
		letter-spacing: var(--filter-chip-letter-spacing, 0.04em);
		cursor: pointer;
	}

	.filter-chip:hover {
		border-color: var(--filter-chip-hover-border, var(--color-accent));
		color: var(--filter-chip-hover-color, var(--color-text));
	}

	.filter-chip.active {
		border-color: var(--filter-chip-active-border, var(--color-accent));
		background: var(--filter-chip-active-bg, var(--color-accent-muted));
		color: var(--filter-chip-active-color, var(--color-accent));
	}

	.modal-muted-block {
		margin: 0 0 16px;
		color: var(--color-text-muted);
	}

	.modal-progress {
		display: block;
		width: 100%;
		height: 10px;
		margin-bottom: 8px;
		overflow: hidden;
		border: none;
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
	}

	.modal-progress::-webkit-progress-bar {
		background: var(--color-surface-muted);
	}

	.modal-progress::-webkit-progress-value {
		background: var(--color-accent);
	}

	.modal-progress::-moz-progress-bar {
		background: var(--color-accent);
	}

	.modal-progress.warning::-webkit-progress-value {
		background: var(--color-warning);
	}

	.modal-progress.warning::-moz-progress-bar {
		background: var(--color-warning);
	}

	.modal-progress-text {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.modal-danger-text {
		color: var(--color-danger);
	}

	.selected-client-list {
		max-height: 200px;
		overflow-y: auto;
		margin-bottom: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
	}

	.selected-client-list ul {
		margin: 0;
		padding: 12px 20px;
		list-style: disc;
	}

	.selected-client-list li {
		margin-bottom: 4px;
		color: var(--color-text);
	}

	.selected-client-id {
		font-size: 0.875rem;
	}

	.client-capability-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.45rem;
	}

	.client-capability-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem 0.5rem;
		border-radius: var(--radius-control);
		font-size: 0.72rem;
		font-weight: 600;
		background: var(--color-accent-muted);
		color: var(--color-accent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
	}

	.client-name-cell {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.client-description {
		margin-top: 0.25rem;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.35;
	}

	.system-client-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.15rem 0.45rem;
		border-radius: var(--radius-control);
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.row-action-cell {
		color: var(--color-text-subtle);
		font-family: var(--font-meta, var(--font-body));
		letter-spacing: 0.18em;
	}
</style>

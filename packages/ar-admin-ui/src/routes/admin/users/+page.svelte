<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminUsersAPI,
		type User,
		type Pagination,
		type UserListParams
	} from '$lib/api/admin-users';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { normalizeTimestampMs } from '$lib/utils/timestamp';
	import { Modal } from '$lib/components';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPagination from '$lib/components/admin/AdminPagination.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminToolbar from '$lib/components/admin/AdminToolbar.svelte';

	let users: User[] = $state([]);
	let pagination: Pagination | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Search and filter state
	let searchQuery = $state('');
	let statusFilter = $state<'active' | 'suspended' | 'locked' | ''>('');
	let verifiedFilter = $state<boolean | null>(null);
	let currentPage = $state(1);
	const limit = 20;

	// Selection state for bulk delete
	let selectedIds = new SvelteSet<string>();
	let isAllSelected = $derived(users.length > 0 && selectedIds.size === users.length);
	let hasSelection = $derived(selectedIds.size > 0);
	const canCreateUsers = $derived(adminAuth.hasPermission('admin:users:write'));
	const canDeleteUsers = $derived(adminAuth.hasPermission('admin:users:delete'));

	// Bulk delete dialog state
	let showBulkDeleteDialog = $state(false);
	let bulkDeleting = $state(false);
	let bulkDeleteError = $state('');
	let bulkDeleteProgress = $state({ current: 0, total: 0, failed: 0 });

	// Debounce timer for search
	let searchTimeout: ReturnType<typeof setTimeout>;
	let loadedTenantId = $state('');

	async function loadUsers() {
		loading = true;
		error = '';

		try {
			const params: UserListParams = {
				page: currentPage,
				limit
			};

			if (searchQuery.trim()) {
				params.search = searchQuery.trim();
			}
			if (statusFilter) {
				params.status = statusFilter;
			}
			if (verifiedFilter !== null) {
				params.verified = verifiedFilter;
			}

			const response = await adminUsersAPI.list(params);
			users = response.users;
			pagination = response.pagination;
			// Clear selection when page changes
			selectedIds.clear();
		} catch (err) {
			console.error('Failed to load users:', err);
			error = $LL.admin_users_error_load();
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		currentPage = 1;
		loadUsers();
	});

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 1;
			loadUsers();
		}, 300);
	}

	function handleStatusChange() {
		currentPage = 1;
		loadUsers();
	}

	function handleVerifiedChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		if (target.value === '') {
			verifiedFilter = null;
		} else {
			verifiedFilter = target.value === 'true';
		}
		currentPage = 1;
		loadUsers();
	}

	function goToPage(page: number) {
		currentPage = page;
		loadUsers();
	}

	function formatDate(timestamp: number | null): string {
		if (timestamp === null) return '-';
		const date = new Date(normalizeTimestampMs(timestamp));
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function formatStatus(status: string): string {
		switch (status) {
			case 'active':
				return $LL.admin_users_status_active();
			case 'suspended':
				return $LL.admin_users_status_suspended();
			case 'locked':
				return $LL.admin_users_status_locked();
			default:
				return status;
		}
	}

	function getStatusBadgeClass(status: string): string {
		switch (status) {
			case 'active':
				return 'badge badge-success';
			case 'suspended':
				return 'badge badge-warning';
			case 'locked':
				return 'badge badge-danger';
			default:
				return 'badge badge-neutral';
		}
	}

	// Selection functions
	function toggleSelectAll() {
		if (!canDeleteUsers) return;
		if (isAllSelected) {
			selectedIds.clear();
		} else {
			selectedIds.clear();
			users.forEach((u) => selectedIds.add(u.id));
		}
	}

	function toggleSelect(id: string, event: Event) {
		event.stopPropagation();
		if (!canDeleteUsers) return;
		if (selectedIds.has(id)) {
			selectedIds.delete(id);
		} else {
			selectedIds.add(id);
		}
	}

	function openBulkDeleteDialog() {
		if (!canDeleteUsers) return;
		bulkDeleteError = '';
		bulkDeleteProgress = { current: 0, total: selectedIds.size, failed: 0 };
		showBulkDeleteDialog = true;
	}

	function closeBulkDeleteDialog() {
		showBulkDeleteDialog = false;
		bulkDeleteError = '';
	}

	async function executeBulkDelete() {
		bulkDeleting = true;
		bulkDeleteError = '';
		const idsToDelete = Array.from(selectedIds);
		bulkDeleteProgress = { current: 0, total: idsToDelete.length, failed: 0 };

		let failedCount = 0;

		for (let i = 0; i < idsToDelete.length; i++) {
			try {
				await adminUsersAPI.delete(idsToDelete[i]);
			} catch (err) {
				console.error(`Failed to delete user ${idsToDelete[i]}:`, err);
				failedCount++;
			}
			bulkDeleteProgress = {
				current: i + 1,
				total: idsToDelete.length,
				failed: failedCount
			};
		}

		bulkDeleting = false;

		if (failedCount === 0) {
			closeBulkDeleteDialog();
			selectedIds.clear();
			await loadUsers();
		} else if (failedCount < idsToDelete.length) {
			bulkDeleteError = $LL.admin_users_delete_partial_error({ count: failedCount });
			selectedIds.clear();
			await loadUsers();
		} else {
			bulkDeleteError = $LL.admin_users_delete_error();
		}
	}

	function getSelectedUsers(): User[] {
		return users.filter((u) => selectedIds.has(u.id));
	}
</script>

<svelte:head>
	<title>{$LL.admin_users_page_title()}</title>
</svelte:head>

{#snippet headerActions()}
	{#if canDeleteUsers && hasSelection}
		<button class="btn btn-danger" onclick={openBulkDeleteDialog}>
			<i class="i-ph-trash"></i>
			{$LL.admin_users_delete_selected({ count: selectedIds.size })}
		</button>
	{/if}
	{#if canCreateUsers}
		<a href="/admin/users/new" class="btn btn-primary">
			<i class="i-ph-plus"></i>
			{$LL.admin_users_create()}
		</a>
	{/if}
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_users_heading()}
		description={$LL.admin_users_description()}
		actions={headerActions}
	/>

	<AdminToolbar>
		<div class="admin-field admin-field--search">
			<label for="search" class="admin-field__label">{$LL.admin_users_search_label()}</label>
			<input
				id="search"
				type="text"
				class="admin-input"
				placeholder={$LL.admin_users_search_placeholder()}
				bind:value={searchQuery}
				oninput={handleSearch}
			/>
		</div>

		<div class="admin-field admin-field--compact">
			<label for="status" class="admin-field__label">{$LL.admin_users_status_label()}</label>
			<select
				id="status"
				class="admin-select"
				bind:value={statusFilter}
				onchange={handleStatusChange}
			>
				<option value="">{$LL.admin_users_all()}</option>
				<option value="active">{$LL.admin_users_status_active()}</option>
				<option value="suspended">{$LL.admin_users_status_suspended()}</option>
				<option value="locked">{$LL.admin_users_status_locked()}</option>
			</select>
		</div>

		<div class="admin-field admin-field--compact">
			<label for="verified" class="admin-field__label">{$LL.admin_users_verified_label()}</label>
			<select id="verified" class="admin-select" onchange={handleVerifiedChange}>
				<option value="">{$LL.admin_users_all()}</option>
				<option value="true">{$LL.admin_users_verified()}</option>
				<option value="false">{$LL.admin_users_unverified()}</option>
			</select>
		</div>
	</AdminToolbar>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_users_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if users.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p>{$LL.admin_users_empty()}</p>
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
								disabled={!canDeleteUsers}
								aria-label={$LL.admin_users_select_all()}
							/>
						</th>
						<th>{$LL.admin_users_email()}</th>
						<th>{$LL.admin_users_name()}</th>
						<th>{$LL.admin_users_status()}</th>
						<th>{$LL.admin_users_verified_label()}</th>
						<th>{$LL.admin_users_created()}</th>
						<th>{$LL.admin_users_lastLogin()}</th>
					</tr>
				</thead>
				<tbody>
					{#each users as user (user.id)}
						<tr
							class:selected={selectedIds.has(user.id)}
							onclick={() => goto(`/admin/users/${user.id}`)}
							onkeydown={(e) => e.key === 'Enter' && goto(`/admin/users/${user.id}`)}
							tabindex="0"
							role="button"
						>
							<td onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									class="checkbox"
									checked={selectedIds.has(user.id)}
									onchange={(e) => toggleSelect(user.id, e)}
									disabled={!canDeleteUsers}
									aria-label={$LL.admin_users_select_user({ user: user.email || user.id })}
								/>
							</td>
							<td>{user.email || '-'}</td>
							<td>{user.name || '-'}</td>
							<td>
								<span class={getStatusBadgeClass(user.status)}>{formatStatus(user.status)}</span>
							</td>
							<td>
								{#if user.email_verified}
									<span class="check-icon">✓</span>
								{:else}
									<span class="cross-icon">-</span>
								{/if}
							</td>
							<td class="muted">{formatDate(user.created_at)}</td>
							<td class="muted">{formatDate(user.last_login_at)}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		{#if pagination && pagination.totalPages > 1}
			<AdminPagination
				label={$LL.admin_users_heading()}
				info={$LL.admin_users_pagination({
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
	title={$LL.admin_users_delete_title({ count: selectedIds.size })}
	size="md"
>
	<div class="alert alert-error users-delete-warning">
		<p class="users-delete-warning__title">{$LL.admin_users_delete_warning_title()}</p>
		<p class="users-delete-warning__description">
			{$LL.admin_users_delete_warning_desc()}
		</p>
	</div>

	<div class="users-delete-list">
		<p class="users-delete-list__title">
			{$LL.admin_users_delete_list_title()}
		</p>
		<div class="users-delete-list__items">
			{#each getSelectedUsers() as user (user.id)}
				<div class="users-delete-list__item">
					<span class="users-delete-list__email">{user.email || user.id}</span>
					{#if user.name}
						<span class="users-delete-list__name">({user.name})</span>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if bulkDeleting}
		<div class="users-delete-progress">
			<progress
				class:warning={bulkDeleteProgress.failed > 0}
				value={bulkDeleteProgress.current}
				max={bulkDeleteProgress.total}
			></progress>
			<p class="users-delete-progress__text">
				{$LL.admin_users_deleting_progress({
					current: bulkDeleteProgress.current,
					total: bulkDeleteProgress.total
				})}
				{#if bulkDeleteProgress.failed > 0}
					<span class="users-delete-progress__failed">
						{$LL.admin_users_delete_failed_count({ count: bulkDeleteProgress.failed })}
					</span>
				{/if}
			</p>
		</div>
	{/if}

	{#if bulkDeleteError}
		<div class="alert alert-error">{bulkDeleteError}</div>
	{/if}
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeBulkDeleteDialog} disabled={bulkDeleting}>
			{$LL.common_cancel()}
		</button>
		<button class="btn btn-danger" onclick={executeBulkDelete} disabled={bulkDeleting}>
			{bulkDeleting
				? $LL.admin_users_deleting()
				: $LL.admin_users_delete_action({ count: selectedIds.size })}
		</button>
	{/snippet}
</Modal>

<style>
	:global(.admin-data-table-wrap tr[role='button']) {
		cursor: pointer;
	}

	:global(.admin-data-table-wrap tr.selected) {
		background: var(--color-accent-muted);
	}

	.users-delete-warning,
	.users-delete-list,
	.users-delete-progress {
		margin-bottom: 16px;
	}

	.users-delete-warning__title {
		margin: 0;
		font-weight: 700;
	}

	.users-delete-warning__description {
		margin: 8px 0 0;
		font-size: 0.875rem;
	}

	.users-delete-list__title {
		margin: 0 0 8px;
		color: var(--color-text);
		font-weight: 700;
	}

	.users-delete-list__items {
		max-height: 200px;
		overflow-y: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
	}

	.users-delete-list__item {
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
		font-size: 0.875rem;
	}

	.users-delete-list__item:last-child {
		border-bottom: 0;
	}

	.users-delete-list__email {
		color: var(--color-text);
	}

	.users-delete-list__name {
		margin-left: 8px;
		color: var(--color-text-muted);
	}

	.users-delete-progress progress {
		width: 100%;
		height: 8px;
		overflow: hidden;
		border: 0;
		border-radius: 999px;
		background: var(--color-border);
	}

	.users-delete-progress progress::-webkit-progress-bar {
		background: var(--color-border);
	}

	.users-delete-progress progress::-webkit-progress-value {
		background: var(--color-accent);
	}

	.users-delete-progress progress.warning::-webkit-progress-value {
		background: var(--color-warning);
	}

	.users-delete-progress progress::-moz-progress-bar {
		background: var(--color-accent);
	}

	.users-delete-progress progress.warning::-moz-progress-bar {
		background: var(--color-warning);
	}

	.users-delete-progress__text {
		margin: 8px 0 0;
		color: var(--color-text-muted);
		text-align: center;
		font-size: 0.75rem;
	}

	.users-delete-progress__failed {
		color: var(--color-danger);
	}
</style>

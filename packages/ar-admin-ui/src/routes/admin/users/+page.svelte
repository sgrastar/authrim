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
	import { Modal } from '$lib/components';
	import { getLocale, LL } from '$i18n/i18n-svelte';

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
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
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

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_users_heading()}</h1>
			<p class="page-description">{$LL.admin_users_description()}</p>
		</div>
		<div class="page-actions">
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
		</div>
	</div>

	<!-- Search and Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label for="search" class="form-label">{$LL.admin_users_search_label()}</label>
				<input
					id="search"
					type="text"
					class="form-input"
					placeholder={$LL.admin_users_search_placeholder()}
					bind:value={searchQuery}
					oninput={handleSearch}
				/>
			</div>

			<div class="form-group">
				<label for="status" class="form-label">{$LL.admin_users_status_label()}</label>
				<select
					id="status"
					class="form-select"
					bind:value={statusFilter}
					onchange={handleStatusChange}
				>
					<option value="">{$LL.admin_users_all()}</option>
					<option value="active">{$LL.admin_users_status_active()}</option>
					<option value="suspended">{$LL.admin_users_status_suspended()}</option>
					<option value="locked">{$LL.admin_users_status_locked()}</option>
				</select>
			</div>

			<div class="form-group">
				<label for="verified" class="form-label">{$LL.admin_users_verified_label()}</label>
				<select id="verified" class="form-select" onchange={handleVerifiedChange}>
					<option value="">{$LL.admin_users_all()}</option>
					<option value="true">{$LL.admin_users_verified()}</option>
					<option value="false">{$LL.admin_users_unverified()}</option>
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_users_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if users.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p>{$LL.admin_users_empty()}</p>
			</div>
		</div>
	{:else}
		<!-- Users Table -->
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
			</table>
		</div>

		<!-- Pagination -->
		{#if pagination && pagination.totalPages > 1}
			<div class="pagination">
				<p class="pagination-info">
					{$LL.admin_users_pagination({
						start: (pagination.page - 1) * pagination.limit + 1,
						end: Math.min(pagination.page * pagination.limit, pagination.total),
						total: pagination.total
					})}
				</p>
				<div class="pagination-buttons">
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage - 1)}
						disabled={!pagination.hasPrev}
					>
						{$LL.common_previous()}
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage + 1)}
						disabled={!pagination.hasNext}
					>
						{$LL.common_next()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Bulk Delete Confirmation Dialog -->
<Modal
	open={showBulkDeleteDialog}
	onClose={closeBulkDeleteDialog}
	title={$LL.admin_users_delete_title({ count: selectedIds.size })}
	size="md"
>
	<div class="alert alert-error" style="margin-bottom: 16px;">
		<p style="margin: 0; font-weight: 500;">{$LL.admin_users_delete_warning_title()}</p>
		<p style="margin: 8px 0 0 0; font-size: 0.875rem;">
			{$LL.admin_users_delete_warning_desc()}
		</p>
	</div>

	<div style="margin-bottom: 16px;">
		<p style="font-weight: 500; margin: 0 0 8px 0; color: var(--text-primary);">
			{$LL.admin_users_delete_list_title()}
		</p>
		<div class="panel" style="max-height: 200px; overflow-y: auto; padding: 0;">
			{#each getSelectedUsers() as user (user.id)}
				<div
					style="padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 0.875rem;"
				>
					<span style="color: var(--text-primary);">{user.email || user.id}</span>
					{#if user.name}
						<span style="color: var(--text-secondary); margin-left: 8px;">({user.name})</span>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if bulkDeleting}
		<div style="margin-bottom: 16px;">
			<div class="progress-bar">
				<div
					class="progress-bar-fill"
					class:warning={bulkDeleteProgress.failed > 0}
					style="width: {(bulkDeleteProgress.current / bulkDeleteProgress.total) * 100}%;"
				></div>
			</div>
			<p
				style="font-size: 0.75rem; color: var(--text-secondary); margin: 8px 0 0 0; text-align: center;"
			>
				{$LL.admin_users_deleting_progress({
					current: bulkDeleteProgress.current,
					total: bulkDeleteProgress.total
				})}
				{#if bulkDeleteProgress.failed > 0}
					<span style="color: var(--danger);">
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

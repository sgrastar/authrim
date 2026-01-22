<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminUsersAPI,
		type User,
		type Pagination,
		type UserListParams
	} from '$lib/api/admin-users';

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

	// Bulk delete dialog state
	let showBulkDeleteDialog = $state(false);
	let bulkDeleting = $state(false);
	let bulkDeleteError = $state('');
	let bulkDeleteProgress = $state({ current: 0, total: 0, failed: 0 });

	// Debounce timer for search
	let searchTimeout: ReturnType<typeof setTimeout>;

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
			error = 'Failed to load users';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
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
		return new Date(timestamp).toLocaleDateString();
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
		if (isAllSelected) {
			selectedIds.clear();
		} else {
			selectedIds.clear();
			users.forEach((u) => selectedIds.add(u.id));
		}
	}

	function toggleSelect(id: string, event: Event) {
		event.stopPropagation();
		if (selectedIds.has(id)) {
			selectedIds.delete(id);
		} else {
			selectedIds.add(id);
		}
	}

	function openBulkDeleteDialog() {
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
			bulkDeleteError = `${failedCount} user(s) failed to delete. Others were deleted successfully.`;
			selectedIds.clear();
			await loadUsers();
		} else {
			bulkDeleteError = 'Failed to delete users. Please try again.';
		}
	}

	function getSelectedUsers(): User[] {
		return users.filter((u) => selectedIds.has(u.id));
	}
</script>

<svelte:head>
	<title>Users - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Users</h1>
			<p class="page-description">Manage user accounts and access</p>
		</div>
		<div class="page-actions">
			{#if hasSelection}
				<button class="btn btn-danger" onclick={openBulkDeleteDialog}>
					<i class="i-ph-trash"></i>
					Delete Selected ({selectedIds.size})
				</button>
			{/if}
			<a href="/admin/users/new" class="btn btn-primary">
				<i class="i-ph-plus"></i>
				Create User
			</a>
		</div>
	</div>

	<!-- Search and Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label for="search" class="form-label">Search</label>
				<input
					id="search"
					type="text"
					class="form-input"
					placeholder="Search by email or name..."
					bind:value={searchQuery}
					oninput={handleSearch}
				/>
			</div>

			<div class="form-group">
				<label for="status" class="form-label">Status</label>
				<select
					id="status"
					class="form-select"
					bind:value={statusFilter}
					onchange={handleStatusChange}
				>
					<option value="">All</option>
					<option value="active">Active</option>
					<option value="suspended">Suspended</option>
					<option value="locked">Locked</option>
				</select>
			</div>

			<div class="form-group">
				<label for="verified" class="form-label">Email Verified</label>
				<select id="verified" class="form-select" onchange={handleVerifiedChange}>
					<option value="">All</option>
					<option value="true">Verified</option>
					<option value="false">Unverified</option>
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading users...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if users.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p>No users found</p>
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
								aria-label="Select all users"
							/>
						</th>
						<th>Email</th>
						<th>Name</th>
						<th>Status</th>
						<th>Verified</th>
						<th>Created</th>
						<th>Last Login</th>
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
									aria-label="Select {user.email || user.id}"
								/>
							</td>
							<td>{user.email || '-'}</td>
							<td>{user.name || '-'}</td>
							<td>
								<span class={getStatusBadgeClass(user.status)}>{user.status}</span>
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
					Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(
						pagination.page * pagination.limit,
						pagination.total
					)} of {pagination.total} users
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
		tabindex="-1"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">
					Delete {selectedIds.size} User{selectedIds.size === 1 ? '' : 's'}
				</h2>
			</div>

			<div class="modal-body">
				<div class="alert alert-error" style="margin-bottom: 16px;">
					<p style="margin: 0; font-weight: 500;">⚠️ This action cannot be undone</p>
					<p style="margin: 8px 0 0 0; font-size: 0.875rem;">
						The selected users will be permanently deleted.
					</p>
				</div>

				<div style="margin-bottom: 16px;">
					<p style="font-weight: 500; margin: 0 0 8px 0; color: var(--text-primary);">
						Users to be deleted:
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
							Deleting {bulkDeleteProgress.current} of {bulkDeleteProgress.total}...
							{#if bulkDeleteProgress.failed > 0}
								<span style="color: var(--danger);">({bulkDeleteProgress.failed} failed)</span>
							{/if}
						</p>
					</div>
				{/if}

				{#if bulkDeleteError}
					<div class="alert alert-error">{bulkDeleteError}</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeBulkDeleteDialog} disabled={bulkDeleting}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={executeBulkDelete} disabled={bulkDeleting}>
					{bulkDeleting
						? 'Deleting...'
						: `Delete ${selectedIds.size} User${selectedIds.size === 1 ? '' : 's'}`}
				</button>
			</div>
		</div>
	</div>
{/if}

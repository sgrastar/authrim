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

	function getStatusBadgeStyle(status: string): string {
		switch (status) {
			case 'active':
				return 'background-color: #d1fae5; color: #065f46;';
			case 'suspended':
				return 'background-color: #fef3c7; color: #92400e;';
			case 'locked':
				return 'background-color: #fee2e2; color: #991b1b;';
			default:
				return 'background-color: #e5e7eb; color: #374151;';
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

<div>
	<div
		style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;"
	>
		<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0;">Users</h1>
		<div style="display: flex; gap: 12px; align-items: center;">
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
				href="/admin/users/new"
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
				Create User
			</a>
		</div>
	</div>

	<!-- Search and Filters -->
	<div
		style="background-color: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
	>
		<div style="display: flex; gap: 16px; flex-wrap: wrap;">
			<!-- Search -->
			<div style="flex: 1; min-width: 200px;">
				<label
					for="search"
					style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;">Search</label
				>
				<input
					id="search"
					type="text"
					placeholder="Search by email or name..."
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

			<!-- Status Filter -->
			<div style="min-width: 150px;">
				<label
					for="status"
					style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;">Status</label
				>
				<select
					id="status"
					bind:value={statusFilter}
					onchange={handleStatusChange}
					style="
						width: 100%;
						padding: 8px 12px;
						border: 1px solid #d1d5db;
						border-radius: 4px;
						font-size: 14px;
						background-color: white;
					"
				>
					<option value="">All</option>
					<option value="active">Active</option>
					<option value="suspended">Suspended</option>
					<option value="locked">Locked</option>
				</select>
			</div>

			<!-- Verified Filter -->
			<div style="min-width: 150px;">
				<label
					for="verified"
					style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
					>Email Verified</label
				>
				<select
					id="verified"
					onchange={handleVerifiedChange}
					style="
						width: 100%;
						padding: 8px 12px;
						border: 1px solid #d1d5db;
						border-radius: 4px;
						font-size: 14px;
						background-color: white;
					"
				>
					<option value="">All</option>
					<option value="true">Verified</option>
					<option value="false">Unverified</option>
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<p style="color: #6b7280; text-align: center; padding: 40px;">Loading users...</p>
	{:else if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;"
		>
			{error}
		</div>
	{:else if users.length === 0}
		<div
			style="background-color: white; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center;"
		>
			<p style="color: #9ca3af; margin: 0;">No users found</p>
		</div>
	{:else}
		<!-- Users Table -->
		<div
			style="background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden;"
		>
			<table style="width: 100%; border-collapse: collapse;">
				<thead>
					<tr style="background-color: #f9fafb; border-bottom: 1px solid #e5e7eb;">
						<th style="width: 40px; padding: 12px 16px;">
							<input
								type="checkbox"
								checked={isAllSelected}
								onchange={toggleSelectAll}
								style="width: 16px; height: 16px; cursor: pointer;"
								aria-label="Select all users"
							/>
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Email</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Name</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Status</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Verified</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Created</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Last Login</th
						>
					</tr>
				</thead>
				<tbody>
					{#each users as user (user.id)}
						<tr
							style="border-bottom: 1px solid #e5e7eb; cursor: pointer; {selectedIds.has(user.id)
								? 'background-color: #eff6ff;'
								: ''}"
							onclick={() => goto(`/admin/users/${user.id}`)}
							onkeydown={(e) => e.key === 'Enter' && goto(`/admin/users/${user.id}`)}
							tabindex="0"
							role="button"
						>
							<td style="padding: 12px 16px;" onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									checked={selectedIds.has(user.id)}
									onchange={(e) => toggleSelect(user.id, e)}
									style="width: 16px; height: 16px; cursor: pointer;"
									aria-label="Select {user.email || user.id}"
								/>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #1f2937;">
								{user.email || '-'}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #1f2937;">
								{user.name || '-'}
							</td>
							<td style="padding: 12px 16px;">
								<span
									style="
									display: inline-block;
									padding: 2px 8px;
									border-radius: 12px;
									font-size: 12px;
									font-weight: 500;
									{getStatusBadgeStyle(user.status)}
								"
								>
									{user.status}
								</span>
							</td>
							<td style="padding: 12px 16px; font-size: 14px;">
								{#if user.email_verified}
									<span style="color: #059669;">✓</span>
								{:else}
									<span style="color: #9ca3af;">-</span>
								{/if}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{formatDate(user.created_at)}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{formatDate(user.last_login_at)}
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
					)} of {pagination.total} users
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
			inset: 0;
			background-color: rgba(0, 0, 0, 0.5);
			display: flex;
			justify-content: center;
			align-items: center;
			z-index: 50;
		"
		onclick={closeBulkDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeBulkDeleteDialog()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			style="
				background-color: white;
				border-radius: 8px;
				padding: 24px;
				max-width: 500px;
				width: 90%;
				max-height: 80vh;
				overflow-y: auto;
				box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">
				Delete {selectedIds.size} User{selectedIds.size === 1 ? '' : 's'}
			</h2>

			<div
				style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px; margin-bottom: 16px;"
			>
				<p style="color: #991b1b; font-size: 14px; margin: 0; font-weight: 500;">
					⚠️ This action cannot be undone
				</p>
				<p style="color: #7f1d1d; font-size: 13px; margin: 8px 0 0 0;">
					The selected users will be permanently deleted.
				</p>
			</div>

			<div style="margin-bottom: 16px;">
				<p style="font-size: 14px; color: #374151; margin: 0 0 8px 0; font-weight: 500;">
					Users to be deleted:
				</p>
				<div
					style="max-height: 200px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 6px;"
				>
					{#each getSelectedUsers() as user (user.id)}
						<div
							style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px;"
						>
							<span style="color: #1f2937;">{user.email || user.id}</span>
							{#if user.name}
								<span style="color: #6b7280; margin-left: 8px;">({user.name})</span>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			{#if bulkDeleting}
				<div style="margin-bottom: 16px;">
					<div
						style="height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden;"
					>
						<div
							style="height: 100%; background-color: {bulkDeleteProgress.failed > 0
								? '#f59e0b'
								: '#3b82f6'}; transition: width 0.3s; width: {(bulkDeleteProgress.current /
								bulkDeleteProgress.total) *
								100}%;"
						></div>
					</div>
					<p style="font-size: 12px; color: #6b7280; margin: 8px 0 0 0; text-align: center;">
						Deleting {bulkDeleteProgress.current} of {bulkDeleteProgress.total}...
						{#if bulkDeleteProgress.failed > 0}
							<span style="color: #dc2626;">({bulkDeleteProgress.failed} failed)</span>
						{/if}
					</p>
				</div>
			{/if}

			{#if bulkDeleteError}
				<div
					style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 8px 12px; border-radius: 4px; font-size: 14px; margin-bottom: 16px;"
				>
					{bulkDeleteError}
				</div>
			{/if}

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeBulkDeleteDialog}
					disabled={bulkDeleting}
					style="
						padding: 10px 20px;
						background-color: white;
						color: #374151;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						cursor: pointer;
					"
				>
					Cancel
				</button>
				<button
					onclick={executeBulkDelete}
					disabled={bulkDeleting}
					style="
						padding: 10px 20px;
						background-color: #dc2626;
						color: white;
						border: none;
						border-radius: 6px;
						font-size: 14px;
						cursor: {bulkDeleting ? 'not-allowed' : 'pointer'};
						opacity: {bulkDeleting ? 0.7 : 1};
					"
				>
					{bulkDeleting ? 'Deleting...' : `Delete ${selectedIds.size} User${selectedIds.size === 1 ? '' : 's'}`}
				</button>
			</div>
		</div>
	</div>
{/if}

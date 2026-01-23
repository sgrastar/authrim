<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { adminAdminsAPI, type AdminUser, type AdminUserListParams } from '$lib/api/admin-admins';

	let admins: AdminUser[] = $state([]);
	let total = $state(0);
	let totalPages = $state(0);
	let loading = $state(true);
	let error = $state('');

	// Search and filter state
	let searchQuery = $state('');
	let statusFilter = $state<'active' | 'suspended' | 'locked' | ''>('');
	let mfaFilter = $state<boolean | null>(null);
	let currentPage = $state(1);
	const limit = 20;

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newAdminEmail = $state('');
	let newAdminName = $state('');

	// Debounce timer for search
	let searchTimeout: ReturnType<typeof setTimeout>;

	async function loadAdmins() {
		loading = true;
		error = '';

		try {
			const params: AdminUserListParams = {
				page: currentPage,
				limit
			};

			if (searchQuery.trim()) {
				params.email = searchQuery.trim();
			}
			if (statusFilter) {
				params.status = statusFilter;
			}
			if (mfaFilter !== null) {
				params.mfa_enabled = mfaFilter;
			}

			const response = await adminAdminsAPI.list(params);
			admins = response.items;
			total = response.total;
			totalPages = response.totalPages;
		} catch (err) {
			console.error('Failed to load admin users:', err);
			error = err instanceof Error ? err.message : 'Failed to load admin users';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadAdmins();
	});

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 1;
			loadAdmins();
		}, 300);
	}

	function handleStatusChange() {
		currentPage = 1;
		loadAdmins();
	}

	function handleMfaChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		if (target.value === '') {
			mfaFilter = null;
		} else {
			mfaFilter = target.value === 'true';
		}
		currentPage = 1;
		loadAdmins();
	}

	function goToPage(page: number) {
		currentPage = page;
		loadAdmins();
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

	function openCreateDialog() {
		newAdminEmail = '';
		newAdminName = '';
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function handleCreate() {
		if (!newAdminEmail.trim()) {
			createError = 'Email is required';
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminAdminsAPI.create({
				email: newAdminEmail.trim(),
				name: newAdminName.trim() || undefined
			});
			closeCreateDialog();
			loadAdmins();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create admin user';
		} finally {
			creating = false;
		}
	}

	async function handleSuspend(admin: AdminUser) {
		if (!confirm(`Are you sure you want to suspend ${admin.email}?`)) return;

		try {
			await adminAdminsAPI.suspend(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to suspend admin user');
		}
	}

	async function handleActivate(admin: AdminUser) {
		try {
			await adminAdminsAPI.activate(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to activate admin user');
		}
	}

	async function handleUnlock(admin: AdminUser) {
		try {
			await adminAdminsAPI.unlock(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to unlock admin user');
		}
	}
</script>

<svelte:head>
	<title>Admin Users - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Admin Users</h1>
			<p class="page-description">Manage administrator accounts for the Admin panel</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				Add Admin
			</button>
		</div>
	</div>

	<!-- Filters -->
	<div class="filters-bar">
		<div class="filter-group">
			<input
				type="text"
				class="input"
				placeholder="Search by email..."
				bind:value={searchQuery}
				oninput={handleSearch}
			/>
		</div>
		<div class="filter-group">
			<select class="select" bind:value={statusFilter} onchange={handleStatusChange}>
				<option value="">All Statuses</option>
				<option value="active">Active</option>
				<option value="suspended">Suspended</option>
				<option value="locked">Locked</option>
			</select>
		</div>
		<div class="filter-group">
			<select class="select" onchange={handleMfaChange}>
				<option value="">All MFA</option>
				<option value="true">MFA Enabled</option>
				<option value="false">MFA Disabled</option>
			</select>
		</div>
	</div>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>Loading admin users...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadAdmins}>Retry</button>
		</div>
	{:else if admins.length === 0}
		<div class="empty-state">
			<p>No admin users found</p>
			{#if searchQuery || statusFilter || mfaFilter !== null}
				<button
					class="btn btn-secondary"
					onclick={() => {
						searchQuery = '';
						statusFilter = '';
						mfaFilter = null;
						loadAdmins();
					}}
				>
					Clear Filters
				</button>
			{/if}
		</div>
	{:else}
		<div class="table-container">
			<table class="table">
				<thead>
					<tr>
						<th>Email</th>
						<th>Name</th>
						<th>Status</th>
						<th>MFA</th>
						<th>Last Login</th>
						<th>Created</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each admins as admin (admin.id)}
						<tr class="clickable" onclick={() => goto(`/admin/admins/${admin.id}`)}>
							<td>{admin.email}</td>
							<td>{admin.name || '-'}</td>
							<td>
								<span class={getStatusBadgeClass(admin.status)}>
									{admin.status}
								</span>
							</td>
							<td>
								{#if admin.mfa_enabled}
									<span class="badge badge-success">Enabled</span>
								{:else}
									<span class="badge badge-neutral">Disabled</span>
								{/if}
							</td>
							<td>{formatDate(admin.last_login_at)}</td>
							<td>{formatDate(admin.created_at)}</td>
							<td>
								<div class="action-buttons" onclick={(e) => e.stopPropagation()}>
									{#if admin.status === 'active'}
										<button
											class="btn btn-sm btn-warning"
											onclick={() => handleSuspend(admin)}
											title="Suspend"
										>
											Suspend
										</button>
									{:else if admin.status === 'suspended'}
										<button
											class="btn btn-sm btn-success"
											onclick={() => handleActivate(admin)}
											title="Activate"
										>
											Activate
										</button>
									{:else if admin.status === 'locked'}
										<button
											class="btn btn-sm btn-primary"
											onclick={() => handleUnlock(admin)}
											title="Unlock"
										>
											Unlock
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="pagination">
				<span class="pagination-info">
					Showing {(currentPage - 1) * limit + 1} - {Math.min(currentPage * limit, total)} of {total}
				</span>
				<div class="pagination-buttons">
					<button
						class="btn btn-sm btn-secondary"
						disabled={currentPage <= 1}
						onclick={() => goToPage(currentPage - 1)}
					>
						Previous
					</button>
					<button
						class="btn btn-sm btn-secondary"
						disabled={currentPage >= totalPages}
						onclick={() => goToPage(currentPage + 1)}
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Create Admin Dialog -->
{#if showCreateDialog}
	<div class="dialog-overlay" onclick={closeCreateDialog}>
		<div class="dialog" onclick={(e) => e.stopPropagation()}>
			<div class="dialog-header">
				<h2>Create Admin User</h2>
				<button class="close-btn" onclick={closeCreateDialog}>&times;</button>
			</div>
			<div class="dialog-body">
				{#if createError}
					<div class="alert alert-danger">{createError}</div>
				{/if}
				<div class="form-group">
					<label for="email">Email *</label>
					<input
						type="email"
						id="email"
						class="input"
						bind:value={newAdminEmail}
						placeholder="admin@example.com"
					/>
				</div>
				<div class="form-group">
					<label for="name">Name</label>
					<input
						type="text"
						id="name"
						class="input"
						bind:value={newAdminName}
						placeholder="John Doe"
					/>
				</div>
			</div>
			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Page-specific styles for Admin Users */

	/* Filters */
	.filters-bar {
		display: flex;
		gap: 1rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}

	.filter-group {
		flex: 1;
		min-width: 150px;
		max-width: 250px;
	}

	.input,
	.select {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.input:focus,
	.select:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-subtle);
	}

	/* Table */
	.table-container {
		overflow-x: auto;
		background: var(--bg-card);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border);
	}

	.table {
		width: 100%;
		border-collapse: collapse;
	}

	.table th,
	.table td {
		padding: 0.75rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
	}

	.table th {
		font-weight: 600;
		font-size: 0.75rem;
		text-transform: uppercase;
		color: var(--text-secondary);
		background: var(--bg-subtle);
	}

	.table tr.clickable {
		cursor: pointer;
	}

	.table tr.clickable:hover {
		background: var(--bg-subtle);
	}

	.action-buttons {
		display: flex;
		gap: 0.5rem;
	}

	/* Error state */
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--text-secondary);
	}

	.error-text {
		color: var(--danger);
		margin-bottom: 1rem;
	}

	/* Dialog extensions (not in global) */
	.dialog-body {
		padding: 1.5rem;
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.5rem;
		border-top: 1px solid var(--border);
	}

	/* Alert for dialog errors */
	.alert-danger {
		background: var(--danger-subtle);
		color: var(--danger);
	}
</style>

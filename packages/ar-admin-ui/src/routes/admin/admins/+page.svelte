<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { adminAdminsAPI, type AdminUser, type AdminUserListParams } from '$lib/api/admin-admins';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

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
			error = err instanceof Error ? err.message : $LL.admin_admins_load_failed();
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
		return new Date(timestamp).toLocaleDateString(undefined);
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

	function statusLabel(status: string): string {
		switch (status) {
			case 'active':
				return $LL.admin_admins_active();
			case 'suspended':
				return $LL.admin_admins_suspended();
			case 'locked':
				return $LL.admin_admins_locked();
			default:
				return status;
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
			createError = $LL.admin_admins_email_required();
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
			createError = err instanceof Error ? err.message : $LL.admin_admins_create_failed();
		} finally {
			creating = false;
		}
	}

	async function handleSuspend(admin: AdminUser) {
		if (!confirm($LL.admin_admins_suspend_confirm({ email: admin.email }))) return;

		try {
			await adminAdminsAPI.suspend(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_suspend_failed());
		}
	}

	async function handleActivate(admin: AdminUser) {
		try {
			await adminAdminsAPI.activate(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_activate_failed());
		}
	}

	async function handleUnlock(admin: AdminUser) {
		try {
			await adminAdminsAPI.unlock(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_unlock_failed());
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_admins_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_admins_title()}</h1>
			<p class="page-description">{$LL.admin_admins_description()}</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				{$LL.admin_admins_add()}
			</button>
		</div>
	</div>

	<!-- Filters -->
	<div class="filters-bar">
		<div class="filter-group">
			<input
				type="text"
				class="input"
				placeholder={$LL.admin_admins_search_placeholder()}
				bind:value={searchQuery}
				oninput={handleSearch}
			/>
		</div>
		<div class="filter-group">
			<select class="select" bind:value={statusFilter} onchange={handleStatusChange}>
				<option value="">{$LL.admin_admins_all_statuses()}</option>
				<option value="active">{$LL.admin_admins_active()}</option>
				<option value="suspended">{$LL.admin_admins_suspended()}</option>
				<option value="locked">{$LL.admin_admins_locked()}</option>
			</select>
		</div>
		<div class="filter-group">
			<select class="select" onchange={handleMfaChange}>
				<option value="">{$LL.admin_admins_all_mfa()}</option>
				<option value="true">{$LL.admin_admins_mfa_enabled()}</option>
				<option value="false">{$LL.admin_admins_mfa_disabled()}</option>
			</select>
		</div>
	</div>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>{$LL.admin_admins_loading()}</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadAdmins}>{$LL.admin_admins_retry()}</button>
		</div>
	{:else if admins.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_admins_empty()}</p>
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
					{$LL.admin_admins_clear_filters()}
				</button>
			{/if}
		</div>
	{:else}
		<div class="table-container">
			<table class="table">
				<thead>
					<tr>
						<th>{$LL.admin_admins_email()}</th>
						<th>{$LL.admin_admins_name()}</th>
						<th>{$LL.admin_admins_status()}</th>
						<th>{$LL.admin_admins_mfa()}</th>
						<th>{$LL.admin_admins_last_login()}</th>
						<th>{$LL.admin_admins_created()}</th>
						<th>{$LL.admin_admins_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each admins as admin (admin.id)}
						<tr class="clickable" onclick={() => goto(`/admin/admins/${admin.id}`)}>
							<td>{admin.email}</td>
							<td>{admin.name || '-'}</td>
							<td>
								<span class={getStatusBadgeClass(admin.status)}>
									{statusLabel(admin.status)}
								</span>
							</td>
							<td>
								{#if admin.mfa_enabled}
									<span class="badge badge-success">{$LL.admin_admins_enabled()}</span>
								{:else}
									<span class="badge badge-neutral">{$LL.admin_admins_disabled()}</span>
								{/if}
							</td>
							<td>{formatDate(admin.last_login_at)}</td>
							<td>{formatDate(admin.created_at)}</td>
							<td>
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<div
									class="action-buttons"
									onclick={(e) => e.stopPropagation()}
									onkeydown={(e) => e.stopPropagation()}
									role="group"
								>
									{#if admin.status === 'active'}
										<button
											class="btn btn-sm btn-warning"
											onclick={() => handleSuspend(admin)}
											title={$LL.admin_admins_suspend()}
										>
											{$LL.admin_admins_suspend()}
										</button>
									{:else if admin.status === 'suspended'}
										<button
											class="btn btn-sm btn-success"
											onclick={() => handleActivate(admin)}
											title={$LL.admin_admins_activate()}
										>
											{$LL.admin_admins_activate()}
										</button>
									{:else if admin.status === 'locked'}
										<button
											class="btn btn-sm btn-primary"
											onclick={() => handleUnlock(admin)}
											title={$LL.admin_admins_unlock()}
										>
											{$LL.admin_admins_unlock()}
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
					{$LL.admin_admins_pagination({
						from: (currentPage - 1) * limit + 1,
						to: Math.min(currentPage * limit, total),
						total
					})}
				</span>
				<div class="pagination-buttons">
					<button
						class="btn btn-sm btn-secondary"
						disabled={currentPage <= 1}
						onclick={() => goToPage(currentPage - 1)}
					>
						{$LL.admin_admins_previous()}
					</button>
					<button
						class="btn btn-sm btn-secondary"
						disabled={currentPage >= totalPages}
						onclick={() => goToPage(currentPage + 1)}
					>
						{$LL.admin_admins_next()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Create Admin Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_admins_create_title()}
	size="md"
>
	{#if createError}
		<div class="alert alert-danger">{createError}</div>
	{/if}
	<div class="form-group">
		<label for="email">{$LL.admin_admins_email()} *</label>
		<input
			type="email"
			id="email"
			class="input"
			bind:value={newAdminEmail}
			placeholder="admin@example.com"
		/>
	</div>
	<div class="form-group">
		<label for="name">{$LL.admin_admins_name()}</label>
		<input type="text" id="name" class="input" bind:value={newAdminName} placeholder="John Doe" />
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_admins_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
			{creating ? $LL.admin_admins_creating() : $LL.admin_admins_create()}
		</button>
	{/snippet}
</Modal>

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

	/* Alert for dialog errors */
	.alert-danger {
		background: var(--danger-subtle);
		color: var(--danger);
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		adminRolesAPI,
		type Role,
		getRoleType,
		canDeleteRole,
		type RoleType
	} from '$lib/api/admin-roles';
	import RoleAssignmentRules from '$lib/components/admin/RoleAssignmentRules.svelte';

	let roles: Role[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Tab state - 'roles' or 'rules'
	let activeTab = $derived($page.url.searchParams.get('tab') || 'roles');

	// Filter state
	let filterType: 'all' | RoleType = $state('all');

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let roleToDelete: Role | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	// Filtered roles
	let filteredRoles = $derived.by(() => {
		if (filterType === 'all') {
			return roles;
		}
		return roles.filter((role) => getRoleType(role) === filterType);
	});

	async function loadRoles() {
		loading = true;
		error = '';

		try {
			const response = await adminRolesAPI.list();
			roles = response.roles;
		} catch (err) {
			console.error('Failed to load roles:', err);
			error = 'Failed to load roles';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadRoles();
	});

	function switchTab(tab: string) {
		const url = new URL($page.url);
		if (tab === 'roles') {
			url.searchParams.delete('tab');
		} else {
			url.searchParams.set('tab', tab);
		}
		goto(url.toString(), { replaceState: true, noScroll: true });
	}

	function navigateToRole(role: Role) {
		goto(`/admin/roles/${role.id}`);
	}

	function navigateToCreate() {
		goto('/admin/roles/new');
	}

	function openDeleteDialog(role: Role, event: Event) {
		event.stopPropagation();
		if (!canDeleteRole(role)) {
			return;
		}
		roleToDelete = role;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		roleToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!roleToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			// Note: Delete API not implemented yet in backend
			// await adminRolesAPI.delete(roleToDelete.id);
			deleteError = 'Role deletion is not yet implemented';
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Failed to delete role';
		} finally {
			deleting = false;
		}
	}

	function getRoleTypeBadgeClass(type: RoleType): string {
		switch (type) {
			case 'system':
				return 'badge badge-info';
			case 'builtin':
				return 'badge badge-neutral';
			case 'custom':
				return 'badge badge-success';
			default:
				return 'badge badge-neutral';
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>Role-Based Access Control - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Role-Based Access Control</h1>
			<p class="page-description">
				Define roles and permissions to control user access based on their organizational role.
			</p>
		</div>
		{#if activeTab === 'roles'}
			<div class="page-actions">
				<button class="btn btn-primary" onclick={navigateToCreate}>
					<i class="i-ph-plus"></i>
					Create Role
				</button>
			</div>
		{/if}
	</div>

	<!-- Tab Navigation -->
	<div class="tab-nav">
		<button
			class="tab-btn"
			class:active={activeTab === 'roles'}
			onclick={() => switchTab('roles')}
		>
			<i class="i-ph-shield-check"></i>
			Roles
		</button>
		<button
			class="tab-btn"
			class:active={activeTab === 'rules'}
			onclick={() => switchTab('rules')}
		>
			<i class="i-ph-git-branch"></i>
			Assignment Rules
		</button>
	</div>

	<!-- Tab Content -->
	{#if activeTab === 'roles'}
		<!-- Roles Tab -->
		{#if error}
			<div class="alert alert-error" style="margin-bottom: 16px;">
				{error}
				<button class="btn btn-secondary btn-sm" onclick={loadRoles}>Retry</button>
			</div>
		{/if}

		<!-- Filter Bar -->
		<div class="filter-bar">
			<span class="filter-label">Filter:</span>
			<button
				class="filter-btn"
				class:active={filterType === 'all'}
				onclick={() => (filterType = 'all')}
			>
				All
			</button>
			<button
				class="filter-btn"
				class:active={filterType === 'system'}
				onclick={() => (filterType = 'system')}
			>
				System
			</button>
			<button
				class="filter-btn"
				class:active={filterType === 'builtin'}
				onclick={() => (filterType = 'builtin')}
			>
				Built-in
			</button>
			<button
				class="filter-btn"
				class:active={filterType === 'custom'}
				onclick={() => (filterType = 'custom')}
			>
				Custom
			</button>
		</div>

		{#if loading}
			<div class="loading-state">
				<i class="i-ph-circle-notch loading-spinner"></i>
				<p>Loading roles...</p>
			</div>
		{:else if filteredRoles.length === 0}
			<div class="panel">
				<div class="empty-state">
					{#if filterType === 'all'}
						<p class="empty-state-description">No roles found.</p>
					{:else}
						<p class="empty-state-description">No {filterType} roles found.</p>
					{/if}
				</div>
			</div>
		{:else}
			<div class="data-table-container">
				<table class="data-table">
					<thead>
						<tr>
							<th>Name</th>
							<th>Type</th>
							<th>Description</th>
							<th>Created</th>
							<th class="text-right">Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each filteredRoles as role (role.id)}
							{@const roleType = getRoleType(role)}
							<tr
								onclick={() => navigateToRole(role)}
								onkeydown={(e) => e.key === 'Enter' && navigateToRole(role)}
								tabindex="0"
								role="button"
							>
								<td>
									<div class="cell-primary">{role.display_name || role.name}</div>
									{#if role.display_name && role.display_name !== role.name}
										<div class="cell-secondary">({role.name})</div>
									{/if}
								</td>
								<td>
									<span class={getRoleTypeBadgeClass(roleType)}>{roleType}</span>
								</td>
								<td class="muted truncate" style="max-width: 300px;">
									{role.description || '-'}
								</td>
								<td class="muted nowrap">{formatDate(role.created_at)}</td>
								<td class="text-right" onclick={(e) => e.stopPropagation()}>
									<div class="action-buttons">
										<button
											class="btn btn-secondary btn-sm"
											onclick={(e) => {
												e.stopPropagation();
												navigateToRole(role);
											}}
										>
											View
										</button>
										{#if canDeleteRole(role)}
											<button
												class="btn btn-danger btn-sm"
												onclick={(e) => openDeleteDialog(role, e)}
											>
												Delete
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{:else if activeTab === 'rules'}
		<!-- Assignment Rules Tab -->
		<RoleAssignmentRules />
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && roleToDelete}
	<div
		class="modal-overlay"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
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
				<h2 class="modal-title">Delete Role</h2>
			</div>

			<div class="modal-body">
				<p class="modal-description">
					Are you sure you want to delete the role <strong>{roleToDelete.name}</strong>?
				</p>
				<p class="danger-text">This action cannot be undone.</p>

				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Tab Navigation */
	.tab-nav {
		display: flex;
		gap: 4px;
		margin-bottom: 24px;
		border-bottom: 1px solid var(--border-primary);
		padding-bottom: 0;
	}

	.tab-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 20px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		color: var(--text-secondary);
		font-size: 0.9375rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.tab-btn:hover {
		color: var(--text-primary);
	}

	.tab-btn.active {
		color: var(--primary);
		border-bottom-color: var(--primary);
	}

	.tab-btn :global(i) {
		width: 18px;
		height: 18px;
	}
</style>

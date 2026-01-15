<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminRolesAPI,
		type Role,
		getRoleType,
		canDeleteRole,
		type RoleType
	} from '$lib/api/admin-roles';

	let roles: Role[] = $state([]);
	let loading = $state(true);
	let error = $state('');

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

	function getRoleTypeBadgeStyle(type: RoleType): string {
		switch (type) {
			case 'system':
				return 'background-color: #dbeafe; color: #1e40af;';
			case 'builtin':
				return 'background-color: #e0e7ff; color: #3730a3;';
			case 'custom':
				return 'background-color: #d1fae5; color: #065f46;';
			default:
				return 'background-color: #f3f4f6; color: #374151;';
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

<div class="roles-page">
	<div class="page-header">
		<div class="header-content">
			<h1>Roles</h1>
			<p class="description">Manage system roles, built-in roles, and custom roles.</p>
		</div>
		<button class="btn-primary" onclick={navigateToCreate}>+ Create Role</button>
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={loadRoles}>Retry</button>
		</div>
	{/if}

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
		<div class="loading">Loading roles...</div>
	{:else if filteredRoles.length === 0}
		<div class="empty-state">
			{#if filterType === 'all'}
				<p>No roles found.</p>
			{:else}
				<p>No {filterType} roles found.</p>
			{/if}
		</div>
	{:else}
		<div class="roles-table-container">
			<table class="roles-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Type</th>
						<th>Description</th>
						<th>Created</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredRoles as role (role.id)}
						{@const roleType = getRoleType(role)}
						<tr class="role-row" onclick={() => navigateToRole(role)}>
							<td class="role-name">
								<span class="name">{role.display_name || role.name}</span>
								{#if role.display_name && role.display_name !== role.name}
									<span class="id-hint">({role.name})</span>
								{/if}
							</td>
							<td>
								<span class="type-badge" style={getRoleTypeBadgeStyle(roleType)}>
									{roleType}
								</span>
							</td>
							<td class="description-cell">
								{role.description || '-'}
							</td>
							<td class="date-cell">
								{formatDate(role.created_at)}
							</td>
							<td class="actions-cell">
								<button
									class="action-btn view-btn"
									onclick={(e) => {
										e.stopPropagation();
										navigateToRole(role);
									}}
									title="View details"
								>
									View
								</button>
								{#if canDeleteRole(role)}
									<button
										class="action-btn delete-btn"
										onclick={(e) => openDeleteDialog(role, e)}
										title="Delete role"
									>
										Delete
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && roleToDelete}
	<div class="dialog-overlay" onclick={closeDeleteDialog} role="presentation">
		<div
			class="dialog"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="delete-dialog-title"
		>
			<h2 id="delete-dialog-title">Delete Role</h2>
			<p>
				Are you sure you want to delete the role <strong>{roleToDelete.name}</strong>?
			</p>
			<p class="warning-text">This action cannot be undone.</p>

			{#if deleteError}
				<div class="dialog-error">{deleteError}</div>
			{/if}

			<div class="dialog-actions">
				<button class="btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.roles-page {
		padding: 24px;
		max-width: 1200px;
		margin: 0 auto;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 24px;
	}

	.header-content h1 {
		margin: 0 0 8px 0;
		font-size: 24px;
		font-weight: 600;
	}

	.description {
		margin: 0;
		color: #6b7280;
		font-size: 14px;
	}

	.btn-primary {
		padding: 10px 20px;
		background-color: #2563eb;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.btn-primary:hover {
		background-color: #1d4ed8;
	}

	.error-banner {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 16px;
		border-radius: 6px;
		margin-bottom: 16px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.error-banner button {
		padding: 6px 12px;
		background-color: #b91c1c;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.filter-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 16px;
	}

	.filter-label {
		font-size: 14px;
		color: #6b7280;
	}

	.filter-btn {
		padding: 6px 12px;
		background-color: #f3f4f6;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 13px;
		color: #374151;
		cursor: pointer;
		transition: all 0.2s;
	}

	.filter-btn:hover {
		background-color: #e5e7eb;
	}

	.filter-btn.active {
		background-color: #2563eb;
		border-color: #2563eb;
		color: white;
	}

	.loading {
		text-align: center;
		padding: 40px;
		color: #6b7280;
	}

	.empty-state {
		text-align: center;
		padding: 40px;
		color: #6b7280;
		background-color: #f9fafb;
		border-radius: 8px;
	}

	.roles-table-container {
		overflow-x: auto;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
	}

	.roles-table {
		width: 100%;
		border-collapse: collapse;
	}

	.roles-table th {
		text-align: left;
		padding: 12px 16px;
		background-color: #f9fafb;
		font-size: 13px;
		font-weight: 600;
		color: #374151;
		border-bottom: 1px solid #e5e7eb;
	}

	.roles-table td {
		padding: 12px 16px;
		border-bottom: 1px solid #e5e7eb;
		font-size: 14px;
	}

	.role-row {
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.role-row:hover {
		background-color: #f9fafb;
	}

	.role-row:last-child td {
		border-bottom: none;
	}

	.role-name {
		font-weight: 500;
	}

	.role-name .name {
		color: #111827;
	}

	.role-name .id-hint {
		color: #9ca3af;
		font-size: 12px;
		margin-left: 4px;
	}

	.type-badge {
		display: inline-block;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 500;
		text-transform: capitalize;
	}

	.description-cell {
		color: #6b7280;
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.date-cell {
		color: #6b7280;
		white-space: nowrap;
	}

	.actions-cell {
		white-space: nowrap;
	}

	.action-btn {
		padding: 4px 8px;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 12px;
		cursor: pointer;
		margin-right: 4px;
		transition: all 0.2s;
	}

	.view-btn {
		background-color: white;
		color: #374151;
	}

	.view-btn:hover {
		background-color: #f3f4f6;
	}

	.delete-btn {
		background-color: white;
		color: #dc2626;
		border-color: #fecaca;
	}

	.delete-btn:hover {
		background-color: #fef2f2;
	}

	/* Dialog styles */
	.dialog-overlay {
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
	}

	.dialog {
		background-color: white;
		border-radius: 8px;
		padding: 24px;
		max-width: 400px;
		width: 90%;
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
	}

	.dialog h2 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.dialog p {
		margin: 0 0 12px 0;
		color: #374151;
	}

	.warning-text {
		color: #b91c1c;
		font-size: 14px;
	}

	.dialog-error {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 8px 12px;
		border-radius: 4px;
		margin-bottom: 16px;
		font-size: 14px;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 24px;
	}

	.btn-secondary {
		padding: 8px 16px;
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-secondary:hover {
		background-color: #f3f4f6;
	}

	.btn-danger {
		padding: 8px 16px;
		background-color: #dc2626;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-danger:hover {
		background-color: #b91c1c;
	}

	.btn-danger:disabled,
	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

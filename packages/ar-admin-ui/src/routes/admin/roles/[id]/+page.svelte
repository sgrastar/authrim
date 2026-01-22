<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		adminRolesAPI,
		type RoleDetail,
		type RoleAssignedUser,
		getRoleType,
		canEditRole,
		canDeleteRole,
		PERMISSION_DEFINITIONS,
		type RoleType
	} from '$lib/api/admin-roles';

	let role: RoleDetail | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Assigned users state
	let assignedUsers = $state<RoleAssignedUser[]>([]);
	let assignedUsersLoading = $state(false);
	let assignedUsersError = $state('');
	let assignedUsersPagination = $state({
		page: 1,
		limit: 10,
		total: 0,
		totalPages: 0,
		hasNext: false,
		hasPrev: false
	});

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let deleting = $state(false);
	let deleteError = $state('');

	// Computed values
	let roleType = $derived(role ? getRoleType(role) : null);
	let canEdit = $derived(role ? canEditRole(role) : false);
	let canDelete = $derived(role ? canDeleteRole(role) : false);

	// Group permissions by category for display
	let permissionsByCategory = $derived.by(() => {
		if (!role) return [];

		const effectivePerms = new Set(role.effectivePermissions || []);
		const addedPerms = new Set(role.addedPermissions || []);

		return PERMISSION_DEFINITIONS.map((category) => {
			const categoryPermissions = category.permissions.map((perm) => ({
				...perm,
				hasPermission: effectivePerms.has(perm.id),
				isInherited: effectivePerms.has(perm.id) && !addedPerms.has(perm.id)
			}));

			const hasAnyPermission = categoryPermissions.some((p) => p.hasPermission);

			return {
				...category,
				permissions: categoryPermissions,
				hasAnyPermission
			};
		}).filter((cat) => cat.hasAnyPermission);
	});

	async function loadRole() {
		const roleId = $page.params.id;
		if (!roleId) {
			error = 'Role ID is required';
			loading = false;
			return;
		}

		loading = true;
		error = '';

		try {
			const response = await adminRolesAPI.get(roleId);
			role = response.role;
		} catch (err) {
			console.error('Failed to load role:', err);
			error = err instanceof Error ? err.message : 'Failed to load role';
		} finally {
			loading = false;
		}
	}

	async function loadAssignedUsers(pageNum: number = 1) {
		const roleId = $page.params.id;
		if (!roleId) return;

		assignedUsersLoading = true;
		assignedUsersError = '';

		try {
			const response = await adminRolesAPI.getRoleAssignments(
				roleId,
				pageNum,
				assignedUsersPagination.limit
			);
			assignedUsers = response.assignments;
			assignedUsersPagination = response.pagination;
		} catch (err) {
			console.error('Failed to load assigned users:', err);
			assignedUsersError = err instanceof Error ? err.message : 'Failed to load assigned users';
		} finally {
			assignedUsersLoading = false;
		}
	}

	onMount(() => {
		loadRole();
		loadAssignedUsers();
	});

	function _navigateBack() {
		goto('/admin/roles');
	}

	function navigateToUser(userId: string) {
		goto(`/admin/users/${userId}`);
	}

	function navigateToEdit() {
		if (role) {
			goto(`/admin/roles/${role.id}/edit`);
		}
	}

	function openDeleteDialog() {
		if (!canDelete) return;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!role) return;

		deleting = true;
		deleteError = '';

		try {
			// Note: Delete API not implemented yet
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
				return 'badge badge-system';
			case 'builtin':
				return 'badge badge-primary';
			case 'custom':
				return 'badge badge-success';
			default:
				return 'badge badge-neutral';
		}
	}

	function getScopeBadgeClass(scope: string): string {
		switch (scope) {
			case 'global':
				return 'badge badge-global';
			case 'org':
				return 'badge badge-org';
			case 'resource':
				return 'badge badge-resource';
			default:
				return 'badge badge-neutral';
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<svelte:head>
	<title
		>{role ? `${role.display_name || role.name} - Roles` : 'Role Details'} - Admin Dashboard - Authrim</title
	>
</svelte:head>

<div class="admin-page">
	<a href="/admin/roles" class="back-link">← Back to Roles</a>

	{#if loading}
		<div class="loading-state">Loading role details...</div>
	{:else if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadRole}>Retry</button>
		</div>
	{:else if role}
		<!-- Role Header -->
		<div class="page-header-with-status">
			<div class="page-header-info">
				<h1 class="page-title">
					{role.display_name || role.name}
					{#if role.display_name && role.display_name !== role.name}
						<span class="page-subtitle">({role.name})</span>
					{/if}
				</h1>
				{#if roleType}
					<span class={getRoleTypeBadgeClass(roleType)}>{roleType}</span>
				{/if}
			</div>
			<div class="action-buttons">
				{#if canEdit}
					<button class="btn btn-secondary" onclick={navigateToEdit}>Edit</button>
				{/if}
				{#if canDelete}
					<button class="btn btn-danger" onclick={openDeleteDialog}>Delete</button>
				{/if}
			</div>
		</div>

		{#if role.description}
			<p class="modal-description">{role.description}</p>
		{/if}

		<!-- Inheritance Notice -->
		{#if role.inherits_from}
			<div class="info-box">
				<span>ℹ️</span>
				<div>
					<strong>This role inherits from: {role.inherits_from}</strong>
					<p>
						When the base role is updated, changes will be automatically reflected in this role.
					</p>
				</div>
			</div>
		{/if}

		<!-- Role Info Panel -->
		<div class="panel">
			<h2 class="panel-title">Role Information</h2>
			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">ID</dt>
					<dd class="info-value mono">{role.id}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Type</dt>
					<dd class="info-value">{roleType}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Assigned Users</dt>
					<dd class="info-value">{role.assignment_count}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Created</dt>
					<dd class="info-value">{formatDate(role.created_at)}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Updated</dt>
					<dd class="info-value">{formatDate(role.updated_at)}</dd>
				</div>
			</div>
		</div>

		<!-- Permissions Panel -->
		<div class="panel">
			<h2 class="panel-title">Permissions ({role.effectivePermissions?.length || 0})</h2>

			{#if permissionsByCategory.length === 0}
				<p class="empty-text">This role has no permissions assigned.</p>
			{:else}
				<div class="permission-grid">
					{#each permissionsByCategory as category (category.category)}
						<div class="permission-category-card">
							<h3 class="permission-category-title">{category.categoryLabel}</h3>
							<div class="permission-list">
								{#each category.permissions as perm (perm.id)}
									{#if perm.hasPermission}
										<div class="permission-item" class:inherited={perm.isInherited}>
											<span class="permission-name">{perm.label}</span>
											{#if perm.isInherited}
												<span class="badge badge-neutral">Inherited</span>
											{/if}
											<span class="permission-id">{perm.id}</span>
										</div>
									{/if}
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Assigned Users Panel -->
		<div class="panel">
			<h2 class="panel-title">Assigned Users ({role.assignment_count})</h2>
			<p class="form-hint">
				Users with this role. To assign or remove this role, go to the user's detail page.
			</p>

			{#if assignedUsersLoading}
				<div class="loading-state">Loading users...</div>
			{:else if assignedUsersError}
				<div class="alert alert-error">
					<span>{assignedUsersError}</span>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => loadAssignedUsers(assignedUsersPagination.page)}>Retry</button
					>
				</div>
			{:else if assignedUsers.length === 0}
				<div class="empty-state">No users are assigned to this role.</div>
			{:else}
				<div class="table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>User</th>
								<th>Scope</th>
								<th>Assigned</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each assignedUsers as user (user.assignment_id)}
								<tr>
									<td>
										<div class="user-cell">
											<span class="user-cell-name">{user.user_name || 'Unknown'}</span>
											<span class="user-cell-email">{user.user_email || user.user_id}</span>
										</div>
									</td>
									<td>
										<span class={getScopeBadgeClass(user.scope)}>{user.scope}</span>
										{#if user.scope_target}
											<span class="scope-target">{user.scope_target}</span>
										{/if}
									</td>
									<td class="nowrap text-secondary">{formatDate(user.assigned_at)}</td>
									<td>
										<button class="btn-link" onclick={() => navigateToUser(user.user_id)}>
											View User →
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<!-- Pagination -->
				{#if assignedUsersPagination.totalPages > 1}
					<div class="pagination">
						<button
							class="btn btn-secondary btn-sm"
							disabled={!assignedUsersPagination.hasPrev}
							onclick={() => loadAssignedUsers(assignedUsersPagination.page - 1)}
						>
							← Previous
						</button>
						<span class="pagination-info">
							Page {assignedUsersPagination.page} of {assignedUsersPagination.totalPages}
						</span>
						<button
							class="btn btn-secondary btn-sm"
							disabled={!assignedUsersPagination.hasNext}
							onclick={() => loadAssignedUsers(assignedUsersPagination.page + 1)}
						>
							Next →
						</button>
					</div>
				{/if}
			{/if}
		</div>

		<!-- Delete restriction notice -->
		{#if roleType === 'custom' && role.assignment_count > 0}
			<div class="warning-box">
				<p>
					⚠️ This role is assigned to {role.assignment_count} user(s). Remove all assignments before
					deleting.
				</p>
			</div>
		{/if}
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && role}
	<div class="modal-overlay" onclick={closeDeleteDialog} role="presentation">
		<div
			class="modal-content modal-sm"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="delete-dialog-title"
		>
			<div class="modal-header">
				<h2 id="delete-dialog-title" class="modal-title">Delete Role</h2>
			</div>
			<div class="modal-body">
				<p>
					Are you sure you want to delete the role <strong>{role.name}</strong>?
				</p>
				<p class="text-danger">This action cannot be undone.</p>

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

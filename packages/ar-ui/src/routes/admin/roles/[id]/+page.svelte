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

	function navigateBack() {
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
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<div class="role-detail-page">
	<div class="page-header">
		<button class="back-btn" onclick={navigateBack}>← Back to Roles</button>
	</div>

	{#if loading}
		<div class="loading">Loading role details...</div>
	{:else if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={loadRole}>Retry</button>
		</div>
	{:else if role}
		<div class="role-header">
			<div class="role-title">
				<h1>{role.display_name || role.name}</h1>
				{#if role.display_name && role.display_name !== role.name}
					<span class="role-id">({role.name})</span>
				{/if}
				{#if roleType}
					<span class="type-badge" style={getRoleTypeBadgeStyle(roleType)}>
						{roleType}
					</span>
				{/if}
			</div>
			<div class="role-actions">
				{#if canEdit}
					<button class="btn-secondary" onclick={navigateToEdit}>Edit</button>
				{/if}
				{#if canDelete}
					<button class="btn-danger" onclick={openDeleteDialog}>Delete</button>
				{/if}
			</div>
		</div>

		{#if role.description}
			<p class="role-description">{role.description}</p>
		{/if}

		<!-- Inheritance Warning -->
		{#if role.inherits_from}
			<div class="inheritance-notice">
				<span class="notice-icon">ℹ️</span>
				<div class="notice-content">
					<strong>This role inherits from: {role.inherits_from}</strong>
					<p>
						When the base role is updated, changes will be automatically reflected in this role.
					</p>
				</div>
			</div>
		{/if}

		<!-- Role Info -->
		<div class="info-section">
			<h2>Role Information</h2>
			<div class="info-grid">
				<div class="info-item">
					<span class="info-label">ID</span>
					<span class="info-value mono">{role.id}</span>
				</div>
				<div class="info-item">
					<span class="info-label">Type</span>
					<span class="info-value">{roleType}</span>
				</div>
				<div class="info-item">
					<span class="info-label">Assigned Users</span>
					<span class="info-value">{role.assignment_count}</span>
				</div>
				<div class="info-item">
					<span class="info-label">Created</span>
					<span class="info-value">{formatDate(role.created_at)}</span>
				</div>
				<div class="info-item">
					<span class="info-label">Updated</span>
					<span class="info-value">{formatDate(role.updated_at)}</span>
				</div>
			</div>
		</div>

		<!-- Permissions Section -->
		<div class="permissions-section">
			<h2>Permissions ({role.effectivePermissions?.length || 0})</h2>

			{#if permissionsByCategory.length === 0}
				<p class="no-permissions">This role has no permissions assigned.</p>
			{:else}
				<div class="permissions-grid">
					{#each permissionsByCategory as category (category.category)}
						<div class="permission-category">
							<h3>{category.categoryLabel}</h3>
							<div class="permission-list">
								{#each category.permissions as perm (perm.id)}
									{#if perm.hasPermission}
										<div class="permission-item" class:inherited={perm.isInherited}>
											<span class="permission-name">{perm.label}</span>
											{#if perm.isInherited}
												<span class="inherited-badge">Inherited</span>
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

		<!-- Assigned Users Section -->
		<div class="assigned-users-section">
			<h2>Assigned Users ({role.assignment_count})</h2>
			<p class="section-description">
				Users with this role. To assign or remove this role, go to the user's detail page.
			</p>

			{#if assignedUsersLoading}
				<div class="loading-inline">Loading users...</div>
			{:else if assignedUsersError}
				<div class="error-inline">
					<span>{assignedUsersError}</span>
					<button onclick={() => loadAssignedUsers(assignedUsersPagination.page)}>Retry</button>
				</div>
			{:else if assignedUsers.length === 0}
				<p class="no-users">No users are assigned to this role.</p>
			{:else}
				<div class="users-table-container">
					<table class="users-table">
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
									<td class="user-info-cell">
										<div class="user-info">
											<span class="user-name">{user.user_name || 'Unknown'}</span>
											<span class="user-email">{user.user_email || user.user_id}</span>
										</div>
									</td>
									<td>
										<span class="scope-badge">{user.scope}</span>
										{#if user.scope_target}
											<span class="scope-target">{user.scope_target}</span>
										{/if}
									</td>
									<td class="date-cell">{formatDate(user.assigned_at)}</td>
									<td>
										<button class="action-link" onclick={() => navigateToUser(user.user_id)}>
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
							class="pagination-btn"
							disabled={!assignedUsersPagination.hasPrev}
							onclick={() => loadAssignedUsers(assignedUsersPagination.page - 1)}
						>
							← Previous
						</button>
						<span class="pagination-info">
							Page {assignedUsersPagination.page} of {assignedUsersPagination.totalPages}
						</span>
						<button
							class="pagination-btn"
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
			<div class="delete-notice">
				<span class="notice-icon">⚠️</span>
				<span>
					This role is assigned to {role.assignment_count} user(s). Remove all assignments before deleting.
				</span>
			</div>
		{/if}
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && role}
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
				Are you sure you want to delete the role <strong>{role.name}</strong>?
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
	.role-detail-page {
		padding: 24px;
		max-width: 1000px;
		margin: 0 auto;
	}

	.page-header {
		margin-bottom: 24px;
	}

	.back-btn {
		padding: 8px 16px;
		background-color: transparent;
		border: none;
		color: #2563eb;
		font-size: 14px;
		cursor: pointer;
	}

	.back-btn:hover {
		text-decoration: underline;
	}

	.role-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 16px;
	}

	.role-title {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.role-title h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 600;
	}

	.role-id {
		color: #9ca3af;
		font-size: 16px;
	}

	.type-badge {
		display: inline-block;
		padding: 4px 10px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 500;
		text-transform: capitalize;
	}

	.role-actions {
		display: flex;
		gap: 8px;
	}

	.role-description {
		color: #6b7280;
		margin: 0 0 24px 0;
		font-size: 14px;
	}

	.inheritance-notice {
		background-color: #eff6ff;
		border: 1px solid #bfdbfe;
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 24px;
		display: flex;
		gap: 12px;
	}

	.notice-icon {
		font-size: 20px;
	}

	.notice-content strong {
		color: #1e40af;
		display: block;
		margin-bottom: 4px;
	}

	.notice-content p {
		margin: 0;
		color: #1e40af;
		font-size: 14px;
	}

	.info-section {
		background-color: #f9fafb;
		border-radius: 8px;
		padding: 20px;
		margin-bottom: 24px;
	}

	.info-section h2 {
		margin: 0 0 16px 0;
		font-size: 16px;
		font-weight: 600;
	}

	.info-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 16px;
	}

	.info-item {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.info-label {
		font-size: 12px;
		color: #6b7280;
		text-transform: uppercase;
	}

	.info-value {
		font-size: 14px;
		color: #111827;
	}

	.info-value.mono {
		font-family: monospace;
		font-size: 13px;
	}

	.permissions-section {
		margin-bottom: 24px;
	}

	.permissions-section h2 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.no-permissions {
		color: #6b7280;
		font-style: italic;
	}

	.permissions-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 20px;
	}

	.permission-category {
		background-color: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 16px;
	}

	.permission-category h3 {
		margin: 0 0 12px 0;
		font-size: 14px;
		font-weight: 600;
		color: #374151;
	}

	.permission-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.permission-item {
		padding: 8px 12px;
		background-color: #f9fafb;
		border-radius: 4px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.permission-item.inherited {
		background-color: #f3f4f6;
		opacity: 0.8;
	}

	.permission-name {
		font-size: 13px;
		font-weight: 500;
		color: #111827;
	}

	.inherited-badge {
		font-size: 10px;
		padding: 2px 6px;
		background-color: #e5e7eb;
		color: #6b7280;
		border-radius: 3px;
	}

	.permission-id {
		font-size: 11px;
		color: #9ca3af;
		font-family: monospace;
		margin-left: auto;
	}

	.delete-notice {
		background-color: #fef3c7;
		border: 1px solid #fcd34d;
		border-radius: 8px;
		padding: 12px 16px;
		display: flex;
		align-items: center;
		gap: 8px;
		color: #92400e;
		font-size: 14px;
	}

	.loading {
		text-align: center;
		padding: 40px;
		color: #6b7280;
	}

	.error-banner {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 16px;
		border-radius: 6px;
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

	/* Assigned Users Section */
	.assigned-users-section {
		margin-bottom: 24px;
	}

	.assigned-users-section h2 {
		margin: 0 0 8px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.section-description {
		color: #6b7280;
		margin: 0 0 16px 0;
		font-size: 14px;
	}

	.loading-inline {
		padding: 20px;
		text-align: center;
		color: #6b7280;
	}

	.error-inline {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 16px;
		border-radius: 6px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.error-inline button {
		padding: 4px 8px;
		background-color: #b91c1c;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}

	.no-users {
		color: #6b7280;
		font-style: italic;
		padding: 20px;
		text-align: center;
		background-color: #f9fafb;
		border-radius: 8px;
	}

	.users-table-container {
		overflow-x: auto;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
	}

	.users-table {
		width: 100%;
		border-collapse: collapse;
	}

	.users-table th {
		text-align: left;
		padding: 12px 16px;
		background-color: #f9fafb;
		font-size: 13px;
		font-weight: 600;
		color: #374151;
		border-bottom: 1px solid #e5e7eb;
	}

	.users-table td {
		padding: 12px 16px;
		border-bottom: 1px solid #e5e7eb;
		font-size: 14px;
	}

	.users-table tr:last-child td {
		border-bottom: none;
	}

	.user-info-cell {
		max-width: 250px;
	}

	.user-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.user-name {
		font-weight: 500;
		color: #111827;
	}

	.user-email {
		font-size: 12px;
		color: #6b7280;
	}

	.scope-badge {
		display: inline-block;
		padding: 2px 8px;
		background-color: #e0e7ff;
		color: #3730a3;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 500;
		text-transform: capitalize;
	}

	.scope-target {
		font-size: 12px;
		color: #6b7280;
		margin-left: 4px;
	}

	.date-cell {
		color: #6b7280;
		white-space: nowrap;
		font-size: 13px;
	}

	.action-link {
		background: none;
		border: none;
		color: #2563eb;
		cursor: pointer;
		font-size: 13px;
		padding: 0;
	}

	.action-link:hover {
		text-decoration: underline;
	}

	.pagination {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 16px;
		margin-top: 16px;
		padding: 12px;
	}

	.pagination-btn {
		padding: 8px 16px;
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		font-size: 13px;
		cursor: pointer;
		color: #374151;
	}

	.pagination-btn:hover:not(:disabled) {
		background-color: #f3f4f6;
	}

	.pagination-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pagination-info {
		font-size: 13px;
		color: #6b7280;
	}
</style>

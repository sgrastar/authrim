<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';
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
	import { Modal } from '$lib/components';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		formatPermissionCategory,
		formatPermissionLabel,
		formatRoleType,
		formatScope
	} from '$lib/admin/roles-i18n';

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
	let loadedTenantId = $state('');

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
			error = $LL.admin_roles_role_id_required();
			loading = false;
			return;
		}

		loading = true;
		error = '';

		try {
			const response = await adminRolesAPI.get(roleId);
			role = response.role;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_roles_detail_load_failed();
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
			assignedUsersError =
				err instanceof Error ? err.message : $LL.admin_roles_assigned_users_load_failed();
		} finally {
			assignedUsersLoading = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		role = null;
		error = '';
		deleteError = '';
		assignedUsers = [];
		assignedUsersError = '';
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
			deleteError = $LL.admin_roles_delete_unavailable();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_roles_delete_failed();
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
		>{role
			? $LL.admin_roles_detail_head_title({ role: role.display_name || role.name })
			: $LL.admin_roles_detail_fallback_head_title()}</title
	>
</svelte:head>

<div class="admin-page">
	<a href="/admin/roles" class="back-link">← {$LL.admin_roles_back_to_roles()}</a>

	{#if loading}
		<div class="loading-state">{$LL.admin_roles_detail_loading()}</div>
	{:else if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadRole}>{$LL.admin_roles_retry()}</button>
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
					<span class={getRoleTypeBadgeClass(roleType)}>{formatRoleType(roleType, $LL)}</span>
				{/if}
			</div>
			<div class="action-buttons">
				{#if canEdit}
					<button class="btn btn-secondary" onclick={navigateToEdit}
						>{$LL.admin_roles_edit()}</button
					>
				{/if}
				{#if canDelete}
					<button class="btn btn-danger" onclick={openDeleteDialog}
						>{$LL.admin_roles_delete()}</button
					>
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
					<strong>{$LL.admin_roles_inherits_from({ role: role.inherits_from })}</strong>
					<p>{$LL.admin_roles_inherits_note()}</p>
				</div>
			</div>
		{/if}

		<!-- Role Info Panel -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_roles_role_information()}</h2>
			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">{$LL.admin_roles_id()}</dt>
					<dd class="info-value mono">{role.id}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">{$LL.admin_roles_type()}</dt>
					<dd class="info-value">{formatRoleType(roleType, $LL)}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">{$LL.admin_roles_assigned_users()}</dt>
					<dd class="info-value">{role.assignment_count}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">{$LL.admin_roles_created()}</dt>
					<dd class="info-value">{formatDate(role.created_at)}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">{$LL.admin_roles_updated()}</dt>
					<dd class="info-value">{formatDate(role.updated_at)}</dd>
				</div>
			</div>
		</div>

		<!-- Permissions Panel -->
		<div class="panel">
			<h2 class="panel-title">
				{$LL.admin_roles_permissions_with_count({ count: role.effectivePermissions?.length || 0 })}
			</h2>

			{#if permissionsByCategory.length === 0}
				<p class="empty-text">{$LL.admin_roles_no_permissions()}</p>
			{:else}
				<div class="permission-grid">
					{#each permissionsByCategory as category (category.category)}
						<div class="permission-category-card">
							<h3 class="permission-category-title">
								{formatPermissionCategory(category.category, $LL)}
							</h3>
							<div class="permission-list">
								{#each category.permissions as perm (perm.id)}
									{#if perm.hasPermission}
										<div class="permission-item" class:inherited={perm.isInherited}>
											<span class="permission-name">{formatPermissionLabel(perm.id, $LL)}</span>
											{#if perm.isInherited}
												<span class="badge badge-neutral">{$LL.admin_roles_inherited()}</span>
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
			<h2 class="panel-title">
				{$LL.admin_roles_assigned_users()} ({role.assignment_count})
			</h2>
			<p class="form-hint">{$LL.admin_roles_assigned_users_hint()}</p>

			{#if assignedUsersLoading}
				<div class="loading-state">{$LL.admin_roles_loading_users()}</div>
			{:else if assignedUsersError}
				<div class="alert alert-error">
					<span>{assignedUsersError}</span>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => loadAssignedUsers(assignedUsersPagination.page)}
						>{$LL.admin_roles_retry()}</button
					>
				</div>
			{:else if assignedUsers.length === 0}
				<div class="empty-state">{$LL.admin_roles_no_assigned_users()}</div>
			{:else}
				<div class="table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>{$LL.admin_roles_user()}</th>
								<th>{$LL.admin_roles_scope()}</th>
								<th>{$LL.admin_roles_assigned()}</th>
								<th>{$LL.admin_roles_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each assignedUsers as user (user.assignment_id)}
								<tr>
									<td>
										<div class="user-cell">
											<span class="user-cell-name"
												>{user.user_name || $LL.admin_roles_unknown()}</span
											>
											<span class="user-cell-email">{user.user_email || user.user_id}</span>
										</div>
									</td>
									<td>
										<span class={getScopeBadgeClass(user.scope)}
											>{formatScope(user.scope, $LL)}</span
										>
										{#if user.scope_target}
											<span class="scope-target">{user.scope_target}</span>
										{/if}
									</td>
									<td class="nowrap text-secondary">{formatDate(user.assigned_at)}</td>
									<td>
										<button class="btn-link" onclick={() => navigateToUser(user.user_id)}>
											{$LL.admin_roles_view_user()} →
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
							← {$LL.admin_roles_previous()}
						</button>
						<span class="pagination-info">
							{$LL.admin_roles_page_of({
								page: assignedUsersPagination.page,
								totalPages: assignedUsersPagination.totalPages
							})}
						</span>
						<button
							class="btn btn-secondary btn-sm"
							disabled={!assignedUsersPagination.hasNext}
							onclick={() => loadAssignedUsers(assignedUsersPagination.page + 1)}
						>
							{$LL.admin_roles_next()} →
						</button>
					</div>
				{/if}
			{/if}
		</div>

		<!-- Delete restriction notice -->
		{#if roleType === 'custom' && role.assignment_count > 0}
			<div class="warning-box">
				<p>
					⚠️ {$LL.admin_roles_delete_assigned_warning({ count: role.assignment_count })}
				</p>
			</div>
		{/if}
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
<Modal
	open={showDeleteDialog && !!role}
	onClose={closeDeleteDialog}
	title={$LL.admin_roles_delete_title()}
	size="sm"
>
	<p>
		{$LL.admin_roles_delete_description({ role: role?.name ?? '' })}
	</p>
	<p class="text-danger">{$LL.admin_roles_delete_danger()}</p>

	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
			{$LL.admin_roles_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_roles_deleting() : $LL.admin_roles_delete()}
		</button>
	{/snippet}
</Modal>

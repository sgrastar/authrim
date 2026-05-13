<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminAdminRolesAPI,
		type AdminRoleDetail,
		type AssignableAdminRoleScopeType,
		type AdminRoleAssignmentWithUser,
		ADMIN_PERMISSION_DEFINITIONS,
		canEditAdminRole,
		canDeleteAdminRole,
		getRoleTypeBadgeClass
	} from '$lib/api/admin-admin-roles';
	import { adminAdminsAPI, type AdminUser } from '$lib/api/admin-admins';
	import { Modal } from '$lib/components';

	const roleId = $derived($page.params.id);

	let role: AdminRoleDetail | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let assignments: AdminRoleAssignmentWithUser[] = $state([]);
	let adminUsers: AdminUser[] = $state([]);
	let assignmentError = $state('');

	// Edit dialog state
	let showEditDialog = $state(false);
	let editDisplayName = $state('');
	let editDescription = $state('');
	const editPermissions = new SvelteSet<string>();
	let saving = $state(false);

	// Assignment dialog state
	let showAssignDialog = $state(false);
	let assigning = $state(false);
	let assignError = $state('');
	let selectedAdminUserId = $state('');
	let assignScopeType: AssignableAdminRoleScopeType = $state('tenant');
	let assignScopeId = $state('');
	let assignExpiresAt = $state('');

	// Assignment edit dialog state
	let showAssignmentEditDialog = $state(false);
	let editingAssignment: AdminRoleAssignmentWithUser | null = $state(null);
	let editAssignmentScopeType: AssignableAdminRoleScopeType = $state('tenant');
	let editAssignmentScopeId = $state('');
	let editAssignmentExpiresAt = $state('');
	let updatingAssignment = $state(false);
	let assignmentEditError = $state('');

	// Group permissions by category for display
	let permissionsByCategory = $derived.by(() => {
		if (!role) return [];

		const rolePermissions = new Set(role.permissions);
		const hasFullAccess = rolePermissions.has('*');

		return ADMIN_PERMISSION_DEFINITIONS.map((category) => {
			const categoryPermissions = category.permissions.map((perm) => ({
				...perm,
				hasPermission: hasFullAccess || rolePermissions.has(perm.key)
			}));

			const hasAnyPermission = categoryPermissions.some((p) => p.hasPermission);
			const hasAllPermissions = categoryPermissions.every((p) => p.hasPermission);

			return {
				...category,
				permissions: categoryPermissions,
				hasAnyPermission,
				hasAllPermissions
			};
		});
	});

	async function loadRole() {
		loading = true;
		error = '';
		assignmentError = '';

		try {
			const [roleResponse, assignmentsResponse, adminsResponse] = await Promise.all([
				adminAdminRolesAPI.get(roleId!),
				adminAdminRolesAPI.listAssignments(roleId!),
				adminAdminsAPI.list({ page: 1, limit: 100, status: 'active' })
			]);
			role = roleResponse;
			assignments = assignmentsResponse.items;
			adminUsers = adminsResponse.items;
		} catch (err) {
			console.error('Failed to load role:', err);
			error = err instanceof Error ? err.message : 'Failed to load role';
		} finally {
			loading = false;
		}
	}

	async function loadAssignments() {
		if (!roleId) return;
		assignmentError = '';
		try {
			const response = await adminAdminRolesAPI.listAssignments(roleId);
			assignments = response.items;
		} catch (err) {
			assignmentError = err instanceof Error ? err.message : 'Failed to load role assignments';
		}
	}

	async function refreshRoleSummary() {
		if (!roleId) return;
		const [roleResponse, assignmentsResponse] = await Promise.all([
			adminAdminRolesAPI.get(roleId),
			adminAdminRolesAPI.listAssignments(roleId)
		]);
		role = roleResponse;
		assignments = assignmentsResponse.items;
	}

	onMount(() => {
		loadRole();
	});

	function openEditDialog() {
		if (!role) return;
		editDisplayName = role.display_name || '';
		editDescription = role.description || '';
		editPermissions.clear();
		role.permissions.forEach((permission) => editPermissions.add(permission));
		showEditDialog = true;
	}

	function closeEditDialog() {
		showEditDialog = false;
	}

	function openAssignDialog() {
		if (!role) return;
		const assignedUserIds = new Set(assignments.map((assignment) => assignment.admin_user_id));
		selectedAdminUserId = adminUsers.find((user) => !assignedUserIds.has(user.id))?.id || '';
		assignScopeType = 'tenant';
		assignScopeId = role.tenant_id;
		assignExpiresAt = '';
		assignError = '';
		showAssignDialog = true;
	}

	function closeAssignDialog() {
		showAssignDialog = false;
	}

	function handleScopeTypeChange() {
		if (!role) return;
		if (assignScopeType === 'tenant') {
			assignScopeId = role.tenant_id;
		} else if (assignScopeType === 'global') {
			assignScopeId = '';
		} else {
			assignScopeId = '';
		}
	}

	function openAssignmentEditDialog(assignment: AdminRoleAssignmentWithUser) {
		editingAssignment = assignment;
		editAssignmentScopeType = assignment.scope_type === 'global' ? 'global' : 'tenant';
		editAssignmentScopeId =
			editAssignmentScopeType === 'tenant' ? assignment.scope_id || role?.tenant_id || '' : '';
		editAssignmentExpiresAt = timestampToDateTimeLocal(assignment.expires_at);
		assignmentEditError = '';
		showAssignmentEditDialog = true;
	}

	function closeAssignmentEditDialog() {
		showAssignmentEditDialog = false;
		editingAssignment = null;
	}

	function handleEditAssignmentScopeTypeChange() {
		if (editAssignmentScopeType === 'tenant') {
			editAssignmentScopeId = editingAssignment?.scope_id || role?.tenant_id || '';
		} else {
			editAssignmentScopeId = '';
		}
	}

	async function handleSave() {
		if (!role) return;

		saving = true;

		try {
			await adminAdminRolesAPI.update(role.id, {
				display_name: editDisplayName.trim() || undefined,
				description: editDescription.trim() || undefined,
				permissions: Array.from(editPermissions)
			});
			closeEditDialog();
			loadRole();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to update role');
		} finally {
			saving = false;
		}
	}

	async function handleAssign() {
		if (!role) return;
		if (!selectedAdminUserId) {
			assignError = 'Admin user is required';
			return;
		}

		assigning = true;
		assignError = '';

		try {
			const expiresAt = assignExpiresAt ? new Date(assignExpiresAt).getTime() : undefined;
			await adminAdminRolesAPI.assignRole(role.id, {
				admin_user_id: selectedAdminUserId,
				scope_type: assignScopeType,
				scope_id: assignScopeType === 'global' ? undefined : assignScopeId.trim() || undefined,
				expires_at: expiresAt
			});
			closeAssignDialog();
			await refreshRoleSummary();
		} catch (err) {
			assignError = err instanceof Error ? err.message : 'Failed to assign role';
		} finally {
			assigning = false;
		}
	}

	async function handleUpdateAssignment() {
		if (!role || !editingAssignment) return;

		updatingAssignment = true;
		assignmentEditError = '';

		try {
			await adminAdminRolesAPI.updateAssignment(role.id, editingAssignment.id, {
				scope_type: editAssignmentScopeType,
				scope_id:
					editAssignmentScopeType === 'tenant'
						? editAssignmentScopeId.trim() || undefined
						: undefined,
				expires_at: editAssignmentExpiresAt ? new Date(editAssignmentExpiresAt).getTime() : null
			});
			closeAssignmentEditDialog();
			await refreshRoleSummary();
		} catch (err) {
			assignmentEditError = err instanceof Error ? err.message : 'Failed to update role assignment';
		} finally {
			updatingAssignment = false;
		}
	}

	async function handleRemoveAssignment(assignment: AdminRoleAssignmentWithUser) {
		if (!role) return;
		const userLabel = assignment.user?.email || assignment.admin_user_id;
		if (!confirm(`Remove this role assignment from ${userLabel}?`)) return;

		try {
			await adminAdminRolesAPI.removeAssignment(role.id, assignment.id);
			await refreshRoleSummary();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to remove role assignment');
		}
	}

	async function handleDelete() {
		if (!role) return;
		if (!confirm(`Are you sure you want to delete the role "${role.name}"?`)) return;

		try {
			await adminAdminRolesAPI.delete(role.id);
			goto('/admin/admin-rbac');
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to delete role');
		}
	}

	function togglePermission(permKey: string) {
		if (editPermissions.has(permKey)) {
			editPermissions.delete(permKey);
		} else {
			editPermissions.add(permKey);
		}
	}

	function toggleCategory(categoryPermissions: { key: string }[]) {
		const categoryKeys = categoryPermissions.map((p) => p.key);
		const allSelected = categoryKeys.every((key) => editPermissions.has(key));

		if (allSelected) {
			// Deselect all in category
			categoryKeys.forEach((key) => editPermissions.delete(key));
		} else {
			// Select all in category
			categoryKeys.forEach((key) => editPermissions.add(key));
		}
	}

	function isCategoryFullySelected(categoryPermissions: { key: string }[]): boolean {
		return categoryPermissions.every((p) => editPermissions.has(p.key));
	}

	function isCategoryPartiallySelected(categoryPermissions: { key: string }[]): boolean {
		const hasAny = categoryPermissions.some((p) => editPermissions.has(p.key));
		const hasAll = categoryPermissions.every((p) => editPermissions.has(p.key));
		return hasAny && !hasAll;
	}

	function handleBack() {
		goto('/admin/admin-rbac');
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString();
	}

	function timestampToDateTimeLocal(timestamp: number | null): string {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		const offsetMs = date.getTimezoneOffset() * 60_000;
		return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
	}

	function formatScope(assignment: AdminRoleAssignmentWithUser): string {
		if (assignment.scope_type === 'global') {
			return 'Global';
		}
		if (assignment.scope_type === 'tenant') {
			return `Tenant: ${assignment.scope_id || assignment.tenant_id}`;
		}
		// Existing records may contain reserved scope values, but the AdminUI no longer creates them.
		return `Unsupported scope: ${assignment.scope_type}${assignment.scope_id ? `:${assignment.scope_id}` : ''}`;
	}

	function formatAdminUser(assignment: AdminRoleAssignmentWithUser): string {
		if (!assignment.user) return assignment.admin_user_id;
		return assignment.user.name
			? `${assignment.user.name} <${assignment.user.email}>`
			: assignment.user.email;
	}

	function assignmentStatus(assignment: AdminRoleAssignmentWithUser): 'active' | 'expired' {
		return assignment.expires_at && assignment.expires_at <= Date.now() ? 'expired' : 'active';
	}
</script>

<svelte:head>
	<title>{role?.display_name || role?.name || 'Admin Role'} - Authrim</title>
</svelte:head>

<div class="admin-page">
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>Loading role...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadRole}>Retry</button>
			<button class="btn btn-secondary" onclick={handleBack}>Back to List</button>
		</div>
	{:else if role}
		<!-- Page Header -->
		<div class="page-header">
			<div>
				<div class="breadcrumb">
					<button class="breadcrumb-link" onclick={handleBack}>Admin RBAC</button>
					<span class="breadcrumb-separator">/</span>
					<span>{role.display_name || role.name}</span>
				</div>
				<h1 class="page-title">{role.display_name || role.name}</h1>
				{#if role.description}
					<p class="page-description">{role.description}</p>
				{/if}
			</div>
			<div class="page-actions">
				{#if canEditAdminRole(role)}
					<button class="btn btn-secondary" onclick={openEditDialog}>
						<i class="i-ph-pencil"></i>
						Edit
					</button>
				{/if}
				{#if canDeleteAdminRole(role)}
					<button class="btn btn-danger" onclick={handleDelete}>
						<i class="i-ph-trash"></i>
						Delete
					</button>
				{/if}
			</div>
		</div>

		<!-- Content -->
		<div class="detail-grid">
			<!-- Basic Info Card -->
			<div class="detail-card">
				<h2 class="card-title">Basic Information</h2>
				<div class="info-grid">
					<div class="info-item">
						<span class="info-label">Role Name</span>
						<span class="info-value">{role.name}</span>
					</div>
					<div class="info-item">
						<span class="info-label">Role Type</span>
						<span class={getRoleTypeBadgeClass(role.role_type)}>
							{role.role_type}
						</span>
					</div>
					<div class="info-item">
						<span class="info-label">Hierarchy Level</span>
						<span class="info-value">{role.hierarchy_level}</span>
					</div>
					{#if role.display_name}
						<div class="info-item">
							<span class="info-label">Display Name</span>
							<span class="info-value">{role.display_name}</span>
						</div>
					{/if}
					<div class="info-item">
						<span class="info-label">Assigned Users</span>
						<span class="info-value">{role.assigned_user_count}</span>
					</div>
					<div class="info-item">
						<span class="info-label">Assignment Scopes</span>
						<span class="info-value">{new Set(assignments.map((a) => a.scope_type)).size}</span>
					</div>
				</div>
			</div>

			<!-- Role Assignments Card -->
			<div class="detail-card">
				<div class="card-title-row">
					<h2 class="card-title">
						Role Assignments
						<span class="badge">{assignments.length}</span>
					</h2>
					<button class="btn btn-sm btn-primary" onclick={openAssignDialog}>
						<i class="i-ph-plus"></i>
						Assign
					</button>
				</div>

				{#if assignmentError}
					<div class="inline-error">
						<span>{assignmentError}</span>
						<button class="btn btn-sm btn-secondary" onclick={loadAssignments}>Retry</button>
					</div>
				{:else if assignments.length === 0}
					<p class="empty-message">No active assignments</p>
				{:else}
					<div class="table-container">
						<table class="table">
							<thead>
								<tr>
									<th>Admin User</th>
									<th>Scope Binding</th>
									<th>Status</th>
									<th>Expires</th>
									<th>Assigned By</th>
									<th>Created</th>
									<th class="actions-cell">Actions</th>
								</tr>
							</thead>
							<tbody>
								{#each assignments as assignment (assignment.id)}
									<tr>
										<td>
											<div class="user-cell">
												<span>{formatAdminUser(assignment)}</span>
												{#if assignment.user && !assignment.user.is_active}
													<span class="badge badge-warning">Inactive</span>
												{/if}
											</div>
										</td>
										<td><span class="scope-chip">{formatScope(assignment)}</span></td>
										<td>
											<span
												class={assignmentStatus(assignment) === 'active'
													? 'badge badge-success'
													: 'badge badge-neutral'}
											>
												{assignmentStatus(assignment)}
											</span>
										</td>
										<td>{formatDate(assignment.expires_at)}</td>
										<td>{assignment.assigned_by || '-'}</td>
										<td>{formatDate(assignment.created_at)}</td>
										<td class="actions-cell">
											<button
												class="btn btn-sm btn-secondary"
												onclick={() => openAssignmentEditDialog(assignment)}
											>
												Edit
											</button>
											<button
												class="btn btn-sm btn-danger"
												onclick={() => handleRemoveAssignment(assignment)}
											>
												Remove
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>

			<!-- Permissions Card -->
			<div class="detail-card">
				<h2 class="card-title">
					Permissions
					<span class="badge">{role.permissions.length}</span>
				</h2>

				{#if role.permissions.length === 0}
					<p class="empty-message">No permissions assigned</p>
				{:else}
					<div class="permission-editor-grid permission-view-grid">
						{#each permissionsByCategory as category (category.category)}
							<div class="permission-category-editor">
								<div class="permission-category-header">
									<label class="form-checkbox-label permission-view-label">
										<input
											type="checkbox"
											checked={category.hasAllPermissions}
											indeterminate={category.hasAnyPermission && !category.hasAllPermissions}
											disabled
										/>
										<span class="permission-category-name">{category.category}</span>
									</label>
								</div>
								<div class="permission-category-body">
									{#each category.permissions as perm (perm.key)}
										<label
											class="permission-checkbox-item permission-view-item"
											class:permission-unchecked={!perm.hasPermission}
										>
											<input type="checkbox" checked={perm.hasPermission} disabled />
											<span class="permission-checkbox-info">
												<span class="permission-checkbox-label">{perm.key}</span>
												<span class="permission-checkbox-desc">{perm.description}</span>
											</span>
										</label>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<!-- Edit Dialog -->
<Modal
	open={showEditDialog && !!role}
	onClose={closeEditDialog}
	title="Edit Role: {role?.name || ''}"
	size="lg"
>
	<div class="form-group">
		<label for="editDisplayName">Display Name</label>
		<input
			type="text"
			id="editDisplayName"
			class="input"
			bind:value={editDisplayName}
			placeholder="e.g., Security Administrator"
		/>
	</div>
	<div class="form-group">
		<label for="editDescription">Description</label>
		<textarea
			id="editDescription"
			class="input"
			bind:value={editDescription}
			placeholder="What this role can do..."
			rows="2"
		></textarea>
	</div>
	<div class="form-group">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label>Permissions</label>
		<div class="permission-editor-grid">
			{#each ADMIN_PERMISSION_DEFINITIONS as category (category.category)}
				<div class="permission-category-editor">
					<div class="permission-category-header">
						<label class="form-checkbox-label">
							<input
								type="checkbox"
								checked={isCategoryFullySelected(category.permissions)}
								indeterminate={isCategoryPartiallySelected(category.permissions)}
								onchange={() => toggleCategory(category.permissions)}
							/>
							<span class="permission-category-name">{category.category}</span>
						</label>
					</div>
					<div class="permission-category-body">
						{#each category.permissions as perm (perm.key)}
							<label class="permission-checkbox-item">
								<input
									type="checkbox"
									checked={editPermissions.has(perm.key)}
									onchange={() => togglePermission(perm.key)}
								/>
								<span class="permission-checkbox-info">
									<span class="permission-checkbox-label">{perm.key}</span>
									<span class="permission-checkbox-desc">{perm.description}</span>
								</span>
							</label>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeEditDialog} disabled={saving}> Cancel </button>
		<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
			{saving ? 'Saving...' : 'Save'}
		</button>
	{/snippet}
</Modal>

<!-- Edit Assignment Dialog -->
<Modal
	open={showAssignmentEditDialog && !!editingAssignment}
	onClose={closeAssignmentEditDialog}
	title="Edit Role Assignment"
	size="md"
>
	{#if assignmentEditError}
		<div class="form-error">{assignmentEditError}</div>
	{/if}
	{#if editingAssignment}
		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label>Admin User</label>
			<div class="readonly-value">{formatAdminUser(editingAssignment)}</div>
		</div>
		<div class="form-row">
			<div class="form-group">
				<label for="editAssignmentScopeType">Scope Type</label>
				<select
					id="editAssignmentScopeType"
					class="input"
					bind:value={editAssignmentScopeType}
					onchange={handleEditAssignmentScopeTypeChange}
				>
					<option value="tenant">Tenant</option>
					<option value="global">Global</option>
				</select>
			</div>
			<div class="form-group">
				<label for="editAssignmentScopeId">Scope ID</label>
				<input
					id="editAssignmentScopeId"
					class="input"
					type="text"
					bind:value={editAssignmentScopeId}
					placeholder={role?.tenant_id || 'tenant_id'}
					disabled={editAssignmentScopeType === 'global'}
				/>
			</div>
		</div>
		<div class="form-group">
			<label for="editAssignmentExpiresAt">Expires At</label>
			<input
				id="editAssignmentExpiresAt"
				class="input"
				type="datetime-local"
				bind:value={editAssignmentExpiresAt}
			/>
		</div>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={closeAssignmentEditDialog}
			disabled={updatingAssignment}
		>
			Cancel
		</button>
		<button
			class="btn btn-primary"
			onclick={handleUpdateAssignment}
			disabled={updatingAssignment || !editingAssignment}
		>
			{updatingAssignment ? 'Saving...' : 'Save'}
		</button>
	{/snippet}
</Modal>

<!-- Assign Role Dialog -->
<Modal
	open={showAssignDialog && !!role}
	onClose={closeAssignDialog}
	title="Assign Role: {role?.name || ''}"
	size="md"
>
	{#if assignError}
		<div class="form-error">{assignError}</div>
	{/if}

	<div class="form-group">
		<label for="assignAdminUser">Admin User</label>
		<select id="assignAdminUser" class="input" bind:value={selectedAdminUserId}>
			<option value="">Select admin user</option>
			{#each adminUsers as user (user.id)}
				<option value={user.id}>{user.name ? `${user.name} <${user.email}>` : user.email}</option>
			{/each}
		</select>
	</div>

	<div class="form-row">
		<div class="form-group">
			<label for="assignScopeType">Scope Type</label>
			<select
				id="assignScopeType"
				class="input"
				bind:value={assignScopeType}
				onchange={handleScopeTypeChange}
			>
				<option value="tenant">Tenant</option>
				<option value="global">Global</option>
			</select>
		</div>
		<div class="form-group">
			<label for="assignScopeId">Scope ID</label>
			<input
				id="assignScopeId"
				class="input"
				type="text"
				bind:value={assignScopeId}
				placeholder={role?.tenant_id || 'tenant_id'}
				disabled={assignScopeType === 'global'}
			/>
		</div>
	</div>

	<div class="form-group">
		<label for="assignExpiresAt">Expires At</label>
		<input id="assignExpiresAt" class="input" type="datetime-local" bind:value={assignExpiresAt} />
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeAssignDialog} disabled={assigning}>
			Cancel
		</button>
		<button class="btn btn-primary" onclick={handleAssign} disabled={assigning}>
			{assigning ? 'Assigning...' : 'Assign Role'}
		</button>
	{/snippet}
</Modal>

<style>
	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		margin-bottom: 0.5rem;
	}

	.breadcrumb-link {
		color: var(--text-secondary);
		text-decoration: none;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font-size: inherit;
	}

	.breadcrumb-link:hover {
		color: var(--primary);
	}

	.breadcrumb-separator {
		color: var(--text-tertiary);
	}

	.detail-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1.5rem;
	}

	.detail-card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.5rem;
	}

	.card-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 1rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.card-title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.card-title-row .card-title {
		margin: 0;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.125rem 0.5rem;
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 500;
		border-radius: var(--radius-full);
	}

	.info-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1rem;
	}

	.info-item {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.info-label {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.info-value {
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	.empty-message {
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.inline-error,
	.form-error {
		padding: 0.75rem;
		border: 1px solid var(--danger);
		border-radius: var(--radius-md);
		color: var(--danger);
		background: var(--danger-light);
		font-size: 0.875rem;
	}

	.inline-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.table-container {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}

	.table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	.table th,
	.table td {
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: middle;
	}

	.table th {
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
	}

	.table tr:last-child td {
		border-bottom: none;
	}

	.actions-cell {
		text-align: right;
		white-space: nowrap;
	}

	.actions-cell .btn + .btn {
		margin-left: 0.5rem;
	}

	.user-cell {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 220px;
	}

	.scope-chip {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-full);
		background: var(--bg-subtle);
		font-size: 0.75rem;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.readonly-value {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--text-secondary);
		gap: 1rem;
	}

	.error-text {
		color: var(--danger);
	}

	/* Form input styling */
	.input,
	textarea.input,
	select.input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: inherit;
	}

	.input:focus,
	textarea.input:focus,
	select.input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-subtle);
	}

	/* Permissions editor in dialog */
	.permission-editor-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 0.75rem;
		max-height: 400px;
		overflow-y: auto;
		padding: 0.5rem;
		background: var(--bg-subtle);
		border-radius: var(--radius-md);
	}

	.permission-view-grid {
		max-height: none;
		overflow: visible;
		padding: 0;
		background: transparent;
	}

	.permission-category-editor {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--bg-card);
	}

	.permission-category-header {
		background: var(--bg-subtle);
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.form-checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		user-select: none;
	}

	.form-checkbox-label input[type='checkbox'] {
		cursor: pointer;
	}

	.permission-view-label,
	.permission-view-label input[type='checkbox'],
	.permission-view-item,
	.permission-view-item input[type='checkbox'] {
		cursor: default;
	}

	.permission-category-name {
		font-weight: 600;
		font-size: 0.8125rem;
		color: var(--text-primary);
	}

	.permission-category-body {
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.permission-checkbox-item {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.375rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.permission-checkbox-item:hover {
		background: var(--bg-subtle);
	}

	.permission-view-item:hover {
		background: transparent;
	}

	.permission-unchecked {
		opacity: 0.48;
	}

	.permission-checkbox-item input[type='checkbox'] {
		margin-top: 0.25rem;
		cursor: pointer;
	}

	.permission-checkbox-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.permission-checkbox-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.permission-checkbox-desc {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	@media (max-width: 720px) {
		.form-row {
			grid-template-columns: 1fr;
		}

		.card-title-row {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>

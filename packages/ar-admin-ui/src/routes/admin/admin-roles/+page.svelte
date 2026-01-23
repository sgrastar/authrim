<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminAdminRolesAPI,
		type AdminRole,
		type AdminPermission,
		canEditAdminRole,
		canDeleteAdminRole,
		getRoleTypeBadgeClass
	} from '$lib/api/admin-admin-roles';

	let roles: AdminRole[] = $state([]);
	let permissions: AdminPermission[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newRoleName = $state('');
	let newRoleDisplayName = $state('');
	let newRoleDescription = $state('');
	let selectedPermissions = $state<Set<string>>(new Set());

	// Edit dialog state
	let showEditDialog = $state(false);
	let editingRole: AdminRole | null = $state(null);
	let editDisplayName = $state('');
	let editDescription = $state('');
	let editPermissions = $state<Set<string>>(new Set());
	let saving = $state(false);

	async function loadRoles() {
		loading = true;
		error = '';

		try {
			const response = await adminAdminRolesAPI.list();
			roles = response.items;
		} catch (err) {
			console.error('Failed to load roles:', err);
			error = err instanceof Error ? err.message : 'Failed to load admin roles';
		} finally {
			loading = false;
		}
	}

	async function loadPermissions() {
		try {
			const response = await adminAdminRolesAPI.listPermissions();
			permissions = response.items;
		} catch (err) {
			console.error('Failed to load permissions:', err);
		}
	}

	onMount(() => {
		loadRoles();
		loadPermissions();
	});

	function openCreateDialog() {
		newRoleName = '';
		newRoleDisplayName = '';
		newRoleDescription = '';
		selectedPermissions = new Set();
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function handleCreate() {
		if (!newRoleName.trim()) {
			createError = 'Role name is required';
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminAdminRolesAPI.create({
				name: newRoleName.trim(),
				display_name: newRoleDisplayName.trim() || undefined,
				description: newRoleDescription.trim() || undefined,
				permissions: Array.from(selectedPermissions)
			});
			closeCreateDialog();
			loadRoles();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create role';
		} finally {
			creating = false;
		}
	}

	function openEditDialog(role: AdminRole) {
		editingRole = role;
		editDisplayName = role.display_name || '';
		editDescription = role.description || '';
		editPermissions = new Set(role.permissions);
		showEditDialog = true;
	}

	function closeEditDialog() {
		showEditDialog = false;
		editingRole = null;
	}

	async function handleSave() {
		if (!editingRole) return;

		saving = true;

		try {
			await adminAdminRolesAPI.update(editingRole.id, {
				display_name: editDisplayName.trim() || undefined,
				description: editDescription.trim() || undefined,
				permissions: Array.from(editPermissions)
			});
			closeEditDialog();
			loadRoles();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to update role');
		} finally {
			saving = false;
		}
	}

	async function handleDelete(role: AdminRole) {
		if (!confirm(`Are you sure you want to delete the role "${role.name}"?`)) return;

		try {
			await adminAdminRolesAPI.delete(role.id);
			loadRoles();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to delete role');
		}
	}

	function togglePermission(permSet: Set<string>, perm: string) {
		if (permSet.has(perm)) {
			permSet.delete(perm);
		} else {
			permSet.add(perm);
		}
		// Force reactivity
		if (showCreateDialog) {
			selectedPermissions = new Set(selectedPermissions);
		} else {
			editPermissions = new Set(editPermissions);
		}
	}
</script>

<svelte:head>
	<title>Admin Roles - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Admin Roles</h1>
			<p class="page-description">Manage roles and permissions for administrator accounts</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				Create Role
			</button>
		</div>
	</div>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>Loading admin roles...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadRoles}>Retry</button>
		</div>
	{:else if roles.length === 0}
		<div class="empty-state">
			<p>No admin roles found</p>
		</div>
	{:else}
		<div class="roles-grid">
			{#each roles as role (role.id)}
				<div class="role-card">
					<div class="role-header">
						<div class="role-title">
							<h3>{role.display_name || role.name}</h3>
							<span class="role-name">{role.name}</span>
						</div>
						<span class={getRoleTypeBadgeClass(role.role_type)}>
							{role.role_type}
						</span>
					</div>
					{#if role.description}
						<p class="role-description">{role.description}</p>
					{/if}
					<div class="role-permissions">
						<span class="permissions-label">Permissions:</span>
						<div class="permissions-list">
							{#if role.permissions.length === 0}
								<span class="text-muted">None</span>
							{:else if role.permissions.includes('*')}
								<span class="permission-badge permission-all">Full Access</span>
							{:else}
								{#each role.permissions.slice(0, 5) as perm (perm)}
									<span class="permission-badge">{perm}</span>
								{/each}
								{#if role.permissions.length > 5}
									<span class="permission-badge permission-more">
										+{role.permissions.length - 5} more
									</span>
								{/if}
							{/if}
						</div>
					</div>
					<div class="role-meta">
						<span>Level: {role.hierarchy_level}</span>
					</div>
					<div class="role-actions">
						{#if canEditAdminRole(role)}
							<button class="btn btn-sm btn-secondary" onclick={() => openEditDialog(role)}>
								Edit
							</button>
						{/if}
						{#if canDeleteAdminRole(role)}
							<button class="btn btn-sm btn-danger" onclick={() => handleDelete(role)}>
								Delete
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Create Role Dialog -->
{#if showCreateDialog}
	<div class="dialog-overlay" onclick={closeCreateDialog}>
		<div class="dialog dialog-lg" onclick={(e) => e.stopPropagation()}>
			<div class="dialog-header">
				<h2>Create Admin Role</h2>
				<button class="close-btn" onclick={closeCreateDialog}>&times;</button>
			</div>
			<div class="dialog-body">
				{#if createError}
					<div class="alert alert-danger">{createError}</div>
				{/if}
				<div class="form-group">
					<label for="name">Role Name *</label>
					<input
						type="text"
						id="name"
						class="input"
						bind:value={newRoleName}
						placeholder="e.g., security_admin"
					/>
				</div>
				<div class="form-group">
					<label for="displayName">Display Name</label>
					<input
						type="text"
						id="displayName"
						class="input"
						bind:value={newRoleDisplayName}
						placeholder="e.g., Security Administrator"
					/>
				</div>
				<div class="form-group">
					<label for="description">Description</label>
					<textarea
						id="description"
						class="input"
						bind:value={newRoleDescription}
						placeholder="What this role can do..."
						rows="2"
					></textarea>
				</div>
				<div class="form-group">
					<label>Permissions</label>
					<div class="permissions-grid">
						{#each permissions as perm (perm.key)}
							<label class="permission-checkbox">
								<input
									type="checkbox"
									checked={selectedPermissions.has(perm.key)}
									onchange={() => togglePermission(selectedPermissions, perm.key)}
								/>
								<span class="permission-key">{perm.key}</span>
								<span class="permission-desc">{perm.description}</span>
							</label>
						{/each}
					</div>
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

<!-- Edit Role Dialog -->
{#if showEditDialog && editingRole}
	<div class="dialog-overlay" onclick={closeEditDialog}>
		<div class="dialog dialog-lg" onclick={(e) => e.stopPropagation()}>
			<div class="dialog-header">
				<h2>Edit Role: {editingRole.name}</h2>
				<button class="close-btn" onclick={closeEditDialog}>&times;</button>
			</div>
			<div class="dialog-body">
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
					<label>Permissions</label>
					<div class="permissions-grid">
						{#each permissions as perm (perm.key)}
							<label class="permission-checkbox">
								<input
									type="checkbox"
									checked={editPermissions.has(perm.key)}
									onchange={() => togglePermission(editPermissions, perm.key)}
								/>
								<span class="permission-key">{perm.key}</span>
								<span class="permission-desc">{perm.description}</span>
							</label>
						{/each}
					</div>
				</div>
			</div>
			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={closeEditDialog} disabled={saving}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
					{saving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Page-specific styles for Admin Roles */
	.roles-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
		gap: 1rem;
	}

	.role-card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.25rem;
	}

	.role-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 0.75rem;
	}

	.role-title h3 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.role-name {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.role-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin-bottom: 0.75rem;
	}

	.role-permissions {
		margin-bottom: 0.75rem;
	}

	.permissions-label {
		font-size: 0.75rem;
		color: var(--text-secondary);
		display: block;
		margin-bottom: 0.5rem;
	}

	.permissions-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.permission-badge {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		font-size: 0.75rem;
		background: var(--bg-subtle);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
	}

	.permission-all {
		background: var(--primary-subtle);
		color: var(--primary);
	}

	.permission-more {
		background: var(--bg-subtle);
		color: var(--text-tertiary);
	}

	.role-meta {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-bottom: 0.75rem;
	}

	.role-actions {
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
	.dialog-lg {
		max-width: 600px;
		width: 95%;
	}

	.dialog-body {
		padding: 1.5rem;
		max-height: 60vh;
		overflow-y: auto;
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.5rem;
		border-top: 1px solid var(--border);
	}

	/* Form input styling */
	.input,
	textarea.input {
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
	textarea.input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-subtle);
	}

	/* Permissions grid in dialog */
	.permissions-grid {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: 200px;
		overflow-y: auto;
		padding: 0.5rem;
		background: var(--bg-subtle);
		border-radius: var(--radius-md);
	}

	.permission-checkbox {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem;
		background: var(--bg-card);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.permission-checkbox:hover {
		background: var(--bg-subtle);
	}

	.permission-checkbox input {
		margin-top: 0.25rem;
	}

	.permission-key {
		font-weight: 500;
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	.permission-desc {
		font-size: 0.75rem;
		color: var(--text-secondary);
		display: block;
	}

	/* Alert for dialog errors */
	.alert-danger {
		background: var(--danger-subtle);
		color: var(--danger);
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminAdminRolesAPI,
		type AdminRole,
		type AdminPermission,
		canEditAdminRole,
		canDeleteAdminRole,
		getRoleTypeBadgeClass
	} from '$lib/api/admin-admin-roles';
	import { LL } from '$i18n/i18n-svelte';
	import { formatAdminRoleType } from '$lib/admin/admin-admin-rbac-i18n';
	import { Modal } from '$lib/components';

	let roles: AdminRole[] = $state([]);
	let permissions: AdminPermission[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Create dialog state (unused, kept for future implementation)
	let showCreateDialog = $state(false);
	let _creating = $state(false);
	let _createError = $state('');
	let newRoleName = $state('');
	let newRoleDisplayName = $state('');
	let newRoleDescription = $state('');
	let selectedPermissions = $state<Set<string>>(new Set());

	// Edit dialog state (unused, kept for future implementation)
	let _showEditDialog = $state(false);
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
		} catch {
			error = $LL.admin_admin_rbac_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadPermissions() {
		try {
			const response = await adminAdminRolesAPI.listPermissions();
			permissions = response.items;
		} catch {
			// The list page can still render role cards without permission metadata.
		}
	}

	onMount(() => {
		loadRoles();
		loadPermissions();
	});

	function openCreateDialog() {
		goto('/admin/admin-rbac/new');
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function _handleCreate() {
		if (!newRoleName.trim()) {
			_createError = $LL.admin_admin_rbac_role_name_required();
			return;
		}

		_creating = true;
		_createError = '';

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
			_createError = err instanceof Error ? err.message : $LL.admin_admin_rbac_create_failed();
		} finally {
			_creating = false;
		}
	}

	function viewRole(role: AdminRole) {
		goto(`/admin/admin-rbac/${role.id}`);
	}

	function handleRoleCardKeydown(event: KeyboardEvent, role: AdminRole) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			viewRole(role);
		}
	}

	function openEditDialog(role: AdminRole) {
		editingRole = role;
		editDisplayName = role.display_name || '';
		editDescription = role.description || '';
		editPermissions = new Set(role.permissions);
		_showEditDialog = true;
	}

	function closeEditDialog() {
		_showEditDialog = false;
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
			alert(err instanceof Error ? err.message : $LL.admin_admin_rbac_update_failed());
		} finally {
			saving = false;
		}
	}

	async function handleDelete(role: AdminRole) {
		if (!confirm($LL.admin_admin_rbac_delete_confirm({ role: role.name }))) return;

		try {
			await adminAdminRolesAPI.delete(role.id);
			loadRoles();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admin_rbac_delete_failed());
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
	<title>{$LL.admin_admin_rbac_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_admin_rbac_title()}</h1>
			<p class="page-description">{$LL.admin_admin_rbac_description()}</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				{$LL.admin_admin_rbac_create_role()}
			</button>
		</div>
	</div>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>{$LL.admin_admin_rbac_loading()}</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadRoles}>
				{$LL.admin_admin_rbac_retry()}
			</button>
		</div>
	{:else if roles.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_admin_rbac_empty()}</p>
		</div>
	{:else}
		<div class="roles-grid">
			{#each roles as role (role.id)}
				<div
					class="role-card"
					role="button"
					tabindex="0"
					onclick={() => viewRole(role)}
					onkeydown={(event) => handleRoleCardKeydown(event, role)}
				>
					<div class="role-header">
						<div class="role-title">
							<h3>{role.display_name || role.name}</h3>
							<span class="role-name">{role.name}</span>
						</div>
						<span class={getRoleTypeBadgeClass(role.role_type)}>
							{formatAdminRoleType(role.role_type, $LL)}
						</span>
					</div>
					{#if role.description}
						<p class="role-description">{role.description}</p>
					{/if}
					<div class="role-permissions">
						<span class="permissions-label">{$LL.admin_admin_rbac_permissions()}:</span>
						<div class="permissions-list">
							{#if role.permissions.length === 0}
								<span class="text-muted">{$LL.admin_admin_rbac_none()}</span>
							{:else if role.permissions.includes('*')}
								<span class="permission-badge permission-all">
									{$LL.admin_admin_rbac_full_access()}
								</span>
							{:else}
								{#each role.permissions.slice(0, 5) as perm (perm)}
									<span class="permission-badge">{perm}</span>
								{/each}
								{#if role.permissions.length > 5}
									<span class="permission-badge permission-more">
										{$LL.admin_admin_rbac_more_permissions({
											count: role.permissions.length - 5
										})}
									</span>
								{/if}
							{/if}
						</div>
					</div>
					<div class="role-meta">
						<span>{$LL.admin_admin_rbac_level({ level: role.hierarchy_level })}</span>
					</div>
					<div class="role-actions">
						{#if canEditAdminRole(role)}
							<button
								class="btn btn-sm btn-secondary"
								type="button"
								onclick={(event) => {
									event.stopPropagation();
									openEditDialog(role);
								}}
							>
								{$LL.admin_admin_rbac_edit()}
							</button>
						{/if}
						{#if canDeleteAdminRole(role)}
							<button
								class="btn btn-sm btn-danger"
								type="button"
								onclick={(event) => {
									event.stopPropagation();
									handleDelete(role);
								}}
							>
								{$LL.admin_admin_rbac_delete()}
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Edit Role Dialog -->
<Modal
	open={_showEditDialog && !!editingRole}
	onClose={closeEditDialog}
	title={$LL.admin_admin_rbac_edit_title({ role: editingRole?.name || '' })}
	size="lg"
>
	<div class="form-group">
		<label for="editDisplayName">{$LL.admin_admin_rbac_display_name()}</label>
		<input
			type="text"
			id="editDisplayName"
			class="input"
			bind:value={editDisplayName}
			placeholder={$LL.admin_admin_rbac_display_name_placeholder()}
		/>
	</div>
	<div class="form-group">
		<label for="editDescription">{$LL.admin_admin_rbac_description_label()}</label>
		<textarea
			id="editDescription"
			class="input"
			bind:value={editDescription}
			placeholder={$LL.admin_admin_rbac_description_placeholder()}
			rows="2"
		></textarea>
	</div>
	<div class="form-group">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label>{$LL.admin_admin_rbac_permissions()}</label>
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

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeEditDialog} disabled={saving}>
			{$LL.admin_admin_rbac_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
			{saving ? $LL.admin_admin_rbac_saving() : $LL.admin_admin_rbac_save()}
		</button>
	{/snippet}
</Modal>

<style>
	/* Page-specific styles for Admin RBAC */
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
		cursor: pointer;
		transition: all var(--transition-fast);
		text-align: left;
		width: 100%;
	}

	.role-card:hover {
		border-color: var(--border-hover);
		box-shadow: var(--shadow-md);
		transform: translateY(-2px);
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
</style>

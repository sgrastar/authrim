<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminAdminRolesAPI,
		type AdminRole,
		type AdminPermission,
		canEditAdminRole,
		canDeleteAdminRole,
		getRoleTypeBadgeClass
	} from '$lib/api/admin-admin-roles';
	import { Modal } from '$lib/components';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

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
			error = err instanceof Error ? err.message : $LL.admin_admin_rbac_load_failed();
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
			createError = $LL.admin_admin_rbac_role_name_required();
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
			createError = err instanceof Error ? err.message : $LL.admin_admin_rbac_create_failed();
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

{#snippet pageActions()}
	<button class="btn btn-primary" onclick={openCreateDialog}>
		<i class="i-ph-plus" aria-hidden="true"></i>
		{$LL.admin_admin_rbac_create_role()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_rbac_perm_category_admin_roles()}
		description={$LL.admin_admin_rbac_description()}
		actions={pageActions}
	/>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>{$LL.admin_admin_rbac_loading()}</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadRoles}>{$LL.admin_admin_rbac_retry()}</button>
		</div>
	{:else if roles.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p>{$LL.admin_admin_rbac_empty()}</p>
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
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
							<span class="permissions-label">{$LL.admin_admin_rbac_permissions()}:</span>
							<div class="permissions-list">
								{#if role.permissions.length === 0}
									<span class="text-muted">{$LL.admin_admin_rbac_none()}</span>
								{:else if role.permissions.includes('*')}
									<span class="permission-badge permission-all"
										>{$LL.admin_admin_rbac_full_access()}</span
									>
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
								<button class="btn btn-sm btn-secondary" onclick={() => openEditDialog(role)}>
									{$LL.admin_admin_rbac_edit()}
								</button>
							{/if}
							{#if canDeleteAdminRole(role)}
								<button class="btn btn-sm btn-danger" onclick={() => handleDelete(role)}>
									{$LL.admin_admin_rbac_delete()}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<!-- Create Role Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_admin_rbac_create_title()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-danger">{createError}</div>
	{/if}
	<div class="admin-field dialog-field">
		<label for="name" class="admin-field__label">
			{$LL.admin_admin_rbac_role_name()}
			{$LL.admin_admin_rbac_required()}
		</label>
		<input
			type="text"
			id="name"
			class="admin-input"
			bind:value={newRoleName}
			placeholder={$LL.admin_admin_rbac_name_placeholder()}
		/>
	</div>
	<div class="admin-field dialog-field">
		<label for="displayName" class="admin-field__label">{$LL.admin_admin_rbac_display_name()}</label
		>
		<input
			type="text"
			id="displayName"
			class="admin-input"
			bind:value={newRoleDisplayName}
			placeholder={$LL.admin_admin_rbac_display_name_placeholder()}
		/>
	</div>
	<div class="admin-field dialog-field">
		<label for="description" class="admin-field__label">
			{$LL.admin_admin_rbac_description_label()}
		</label>
		<textarea
			id="description"
			class="admin-input"
			bind:value={newRoleDescription}
			placeholder={$LL.admin_admin_rbac_create_description_placeholder()}
			rows="2"
		></textarea>
	</div>
	<div class="admin-field dialog-field">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="admin-field__label">{$LL.admin_admin_rbac_permissions()}</label>
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

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_admin_rbac_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
			{creating ? $LL.admin_admin_rbac_creating() : $LL.admin_admin_rbac_create_button()}
		</button>
	{/snippet}
</Modal>

<!-- Edit Role Dialog -->
<Modal
	open={showEditDialog && !!editingRole}
	onClose={closeEditDialog}
	title={$LL.admin_admin_rbac_edit_title({ role: editingRole?.name || '' })}
	size="lg"
>
	<div class="admin-field dialog-field">
		<label for="editDisplayName" class="admin-field__label">
			{$LL.admin_admin_rbac_display_name()}
		</label>
		<input
			type="text"
			id="editDisplayName"
			class="admin-input"
			bind:value={editDisplayName}
			placeholder={$LL.admin_admin_rbac_display_name_placeholder()}
		/>
	</div>
	<div class="admin-field dialog-field">
		<label for="editDescription" class="admin-field__label">
			{$LL.admin_admin_rbac_description_label()}
		</label>
		<textarea
			id="editDescription"
			class="admin-input"
			bind:value={editDescription}
			placeholder={$LL.admin_admin_rbac_description_placeholder()}
			rows="2"
		></textarea>
	</div>
	<div class="admin-field dialog-field">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="admin-field__label">{$LL.admin_admin_rbac_permissions()}</label>
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
	/* Page-specific styles for Admin Roles */
	.roles-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
		gap: 1rem;
	}

	.role-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 1.25rem;
		box-shadow: var(--shadow-sm);
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
		color: var(--color-text);
	}

	.role-name {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.role-description {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin-bottom: 0.75rem;
	}

	.role-permissions {
		margin-bottom: 0.75rem;
	}

	.permissions-label {
		font-size: 0.75rem;
		color: var(--color-text-muted);
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
		background: var(--color-surface-raised);
		border-radius: var(--radius-control);
		color: var(--color-text-muted);
	}

	.permission-all {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.permission-more {
		background: var(--color-surface-raised);
		color: var(--color-text-subtle);
	}

	.role-meta {
		font-size: 0.75rem;
		color: var(--color-text-muted);
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
		color: var(--color-text-muted);
	}

	.error-text {
		color: var(--color-danger);
		margin-bottom: 1rem;
	}

	.dialog-field {
		display: grid;
		gap: 6px;
		margin-bottom: 16px;
	}

	.dialog-field :global(.admin-field__label) {
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
		color: var(--color-text-subtle);
	}

	.dialog-field :global(.admin-input) {
		width: 100%;
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.dialog-field :global(.admin-input:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	/* Permissions grid in dialog */
	.permissions-grid {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: 200px;
		overflow-y: auto;
		padding: 0.5rem;
		background: var(--color-surface-raised);
		border-radius: var(--radius-panel);
	}

	.permission-checkbox {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem;
		background: var(--color-surface);
		border-radius: var(--radius-control);
		cursor: pointer;
	}

	.permission-checkbox:hover {
		background: var(--color-surface-raised);
	}

	.permission-checkbox input {
		margin-top: 0.25rem;
	}

	.permission-key {
		font-weight: 500;
		font-size: 0.875rem;
		color: var(--color-text);
	}

	.permission-desc {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		display: block;
	}

	/* Alert for dialog errors */
	.alert-danger {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}
</style>

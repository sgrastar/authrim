<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminAdminRolesAPI,
		type AdminRoleDetail,
		ADMIN_PERMISSION_DEFINITIONS,
		canEditAdminRole,
		canDeleteAdminRole,
		getRoleTypeBadgeClass
	} from '$lib/api/admin-admin-roles';
	import { Modal } from '$lib/components';

	const roleId = $derived($page.params.id);

	let role: AdminRoleDetail | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Edit dialog state
	let showEditDialog = $state(false);
	let editDisplayName = $state('');
	let editDescription = $state('');
	const editPermissions = new SvelteSet<string>();
	let saving = $state(false);

	// Group permissions by category for display
	let permissionsByCategory = $derived.by(() => {
		if (!role) return [];

		const rolePermissions = new Set(role.permissions);

		return ADMIN_PERMISSION_DEFINITIONS.map((category) => {
			const categoryPermissions = category.permissions.map((perm) => ({
				...perm,
				hasPermission: rolePermissions.has(perm.key)
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
		loading = true;
		error = '';

		try {
			role = await adminAdminRolesAPI.get(roleId!);
		} catch (err) {
			console.error('Failed to load role:', err);
			error = err instanceof Error ? err.message : 'Failed to load role';
		} finally {
			loading = false;
		}
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
				</div>
			</div>

			<!-- Permissions Card -->
			<div class="detail-card">
				<h2 class="card-title">
					Permissions
					<span class="badge">{role.permissions.length}</span>
				</h2>

				{#if role.permissions.length === 0}
					<p class="empty-message">No permissions assigned</p>
				{:else if role.permissions.includes('*')}
					<div class="permissions-grid">
						<div class="permission-badge permission-all">
							<i class="i-ph-crown"></i>
							Full Access
						</div>
					</div>
				{:else}
					<div class="permission-categories">
						{#each permissionsByCategory as category (category.category)}
							<div class="permission-category">
								<h3 class="permission-category-title">{category.category}</h3>
								<div class="permission-category-items">
									{#each category.permissions as perm (perm.key)}
										{#if perm.hasPermission}
											<div class="permission-badge">
												<i class="i-ph-check-circle"></i>
												<span class="permission-badge-label">{perm.key}</span>
												<span class="permission-badge-desc">{perm.description}</span>
											</div>
										{/if}
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

	.permissions-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
		gap: 0.5rem;
	}

	.permission-categories {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.permission-category {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}

	.permission-category-title {
		background: var(--bg-subtle);
		padding: 0.75rem 1rem;
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		border-bottom: 1px solid var(--border);
	}

	.permission-category-items {
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.permission-badge {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.5rem 0.75rem;
		background: var(--bg-subtle);
		border-radius: var(--radius-md);
	}

	.permission-badge :global(i) {
		width: 16px;
		height: 16px;
		color: var(--success);
		align-self: flex-start;
	}

	.permission-badge-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.permission-badge-desc {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.permission-all {
		background: var(--primary-subtle);
		color: var(--primary);
		font-weight: 500;
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	.permission-all :global(i) {
		color: var(--primary);
	}

	.empty-message {
		color: var(--text-secondary);
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
</style>

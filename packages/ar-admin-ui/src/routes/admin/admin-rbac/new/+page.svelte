<script lang="ts">
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminAdminRolesAPI,
		type AdminRole,
		ADMIN_PERMISSION_DEFINITIONS,
		type CreateAdminRoleInput
	} from '$lib/api/admin-admin-roles';

	// Form state
	let name = $state('');
	let displayName = $state('');
	let description = $state('');
	let inheritsFrom = $state('');
	let selectedPermissions = new SvelteSet<string>();

	// Available roles for inheritance
	let availableRoles = $state<AdminRole[]>([]);
	let loadingRoles = $state(true);

	// Submit state
	let submitting = $state(false);
	let error = $state('');

	// Validation
	let nameError = $derived(
		name.length > 0 && !/^[a-z][a-z0-9_-]*$/.test(name)
			? 'Name must start with lowercase letter and contain only lowercase letters, numbers, underscores, and hyphens'
			: ''
	);

	let isValid = $derived(
		name.length > 0 && !nameError && (selectedPermissions.size > 0 || !!inheritsFrom)
	);

	// Load available roles for inheritance selection
	async function loadAvailableRoles() {
		loadingRoles = true;
		try {
			const response = await adminAdminRolesAPI.list();
			// Filter to only show roles that can be inherited from (system and builtin)
			availableRoles = response.items.filter(
				(r) => r.role_type === 'system' || r.role_type === 'builtin'
			);
		} catch (err) {
			console.error('Failed to load roles:', err);
		} finally {
			loadingRoles = false;
		}
	}

	// Initialize on mount
	$effect(() => {
		loadAvailableRoles();
	});

	function togglePermission(permissionKey: string) {
		if (selectedPermissions.has(permissionKey)) {
			selectedPermissions.delete(permissionKey);
		} else {
			selectedPermissions.add(permissionKey);
		}
	}

	function toggleCategory(categoryPermissions: { key: string }[]) {
		const categoryKeys = categoryPermissions.map((p) => p.key);
		const allSelected = categoryKeys.every((key) => selectedPermissions.has(key));

		if (allSelected) {
			// Deselect all in category
			categoryKeys.forEach((key) => selectedPermissions.delete(key));
		} else {
			// Select all in category
			categoryKeys.forEach((key) => selectedPermissions.add(key));
		}
	}

	function isCategoryFullySelected(categoryPermissions: { key: string }[]): boolean {
		return categoryPermissions.every((p) => selectedPermissions.has(p.key));
	}

	function isCategoryPartiallySelected(categoryPermissions: { key: string }[]): boolean {
		const hasAny = categoryPermissions.some((p) => selectedPermissions.has(p.key));
		const hasAll = categoryPermissions.every((p) => selectedPermissions.has(p.key));
		return hasAny && !hasAll;
	}

	async function handleSubmit() {
		if (!isValid) return;

		submitting = true;
		error = '';

		try {
			const data: CreateAdminRoleInput = {
				name,
				display_name: displayName || undefined,
				description: description || undefined,
				permissions: Array.from(selectedPermissions),
				hierarchy_level: inheritsFrom ? undefined : 0,
				inherits_from: inheritsFrom || null
			};

			const newRole = await adminAdminRolesAPI.create(data);
			goto(`/admin/admin-rbac/${newRole.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create role';
		} finally {
			submitting = false;
		}
	}

	function navigateBack() {
		goto('/admin/admin-rbac');
	}
</script>

<svelte:head>
	<title>Create Admin Role - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/admin-rbac" class="back-link">← Back to Admin Roles</a>

	<h1 class="page-title">Create Custom Admin Role</h1>
	<p class="modal-description">
		Create a new custom role with specific permissions for Admin Operators.
	</p>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
	>
		<!-- Basic Info Section -->
		<div class="panel">
			<h2 class="panel-title">Basic Information</h2>

			<div class="form-group">
				<label for="name" class="form-label">
					Role Name <span class="text-danger">*</span>
				</label>
				<input
					type="text"
					id="name"
					bind:value={name}
					placeholder="e.g., security_admin"
					class="form-input"
					class:form-input-error={nameError}
				/>
				{#if nameError}
					<span class="form-error">{nameError}</span>
				{/if}
				<span class="form-hint">
					Lowercase letters, numbers, underscores, and hyphens only. Must start with a letter.
				</span>
			</div>

			<div class="form-group">
				<label for="displayName" class="form-label">Display Name</label>
				<input
					type="text"
					id="displayName"
					bind:value={displayName}
					placeholder="e.g., Security Administrator"
					class="form-input"
				/>
				<span class="form-hint">Human-readable name shown in UI</span>
			</div>

			<div class="form-group">
				<label for="description" class="form-label">Description</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder="Describe what this role is for..."
					rows="3"
					class="form-input"
				></textarea>
			</div>

			<div class="form-group">
				<label for="inherits-from" class="form-label">Inherit From (Optional)</label>
				<select
					id="inherits-from"
					bind:value={inheritsFrom}
					disabled={loadingRoles}
					class="form-select"
				>
					<option value="">None - Start with no permissions</option>
					{#each availableRoles as role (role.id)}
						<option value={role.id}>{role.display_name || role.name}</option>
					{/each}
				</select>
				<span class="form-hint">
					Inherited permissions will be automatically included. Changes to the base role will be
					reflected in this role.
				</span>
			</div>
		</div>

		<!-- Permissions Section -->
		<div class="panel">
			<h2 class="panel-title">Permissions <span class="text-danger">*</span></h2>
			<p class="form-hint" style="margin-bottom: 16px;">
				Select the permissions this role should have. At least one permission is required.
			</p>

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
										checked={selectedPermissions.has(perm.key)}
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

			{#if selectedPermissions.size > 0}
				<div class="permission-selected-count">
					{selectedPermissions.size} permission(s) selected
				</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack} disabled={submitting}>
				Cancel
			</button>
			<button type="submit" class="btn btn-primary" disabled={!isValid || submitting}>
				{submitting ? 'Creating...' : 'Create Role'}
			</button>
		</div>
	</form>
</div>

<style>
	.back-link {
		display: inline-block;
		margin-bottom: 1rem;
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.875rem;
		transition: color var(--transition-fast);
	}

	.back-link:hover {
		color: var(--text-primary);
	}

	.panel {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.5rem;
		margin-bottom: 1.5rem;
	}

	.panel-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 1rem;
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-group:last-child {
		margin-bottom: 0;
	}

	.form-label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
		margin-bottom: 0.5rem;
	}

	.text-danger {
		color: var(--danger);
	}

	.form-input,
	.form-select,
	textarea.form-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: inherit;
		transition: border-color var(--transition-fast);
	}

	.form-input:focus,
	.form-select:focus,
	textarea.form-input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-subtle);
	}

	.form-input-error {
		border-color: var(--danger);
	}

	.form-input-error:focus {
		border-color: var(--danger);
		box-shadow: 0 0 0 3px var(--danger-subtle);
	}

	.form-error {
		display: block;
		font-size: 0.75rem;
		color: var(--danger);
		margin-top: 0.25rem;
	}

	.form-hint {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 0.25rem;
		display: block;
	}

	.permission-editor-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.permission-category-editor {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}

	.permission-category-header {
		background: var(--bg-subtle);
		padding: 0.75rem 1rem;
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
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	.permission-category-body {
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.permission-checkbox-item {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.permission-checkbox-item:hover {
		background: var(--bg-hover);
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

	.permission-selected-count {
		font-size: 0.875rem;
		color: var(--text-secondary);
		text-align: center;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding-top: 1.5rem;
	}

	.alert-error {
		background: var(--danger-subtle);
		color: var(--danger);
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		margin-bottom: 1rem;
	}
</style>

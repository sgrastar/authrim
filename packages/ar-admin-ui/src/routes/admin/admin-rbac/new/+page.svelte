<script lang="ts">
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminAdminRolesAPI,
		type AdminRole,
		ADMIN_PERMISSION_DEFINITIONS,
		type CreateAdminRoleInput
	} from '$lib/api/admin-admin-roles';
	import { LL } from '$i18n/i18n-svelte';
	import {
		formatAdminPermissionCategory,
		formatAdminPermissionCategoryDescription
	} from '$lib/admin/admin-admin-rbac-i18n';

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
			? $LL.admin_admin_rbac_name_validation()
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
			error = err instanceof Error ? err.message : $LL.admin_admin_rbac_load_failed();
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
			error = err instanceof Error ? err.message : $LL.admin_admin_rbac_create_failed();
		} finally {
			submitting = false;
		}
	}

	function navigateBack() {
		goto('/admin/admin-rbac');
	}
</script>

<svelte:head>
	<title>{$LL.admin_admin_rbac_create_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/admin-rbac" class="back-link">← {$LL.admin_admin_rbac_back_to_roles()}</a>

	<h1 class="page-title">{$LL.admin_admin_rbac_create_title()}</h1>
	<p class="modal-description">
		{$LL.admin_admin_rbac_create_description()}
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
			<h2 class="panel-title">{$LL.admin_admin_rbac_basic_information()}</h2>

			<div class="form-group">
				<label for="name" class="form-label">
					{$LL.admin_admin_rbac_role_name()}
					<span class="text-danger">{$LL.admin_admin_rbac_required()}</span>
				</label>
				<input
					type="text"
					id="name"
					bind:value={name}
					placeholder={$LL.admin_admin_rbac_name_placeholder()}
					class="form-input"
					class:form-input-error={nameError}
				/>
				{#if nameError}
					<span class="form-error">{nameError}</span>
				{/if}
				<span class="form-hint">
					{$LL.admin_admin_rbac_name_hint()}
				</span>
			</div>

			<div class="form-group">
				<label for="displayName" class="form-label">
					{$LL.admin_admin_rbac_display_name()}
				</label>
				<input
					type="text"
					id="displayName"
					bind:value={displayName}
					placeholder={$LL.admin_admin_rbac_display_name_placeholder()}
					class="form-input"
				/>
				<span class="form-hint">{$LL.admin_admin_rbac_display_name_hint()}</span>
			</div>

			<div class="form-group">
				<label for="description" class="form-label">
					{$LL.admin_admin_rbac_description_label()}
				</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder={$LL.admin_admin_rbac_create_description_placeholder()}
					rows="3"
					class="form-input"
				></textarea>
			</div>

			<div class="form-group">
				<label for="inherits-from" class="form-label">
					{$LL.admin_admin_rbac_inherit_from()}
				</label>
				<select
					id="inherits-from"
					bind:value={inheritsFrom}
					disabled={loadingRoles}
					class="form-select"
				>
					<option value="">{$LL.admin_admin_rbac_inherit_none()}</option>
					{#each availableRoles as role (role.id)}
						<option value={role.id}>{role.display_name || role.name}</option>
					{/each}
				</select>
				<span class="form-hint">
					{$LL.admin_admin_rbac_inherit_hint()}
				</span>
			</div>
		</div>

		<!-- Permissions Section -->
		<div class="panel">
			<h2 class="panel-title">
				{$LL.admin_admin_rbac_permissions()}
				<span class="text-danger">{$LL.admin_admin_rbac_required()}</span>
			</h2>
			<p class="form-hint" style="margin-bottom: 16px;">
				{$LL.admin_admin_rbac_permissions_hint()}
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
								<span class="permission-category-name">
									{formatAdminPermissionCategory(category.category, $LL)}
								</span>
								<span class="permission-category-description">
									{formatAdminPermissionCategoryDescription(category.category, $LL)}
								</span>
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
					{$LL.admin_admin_rbac_selected_count({ count: selectedPermissions.size })}
				</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack} disabled={submitting}>
				{$LL.admin_admin_rbac_cancel()}
			</button>
			<button type="submit" class="btn btn-primary" disabled={!isValid || submitting}>
				{submitting ? $LL.admin_admin_rbac_creating() : $LL.admin_admin_rbac_create_button()}
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

<script lang="ts">
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminRolesAPI,
		type Role,
		PERMISSION_DEFINITIONS,
		type CreateRoleRequest
	} from '$lib/api/admin-roles';

	// Form state
	let name = $state('');
	let description = $state('');
	let inheritsFrom = $state('');
	let selectedPermissions = new SvelteSet<string>();

	// Available roles for inheritance
	let availableRoles = $state<Role[]>([]);
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

	let isValid = $derived(name.length > 0 && !nameError && selectedPermissions.size > 0);

	// Load available roles for inheritance selection
	async function loadAvailableRoles() {
		loadingRoles = true;
		try {
			const response = await adminRolesAPI.list();
			// Filter to only show roles that can be inherited from (system and builtin)
			availableRoles = response.roles.filter(
				(r) =>
					r.is_system || ['admin', 'viewer', 'support', 'auditor'].includes(r.name.toLowerCase())
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

	function togglePermission(permissionId: string) {
		if (selectedPermissions.has(permissionId)) {
			selectedPermissions.delete(permissionId);
		} else {
			selectedPermissions.add(permissionId);
		}
	}

	function toggleCategory(categoryPermissions: { id: string }[]) {
		const categoryIds = categoryPermissions.map((p) => p.id);
		const allSelected = categoryIds.every((id) => selectedPermissions.has(id));

		if (allSelected) {
			// Deselect all in category
			categoryIds.forEach((id) => selectedPermissions.delete(id));
		} else {
			// Select all in category
			categoryIds.forEach((id) => selectedPermissions.add(id));
		}
	}

	function isCategoryFullySelected(categoryPermissions: { id: string }[]): boolean {
		return categoryPermissions.every((p) => selectedPermissions.has(p.id));
	}

	function isCategoryPartiallySelected(categoryPermissions: { id: string }[]): boolean {
		const hasAny = categoryPermissions.some((p) => selectedPermissions.has(p.id));
		const hasAll = categoryPermissions.every((p) => selectedPermissions.has(p.id));
		return hasAny && !hasAll;
	}

	async function handleSubmit() {
		if (!isValid) return;

		submitting = true;
		error = '';

		try {
			const data: CreateRoleRequest = {
				name,
				description: description || undefined,
				permissions: Array.from(selectedPermissions),
				inherits_from: inheritsFrom || undefined
			};

			await adminRolesAPI.create(data);
			goto('/admin/roles');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create role';
		} finally {
			submitting = false;
		}
	}

	function navigateBack() {
		goto('/admin/roles');
	}
</script>

<div class="create-role-page">
	<div class="page-header">
		<button class="back-btn" onclick={navigateBack}>← Back to Roles</button>
		<h1>Create Custom Role</h1>
		<p class="description">Create a new custom role with specific permissions.</p>
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
		</div>
	{/if}

	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
	>
		<!-- Basic Info Section -->
		<div class="form-section">
			<h2>Basic Information</h2>

			<div class="form-group">
				<label for="name">
					Role Name <span class="required">*</span>
				</label>
				<input
					type="text"
					id="name"
					bind:value={name}
					placeholder="e.g., billing_manager"
					class:error={nameError}
				/>
				{#if nameError}
					<span class="field-error">{nameError}</span>
				{/if}
				<span class="field-hint">
					Lowercase letters, numbers, underscores, and hyphens only. Must start with a letter.
				</span>
			</div>

			<div class="form-group">
				<label for="description">Description</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder="Describe what this role is for..."
					rows="3"
				></textarea>
			</div>

			<div class="form-group">
				<label for="inherits-from">Inherit From (Optional)</label>
				<select id="inherits-from" bind:value={inheritsFrom} disabled={loadingRoles}>
					<option value="">None - Start with no permissions</option>
					{#each availableRoles as role (role.id)}
						<option value={role.id}>{role.display_name || role.name}</option>
					{/each}
				</select>
				<span class="field-hint">
					Inherited permissions will be automatically included. Changes to the base role will be
					reflected in this role.
				</span>
			</div>
		</div>

		<!-- Permissions Section -->
		<div class="form-section">
			<h2>Permissions <span class="required">*</span></h2>
			<p class="section-description">
				Select the permissions this role should have. At least one permission is required.
			</p>

			<div class="permissions-grid">
				{#each PERMISSION_DEFINITIONS as category (category.category)}
					<div class="permission-category">
						<div class="category-header">
							<label class="category-checkbox">
								<input
									type="checkbox"
									checked={isCategoryFullySelected(category.permissions)}
									indeterminate={isCategoryPartiallySelected(category.permissions)}
									onchange={() => toggleCategory(category.permissions)}
								/>
								<span class="category-name">{category.categoryLabel}</span>
							</label>
						</div>
						<div class="permission-list">
							{#each category.permissions as perm (perm.id)}
								<label class="permission-checkbox">
									<input
										type="checkbox"
										checked={selectedPermissions.has(perm.id)}
										onchange={() => togglePermission(perm.id)}
									/>
									<span class="permission-info">
										<span class="permission-label">{perm.label}</span>
										<span class="permission-desc">{perm.description}</span>
									</span>
								</label>
							{/each}
						</div>
					</div>
				{/each}
			</div>

			{#if selectedPermissions.size > 0}
				<div class="selected-count">
					{selectedPermissions.size} permission(s) selected
				</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="form-actions">
			<button type="button" class="btn-secondary" onclick={navigateBack} disabled={submitting}>
				Cancel
			</button>
			<button type="submit" class="btn-primary" disabled={!isValid || submitting}>
				{submitting ? 'Creating...' : 'Create Role'}
			</button>
		</div>
	</form>
</div>

<style>
	.create-role-page {
		padding: 24px;
		max-width: 900px;
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
		margin-bottom: 16px;
	}

	.back-btn:hover {
		text-decoration: underline;
	}

	.page-header h1 {
		margin: 0 0 8px 0;
		font-size: 24px;
		font-weight: 600;
	}

	.description {
		margin: 0;
		color: #6b7280;
		font-size: 14px;
	}

	.error-banner {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 16px;
		border-radius: 6px;
		margin-bottom: 24px;
	}

	.form-section {
		background-color: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 24px;
		margin-bottom: 24px;
	}

	.form-section h2 {
		margin: 0 0 8px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.section-description {
		margin: 0 0 20px 0;
		color: #6b7280;
		font-size: 14px;
	}

	.form-group {
		margin-bottom: 20px;
	}

	.form-group:last-child {
		margin-bottom: 0;
	}

	.form-group label {
		display: block;
		font-size: 14px;
		font-weight: 500;
		color: #374151;
		margin-bottom: 6px;
	}

	.required {
		color: #dc2626;
	}

	.form-group input[type='text'],
	.form-group textarea,
	.form-group select {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
		transition: border-color 0.2s;
	}

	.form-group input:focus,
	.form-group textarea:focus,
	.form-group select:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
	}

	.form-group input.error {
		border-color: #dc2626;
	}

	.field-error {
		display: block;
		color: #dc2626;
		font-size: 12px;
		margin-top: 4px;
	}

	.field-hint {
		display: block;
		color: #6b7280;
		font-size: 12px;
		margin-top: 4px;
	}

	.permissions-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 16px;
	}

	.permission-category {
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		overflow: hidden;
	}

	.category-header {
		background-color: #f9fafb;
		padding: 12px 16px;
		border-bottom: 1px solid #e5e7eb;
	}

	.category-checkbox {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}

	.category-checkbox input {
		width: 16px;
		height: 16px;
		cursor: pointer;
	}

	.category-name {
		font-weight: 600;
		font-size: 14px;
		color: #374151;
	}

	.permission-list {
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.permission-checkbox {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		cursor: pointer;
	}

	.permission-checkbox input {
		width: 16px;
		height: 16px;
		margin-top: 2px;
		cursor: pointer;
		flex-shrink: 0;
	}

	.permission-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.permission-label {
		font-size: 13px;
		color: #111827;
	}

	.permission-desc {
		font-size: 11px;
		color: #6b7280;
	}

	.selected-count {
		margin-top: 16px;
		padding: 10px 16px;
		background-color: #eff6ff;
		border-radius: 6px;
		color: #1e40af;
		font-size: 14px;
		font-weight: 500;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
	}

	.btn-secondary {
		padding: 10px 20px;
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.btn-secondary:hover {
		background-color: #f3f4f6;
	}

	.btn-primary {
		padding: 10px 20px;
		background-color: #2563eb;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.btn-primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}

	.btn-primary:disabled,
	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

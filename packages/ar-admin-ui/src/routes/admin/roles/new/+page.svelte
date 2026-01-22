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

<svelte:head>
	<title>Create Role - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/roles" class="back-link">← Back to Roles</a>

	<h1 class="page-title">Create Custom Role</h1>
	<p class="modal-description">Create a new custom role with specific permissions.</p>

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
					placeholder="e.g., billing_manager"
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
				{#each PERMISSION_DEFINITIONS as category (category.category)}
					<div class="permission-category-editor">
						<div class="permission-category-header">
							<label class="form-checkbox-label">
								<input
									type="checkbox"
									checked={isCategoryFullySelected(category.permissions)}
									indeterminate={isCategoryPartiallySelected(category.permissions)}
									onchange={() => toggleCategory(category.permissions)}
								/>
								<span class="permission-category-name">{category.categoryLabel}</span>
							</label>
						</div>
						<div class="permission-category-body">
							{#each category.permissions as perm (perm.id)}
								<label class="permission-checkbox-item">
									<input
										type="checkbox"
										checked={selectedPermissions.has(perm.id)}
										onchange={() => togglePermission(perm.id)}
									/>
									<span class="permission-checkbox-info">
										<span class="permission-checkbox-label">{perm.label}</span>
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

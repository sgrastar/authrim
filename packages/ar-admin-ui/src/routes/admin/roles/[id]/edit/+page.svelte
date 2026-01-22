<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminRolesAPI,
		type RoleDetail,
		type UpdateRoleRequest,
		PERMISSION_DEFINITIONS,
		canEditRole
	} from '$lib/api/admin-roles';

	// Role data
	let role: RoleDetail | null = $state(null);
	let loading = $state(true);
	let loadError = $state('');

	// Form state
	let description = $state('');
	let selectedPermissions = new SvelteSet<string>();

	// Submit state
	let submitting = $state(false);
	let error = $state('');

	// Check if there are unsaved changes
	let hasChanges = $derived.by(() => {
		if (!role) return false;

		// Check description change
		if (description !== (role.description || '')) return true;

		// Check permissions change
		const originalPerms = new Set(role.effectivePermissions || []);
		if (selectedPermissions.size !== originalPerms.size) return true;

		for (const perm of selectedPermissions) {
			if (!originalPerms.has(perm)) return true;
		}

		return false;
	});

	let isValid = $derived(selectedPermissions.size > 0);

	async function loadRole() {
		const roleId = $page.params.id;
		if (!roleId) {
			loadError = 'Role ID is required';
			loading = false;
			return;
		}

		loading = true;
		loadError = '';

		try {
			const response = await adminRolesAPI.get(roleId);
			role = response.role;

			// Check if role can be edited
			if (!canEditRole(role)) {
				loadError = 'This role cannot be edited. Only custom roles can be modified.';
				loading = false;
				return;
			}

			// Initialize form with current values
			description = role.description || '';
			selectedPermissions.clear();
			(role.effectivePermissions || []).forEach((p) => selectedPermissions.add(p));
		} catch (err) {
			console.error('Failed to load role:', err);
			loadError = err instanceof Error ? err.message : 'Failed to load role';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadRole();
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
			categoryIds.forEach((id) => selectedPermissions.delete(id));
		} else {
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
		if (!role || !isValid) return;

		submitting = true;
		error = '';

		try {
			const data: UpdateRoleRequest = {
				description: description || undefined,
				permissions: Array.from(selectedPermissions)
			};

			await adminRolesAPI.update(role.id, data);
			goto(`/admin/roles/${role.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update role';
		} finally {
			submitting = false;
		}
	}

	function navigateBack() {
		if (role) {
			goto(`/admin/roles/${role.id}`);
		} else {
			goto('/admin/roles');
		}
	}
</script>

<svelte:head>
	<title>Edit {role?.display_name || role?.name || 'Role'} - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href={role ? `/admin/roles/${role.id}` : '/admin/roles'} class="back-link">← Back to Role</a>

	{#if loading}
		<div class="loading-state">Loading role...</div>
	{:else if loadError}
		<div class="alert alert-error">
			<span>{loadError}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadRole}>Retry</button>
		</div>
	{:else if role}
		<h1 class="page-title">Edit Role: {role.display_name || role.name}</h1>
		<p class="modal-description">Modify the description and permissions for this custom role.</p>

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
					<label for="name" class="form-label">Role Name</label>
					<input
						type="text"
						id="name"
						value={role.name}
						disabled
						class="form-input form-input-disabled"
					/>
					<span class="form-hint">Role names cannot be changed after creation.</span>
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
				<button
					type="button"
					class="btn btn-secondary"
					onclick={navigateBack}
					disabled={submitting}
				>
					Cancel
				</button>
				<button
					type="submit"
					class="btn btn-primary"
					disabled={!isValid || !hasChanges || submitting}
				>
					{submitting ? 'Saving...' : 'Save Changes'}
				</button>
			</div>
		</form>
	{/if}
</div>

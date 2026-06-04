<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { SvelteSet } from 'svelte/reactivity';
	import { LL } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminRolesAPI,
		type RoleDetail,
		type UpdateRoleRequest,
		PERMISSION_DEFINITIONS,
		canEditRole
	} from '$lib/api/admin-roles';
	import {
		formatPermissionCategory,
		formatPermissionDescription,
		formatPermissionLabel
	} from '$lib/admin/roles-i18n';

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
	let loadedTenantId = $state('');

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
			loadError = $LL.admin_roles_role_id_required();
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
				loadError = $LL.admin_roles_edit_not_allowed();
				loading = false;
				return;
			}

			// Initialize form with current values
			description = role.description || '';
			selectedPermissions.clear();
			(role.effectivePermissions || []).forEach((p) => selectedPermissions.add(p));
		} catch (err) {
			loadError = err instanceof Error ? err.message : $LL.admin_roles_detail_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		role = null;
		error = '';
		loadError = '';
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
			error = err instanceof Error ? err.message : $LL.admin_roles_update_failed();
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
	<title>
		{$LL.admin_roles_edit_head_title({
			role: role?.display_name || role?.name || $LL.admin_roles_tab_roles()
		})}
	</title>
</svelte:head>

<div class="admin-page">
	<a href={role ? `/admin/roles/${role.id}` : '/admin/roles'} class="back-link">
		← {$LL.admin_roles_back_to_role()}
	</a>

	{#if loading}
		<div class="loading-state">{$LL.admin_roles_edit_loading()}</div>
	{:else if loadError}
		<div class="alert alert-error">
			<span>{loadError}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadRole}>{$LL.admin_roles_retry()}</button>
		</div>
	{:else if role}
		<h1 class="page-title">
			{$LL.admin_roles_edit_title({ role: role.display_name || role.name })}
		</h1>
		<p class="modal-description">{$LL.admin_roles_edit_description()}</p>

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
				<h2 class="panel-title">{$LL.admin_roles_basic_information()}</h2>

				<div class="form-group">
					<label for="name" class="form-label">{$LL.admin_roles_role_name()}</label>
					<input
						type="text"
						id="name"
						value={role.name}
						disabled
						class="form-input form-input-disabled"
					/>
					<span class="form-hint">{$LL.admin_roles_name_immutable()}</span>
				</div>

				<div class="form-group">
					<label for="description" class="form-label">{$LL.admin_roles_description_label()}</label>
					<textarea
						id="description"
						bind:value={description}
						placeholder={$LL.admin_roles_description_placeholder()}
						rows="3"
						class="form-input"
					></textarea>
				</div>
			</div>

			<!-- Permissions Section -->
			<div class="panel">
				<h2 class="panel-title">
					{$LL.admin_roles_permissions()}
					<span class="text-danger">{$LL.admin_roles_required()}</span>
				</h2>
				<p class="form-hint" style="margin-bottom: 16px;">
					{$LL.admin_roles_permissions_hint()}
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
									<span class="permission-category-name">
										{formatPermissionCategory(category.category, $LL)}
									</span>
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
											<span class="permission-checkbox-label">
												{formatPermissionLabel(perm.id, $LL)}
											</span>
											<span class="permission-checkbox-desc">
												{formatPermissionDescription(perm.id, $LL)}
											</span>
										</span>
									</label>
								{/each}
							</div>
						</div>
					{/each}
				</div>

				{#if selectedPermissions.size > 0}
					<div class="permission-selected-count">
						{$LL.admin_roles_selected_count({ count: selectedPermissions.size })}
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
					{$LL.admin_roles_cancel()}
				</button>
				<button
					type="submit"
					class="btn btn-primary"
					disabled={!isValid || !hasChanges || submitting}
				>
					{submitting ? $LL.admin_roles_saving() : $LL.admin_roles_save_changes()}
				</button>
			</div>
		</form>
	{/if}
</div>

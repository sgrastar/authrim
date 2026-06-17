<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { LL } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminRolesAPI,
		type Role,
		PERMISSION_DEFINITIONS,
		type CreateRoleRequest
	} from '$lib/api/admin-roles';
	import {
		formatPermissionCategory,
		formatPermissionDescription,
		formatPermissionLabel
	} from '$lib/admin/roles-i18n';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';

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
	let loadedTenantId = $state('');

	// Validation
	let nameError = $derived(
		name.length > 0 && !/^[a-z][a-z0-9_-]*$/.test(name) ? $LL.admin_roles_name_validation() : ''
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
			error = err instanceof Error ? err.message : $LL.admin_roles_load_failed();
		} finally {
			loadingRoles = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		inheritsFrom = '';
		error = '';
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
			error = err instanceof Error ? err.message : $LL.admin_roles_create_failed();
		} finally {
			submitting = false;
		}
	}

	function navigateBack() {
		goto('/admin/roles');
	}
</script>

<svelte:head>
	<title>{$LL.admin_roles_create_head_title()}</title>
</svelte:head>

<AdminPageShell width="narrow">
	<AdminPageHeader
		title={$LL.admin_roles_create_title()}
		description={$LL.admin_roles_create_description()}
	>
		{#snippet actions()}
			<button type="button" class="btn btn-secondary" onclick={navigateBack}>
				<i class="i-ph-arrow-left"></i>
				{$LL.admin_roles_back_to_roles()}
			</button>
		{/snippet}
	</AdminPageHeader>

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
		<AdminSection title={$LL.admin_roles_basic_information()}>
			<div class="form-group">
				<label for="name" class="form-label">
					{$LL.admin_roles_role_name()}
					<span class="text-danger">{$LL.admin_roles_required()}</span>
				</label>
				<input
					type="text"
					id="name"
					bind:value={name}
					placeholder={$LL.admin_roles_name_placeholder()}
					class="form-input"
					class:form-input-error={nameError}
				/>
				{#if nameError}
					<span class="form-error">{nameError}</span>
				{/if}
				<span class="form-hint">{$LL.admin_roles_name_hint()}</span>
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

			<div class="form-group">
				<label for="inherits-from" class="form-label">{$LL.admin_roles_inherit_from()}</label>
				<select
					id="inherits-from"
					bind:value={inheritsFrom}
					disabled={loadingRoles}
					class="form-select"
				>
					<option value="">{$LL.admin_roles_inherit_none()}</option>
					{#each availableRoles as role (role.id)}
						<option value={role.id}>{role.display_name || role.name}</option>
					{/each}
				</select>
				<span class="form-hint">{$LL.admin_roles_inherit_hint()}</span>
			</div>
		</AdminSection>

		<!-- Permissions Section -->
		<AdminSection title={$LL.admin_roles_permissions()}>
			<p class="form-hint form-hint--stacked">
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
		</AdminSection>

		<!-- Actions -->
		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack} disabled={submitting}>
				{$LL.admin_roles_cancel()}
			</button>
			<button type="submit" class="btn btn-primary" disabled={!isValid || submitting}>
				{submitting ? $LL.admin_roles_creating() : $LL.admin_roles_create_role()}
			</button>
		</div>
	</form>
</AdminPageShell>

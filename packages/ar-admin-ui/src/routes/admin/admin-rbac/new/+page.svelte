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
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';

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

{#snippet pageActions()}
	<button type="button" class="btn btn-secondary" onclick={navigateBack} disabled={submitting}>
		{$LL.admin_admin_rbac_cancel()}
	</button>
	<button
		type="submit"
		class="btn btn-primary"
		form="admin-rbac-create-form"
		disabled={!isValid || submitting}
	>
		{submitting ? $LL.admin_admin_rbac_creating() : $LL.admin_admin_rbac_create_button()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_rbac_create_title()}
		description={$LL.admin_admin_rbac_create_description()}
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<form
		id="admin-rbac-create-form"
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
	>
		<AdminSection title={$LL.admin_admin_rbac_basic_information()}>
			<div class="admin-form-grid">
				<div class="form-field admin-field">
					<label for="name" class="admin-field__label">
						{$LL.admin_admin_rbac_role_name()}
						<span class="text-danger">{$LL.admin_admin_rbac_required()}</span>
					</label>
					<input
						type="text"
						id="name"
						bind:value={name}
						placeholder={$LL.admin_admin_rbac_name_placeholder()}
						class="admin-input"
						class:admin-input-error={nameError}
					/>
					{#if nameError}
						<span class="form-error">{nameError}</span>
					{/if}
					<span class="form-hint">
						{$LL.admin_admin_rbac_name_hint()}
					</span>
				</div>

				<div class="form-field admin-field">
					<label for="displayName" class="admin-field__label">
						{$LL.admin_admin_rbac_display_name()}
					</label>
					<input
						type="text"
						id="displayName"
						bind:value={displayName}
						placeholder={$LL.admin_admin_rbac_display_name_placeholder()}
						class="admin-input"
					/>
					<span class="form-hint">{$LL.admin_admin_rbac_display_name_hint()}</span>
				</div>

				<div class="form-field form-field--full admin-field">
					<label for="description" class="admin-field__label">
						{$LL.admin_admin_rbac_description_label()}
					</label>
					<textarea
						id="description"
						bind:value={description}
						placeholder={$LL.admin_admin_rbac_create_description_placeholder()}
						rows="3"
						class="admin-input"
					></textarea>
				</div>

				<div class="form-field form-field--full admin-field">
					<label for="inherits-from" class="admin-field__label">
						{$LL.admin_admin_rbac_inherit_from()}
					</label>
					<select
						id="inherits-from"
						bind:value={inheritsFrom}
						disabled={loadingRoles}
						class="admin-input"
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
		</AdminSection>

		<AdminSection title={$LL.admin_admin_rbac_permissions()}>
			<p class="form-hint permissions-hint">
				{$LL.admin_admin_rbac_permissions_hint()}
				<span class="text-danger">{$LL.admin_admin_rbac_required()}</span>
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
		</AdminSection>

		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack} disabled={submitting}>
				{$LL.admin_admin_rbac_cancel()}
			</button>
			<button type="submit" class="btn btn-primary" disabled={!isValid || submitting}>
				{submitting ? $LL.admin_admin_rbac_creating() : $LL.admin_admin_rbac_create_button()}
			</button>
		</div>
	</form>
</AdminPageShell>

<style>
	.admin-form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}

	.form-field {
		min-width: 0;
	}

	.form-field--full {
		grid-column: 1 / -1;
	}

	.form-field :global(.admin-field__label) {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		margin-bottom: 0.5rem;
	}

	.text-danger {
		color: var(--color-danger);
	}

	.form-field :global(.admin-input) {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font-size: 0.875rem;
		font-family: inherit;
		transition:
			border-color 0.16s ease,
			box-shadow 0.16s ease;
	}

	.form-field :global(.admin-input:focus) {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.form-field :global(.admin-input-error) {
		border-color: var(--color-danger);
	}

	.form-field :global(.admin-input-error:focus) {
		border-color: var(--color-danger);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 14%, transparent);
	}

	.form-error {
		display: block;
		font-size: 0.75rem;
		color: var(--color-danger);
		margin-top: 0.25rem;
	}

	.form-hint {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		margin-top: 0.25rem;
		display: block;
	}

	.permissions-hint {
		margin-bottom: 16px;
	}

	.permission-editor-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.permission-category-editor {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--color-surface);
	}

	.permission-category-header {
		background: var(--color-surface-muted);
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--color-border);
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
		color: var(--color-text);
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
		transition: background 0.16s ease;
	}

	.permission-checkbox-item:hover {
		background: var(--color-surface-muted);
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
		color: var(--color-text);
	}

	.permission-checkbox-desc {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.permission-selected-count {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		text-align: center;
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border);
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding-top: 1.5rem;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
		color: var(--color-danger);
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		margin-bottom: 1rem;
	}

	@media (max-width: 720px) {
		.admin-form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

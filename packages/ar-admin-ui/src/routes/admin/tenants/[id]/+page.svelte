<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { adminTenantsAPI, type Tenant } from '$lib/api/admin-tenants';
	import {
		adminSettingsAPI,
		scopedSettingsAPI,
		type CategorySettings,
		type CategoryMetaFull,
		type UIPatch,
		convertPatchesToAPIRequest,
		isInternalSetting,
		isPageManagedSetting,
		SettingsConflictError
	} from '$lib/api/admin-settings';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { ToggleSwitch } from '$lib/components';

	// ==========================================================================
	// State
	// ==========================================================================

	const tenantId = $derived($page.params.id ?? '');

	let tenant = $state<Tenant | null>(null);
	let loading = $state(true);
	let error = $state('');

	// Edit mode
	let isEditing = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let editName = $state('');
	let editTenantCode = $state('');
	let editDescription = $state('');
	let editIsActive = $state(true);

	// Delete confirmation
	let showDeleteConfirm = $state(false);
	let deleteConfirmInput = $state('');
	let deleting = $state(false);
	let deleteError = $state('');

	// Set default
	let settingDefault = $state(false);

	// Tenant settings (login-entry category)
	let settingsMeta = $state<CategoryMetaFull | null>(null);
	let settings = $state<CategorySettings | null>(null);
	let settingsLoading = $state(false);
	let settingsSaving = $state(false);
	let settingsError = $state('');
	let settingsSuccess = $state('');
	let pendingPatches = $state<UIPatch[]>([]);

	const singleTenantMode = $derived(tenantStore.singleTenantMode);
	const hasSettingsChanges = $derived(pendingPatches.length > 0);

	// ==========================================================================
	// Validation
	// ==========================================================================

	const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

	function validateTenantCode(value: string): string {
		if (!value) return 'Tenant code is required';
		if (value.length > 63) return 'Must be 63 characters or fewer';
		if (!TENANT_ID_REGEX.test(value))
			return 'Lowercase letters, numbers, hyphens only. Must start and end with alphanumeric.';
		return '';
	}

	// ==========================================================================
	// Load
	// ==========================================================================

	async function loadTenant() {
		loading = true;
		error = '';
		try {
			tenant = await adminTenantsAPI.get(tenantId);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load tenant';
		} finally {
			loading = false;
		}
	}

	async function loadSettings() {
		settingsLoading = true;
		settingsError = '';
		try {
			const [meta, vals] = await Promise.all([
				adminSettingsAPI.getMeta('login-entry'),
				scopedSettingsAPI.getSettingsForScope('login-entry', {
					level: 'tenant',
					tenantId,
					clientId: undefined
				})
			]);
			settingsMeta = meta;
			settings = vals;
		} catch (err) {
			settingsError = err instanceof Error ? err.message : 'Failed to load settings';
		} finally {
			settingsLoading = false;
		}
	}

	onMount(async () => {
		await loadTenant();
		await loadSettings();
	});

	// ==========================================================================
	// Edit
	// ==========================================================================

	function startEdit() {
		if (!tenant) return;
		editName = tenant.name;
		editTenantCode = tenant.tenant_code;
		editDescription = tenant.description ?? '';
		editIsActive = tenant.is_active;
		saveError = '';
		isEditing = true;
	}

	function cancelEdit() {
		isEditing = false;
		saveError = '';
	}

	async function handleSave() {
		if (!tenant) return;
		const codeError = validateTenantCode(editTenantCode);
		if (codeError) {
			saveError = codeError;
			return;
		}
		if (!editName.trim()) {
			saveError = 'Name is required';
			return;
		}
		if (singleTenantMode && editIsActive !== tenant.is_active) {
			saveError = 'The initial tenant must remain active in single-tenant mode.';
			return;
		}

		saving = true;
		saveError = '';
		try {
			const updated = await adminTenantsAPI.update(tenant.id, {
				name: editName.trim(),
				tenant_code: editTenantCode.trim(),
				description: editDescription.trim() || null,
				is_active: editIsActive
			});
			tenantStore.update(updated);
			tenant = updated;
			isEditing = false;
		} catch (err) {
			saveError = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			saving = false;
		}
	}

	// ==========================================================================
	// Delete
	// ==========================================================================

	function openDeleteConfirm() {
		deleteConfirmInput = '';
		deleteError = '';
		showDeleteConfirm = true;
	}

	function cancelDelete() {
		showDeleteConfirm = false;
	}

	async function handleDelete() {
		if (!tenant) return;
		if (deleteConfirmInput !== tenant.id) {
			deleteError = 'Tenant ID does not match';
			return;
		}
		deleting = true;
		deleteError = '';
		try {
			await adminTenantsAPI.delete(tenant.id);
			tenantStore.update({ ...tenant, is_active: false });
			goto('/admin/tenants');
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Failed to delete tenant';
		} finally {
			deleting = false;
		}
	}

	// ==========================================================================
	// Set Default
	// ==========================================================================

	async function handleSetDefault() {
		if (!tenant || tenant.is_default || settingDefault) return;
		settingDefault = true;
		try {
			await adminTenantsAPI.setDefault(tenant.id);
			tenantStore.setDefault(tenant.id);
			tenant = { ...tenant, is_default: true };
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to set default';
		} finally {
			settingDefault = false;
		}
	}

	// ==========================================================================
	// Settings
	// ==========================================================================

	function getSettingValue(key: string): unknown {
		const patch = pendingPatches.find((p) => p.key === key);
		if (patch) {
			if (patch.op === 'set') return patch.value;
			if (patch.op === 'disable') return false;
		}
		return settings?.values[key];
	}

	function isLockedByEnv(key: string): boolean {
		return settings?.sources[key] === 'env';
	}

	function handleSettingChange(key: string, value: unknown) {
		pendingPatches = pendingPatches.filter((p) => p.key !== key);
		const originalValue = settings?.values[key];
		if (value !== originalValue) {
			pendingPatches = [...pendingPatches, { op: 'set', key, value }];
		}
	}

	function discardSettingsChanges() {
		pendingPatches = [];
	}

	async function saveSettings() {
		if (!settings || pendingPatches.length === 0) return;
		settingsSaving = true;
		settingsError = '';
		settingsSuccess = '';
		try {
			const patchData = convertPatchesToAPIRequest(pendingPatches);
			await scopedSettingsAPI.updateSettingsForScope(
				'login-entry',
				{ level: 'tenant', tenantId, clientId: undefined },
				{
					ifMatch: settings.version,
					...patchData
				}
			);
			pendingPatches = [];
			settingsSuccess = 'Settings saved';
			await loadSettings();
			setTimeout(() => {
				settingsSuccess = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				settingsError = 'Settings were modified by another user. Please reload.';
			} else {
				settingsError = err instanceof Error ? err.message : 'Failed to save settings';
			}
		} finally {
			settingsSaving = false;
		}
	}
</script>

<svelte:head>
	<title>{tenant?.name ?? tenantId} — Tenants — Admin Dashboard</title>
</svelte:head>

<div class="page">
	<!-- Back + header -->
	<div class="page-nav">
		<a href="/admin/tenants" class="back-link">
			<i class="i-ph-arrow-left"></i>
			Back to Tenants
		</a>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			Loading tenant...
		</div>
	{:else if error && !tenant}
		<div class="alert alert-error">
			<i class="i-ph-warning-circle"></i>
			{error}
		</div>
	{:else if tenant}
		<!-- Page Header -->
		<div class="page-header">
			<div class="page-title-row">
				<div>
					<h1 class="page-title">{tenant.name}</h1>
					<p class="tenant-id-badge"><i class="i-ph-identification-badge"></i>{tenant.id}</p>
				</div>
				<div class="header-actions">
					{#if !tenant.is_default}
						<button
							class="btn btn-secondary"
							onclick={handleSetDefault}
							disabled={!!settingDefault}
							title="Set as default tenant"
						>
							{#if settingDefault}
								<i class="i-ph-circle-notch animate-spin"></i>
							{:else}
								<i class="i-ph-star"></i>
							{/if}
							Set as Default
						</button>
					{:else}
						<span class="default-badge">
							<i class="i-ph-star-fill"></i>
							Default Tenant
						</span>
					{/if}
					{#if !isEditing}
						<button class="btn btn-primary" onclick={startEdit}>
							<i class="i-ph-pencil"></i>
							Edit
						</button>
					{/if}
				</div>
			</div>

			<!-- Status badge -->
			<div class="status-row">
				{#if tenant.is_active}
					<span class="badge badge-active">Active</span>
				{:else}
					<span class="badge badge-inactive">Inactive</span>
				{/if}
				{#if tenant.description}
					<p class="description">{tenant.description}</p>
				{/if}
			</div>
		</div>

		{#if error}
			<div class="alert alert-error">
				<i class="i-ph-warning-circle"></i>
				{error}
			</div>
		{/if}

		<!-- Info Card (view mode) or Edit Form -->
		{#if isEditing}
			<section class="card">
				<h2 class="card-title">Edit Tenant</h2>
				{#if saveError}
					<div class="alert alert-error">{saveError}</div>
				{/if}
				<div class="form-grid">
					<div class="form-group">
						<label for="edit-name" class="form-label">Name <span class="required">*</span></label>
						<input
							id="edit-name"
							type="text"
							class="form-input"
							bind:value={editName}
							maxlength="200"
						/>
					</div>
					<div class="form-group">
						<label for="edit-code" class="form-label"
							>Tenant Code <span class="required">*</span></label
						>
						<input
							id="edit-code"
							type="text"
							class="form-input"
							bind:value={editTenantCode}
							placeholder="Discovery code"
							maxlength="63"
						/>
						<p class="field-hint">Used for discovery. Lowercase letters, numbers, hyphens.</p>
					</div>
					<div class="form-group form-group-full">
						<label for="edit-description" class="form-label">Description</label>
						<textarea
							id="edit-description"
							class="form-input"
							bind:value={editDescription}
							rows="3"
							maxlength="500"
						></textarea>
					</div>
					<div class="form-group">
						<label
							class="form-label toggle-label"
							class:disabled={singleTenantMode || tenant.is_default}
						>
							<span>Active</span>
							<div
								class="toggle-switch"
								class:checked={editIsActive}
								class:disabled={singleTenantMode || tenant.is_default}
							>
								<input
									type="checkbox"
									bind:checked={editIsActive}
									class="toggle-input"
									id="edit-active"
									disabled={singleTenantMode || tenant.is_default}
								/>
								<label for="edit-active" class="toggle-slider"></label>
							</div>
						</label>
						{#if singleTenantMode}
							<p class="field-hint">Cannot be changed in single-tenant mode.</p>
						{:else if tenant.is_default}
							<p class="field-hint">The default tenant must remain active.</p>
						{/if}
					</div>
				</div>
				<div class="form-actions">
					<button class="btn btn-secondary" onclick={cancelEdit} disabled={saving}>Cancel</button>
					<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
						{#if saving}<i class="i-ph-circle-notch animate-spin"></i> Saving...{:else}Save Changes{/if}
					</button>
				</div>
			</section>
		{:else}
			<section class="card">
				<h2 class="card-title">Tenant Details</h2>
				<dl class="detail-grid">
					<div class="detail-row">
						<dt>Tenant ID</dt>
						<dd class="mono">{tenant.id}</dd>
					</div>
					<div class="detail-row">
						<dt>Tenant Code</dt>
						<dd class="mono">{tenant.tenant_code}</dd>
					</div>
					<div class="detail-row">
						<dt>Name</dt>
						<dd>{tenant.name}</dd>
					</div>
					<div class="detail-row">
						<dt>Description</dt>
						<dd>{tenant.description ?? '—'}</dd>
					</div>
					<div class="detail-row">
						<dt>Status</dt>
						<dd>
							{#if tenant.is_active}
								<span class="badge badge-active">Active</span>
							{:else}
								<span class="badge badge-inactive">Inactive</span>
							{/if}
						</dd>
					</div>
					<div class="detail-row">
						<dt>Default</dt>
						<dd>
							{#if tenant.is_default}
								<span class="badge badge-default"><i class="i-ph-star-fill"></i>Yes</span>
							{:else}
								<span class="text-muted">No</span>
							{/if}
						</dd>
					</div>
					<div class="detail-row">
						<dt>Created</dt>
						<dd>{new Date(tenant.created_at * 1000).toLocaleString()}</dd>
					</div>
					<div class="detail-row">
						<dt>Updated</dt>
						<dd>{new Date(tenant.updated_at * 1000).toLocaleString()}</dd>
					</div>
				</dl>
			</section>
		{/if}

		<!-- Login Entry Settings -->
		<section class="card">
			<div class="card-header-row">
				<div>
					<h2 class="card-title">Login Entry Settings</h2>
					<p class="card-description">
						Discovery behavior and discovery screen customization are managed from the dedicated
						Tenant Discovery page.
					</p>
				</div>
				<a class="btn btn-secondary" href="/admin/tenant-discovery">Open Tenant Discovery</a>
			</div>

			{#if settingsLoading}
				<div class="loading-inline"><i class="i-ph-circle-notch animate-spin"></i> Loading...</div>
			{:else if settingsError}
				<div class="alert alert-error">{settingsError}</div>
			{:else if settingsMeta && settings}
				<div class="settings-summary">
					<div class="setting-summary-item">
						<span class="setting-label">Entry Mode</span>
						<span>{String(getSettingValue('login-entry.mode'))}</span>
					</div>
					<div class="setting-summary-item">
						<span class="setting-label">Selection Policy</span>
						<span>{String(getSettingValue('login-entry.selection_policy'))}</span>
					</div>
					<div class="setting-summary-item">
						<span class="setting-label">Discovery Methods</span>
						<span>{String(getSettingValue('login-entry.discovery_methods'))}</span>
					</div>
				</div>
			{/if}
		</section>

		<!-- Danger Zone -->
		{#if !tenant.is_default}
			<section class="card card-danger">
				<h2 class="card-title danger-title">Danger Zone</h2>
				{#if !showDeleteConfirm}
					<div class="danger-row">
						<div>
							<p class="danger-label">Delete Tenant</p>
							<p class="danger-desc">
								Permanently delete this tenant and all associated data. This action cannot be
								undone.
							</p>
						</div>
						<button class="btn btn-danger-outline" onclick={openDeleteConfirm}>
							<i class="i-ph-trash"></i>
							Delete Tenant
						</button>
					</div>
				{:else}
					<div class="delete-confirm-area">
						{#if deleteError}
							<div class="alert alert-error">{deleteError}</div>
						{/if}
						<div class="alert alert-warning">
							<i class="i-ph-warning"></i>
							<strong>Warning:</strong> All data associated with tenant <strong>{tenant.id}</strong> will
							be permanently deleted.
						</div>
						<div class="form-group">
							<label for="delete-confirm" class="form-label">
								Type <strong>{tenant.id}</strong> to confirm:
							</label>
							<input
								id="delete-confirm"
								type="text"
								class="form-input"
								bind:value={deleteConfirmInput}
								placeholder={tenant.id}
								autocomplete="off"
							/>
						</div>
						<div class="delete-actions">
							<button class="btn btn-secondary" onclick={cancelDelete} disabled={deleting}
								>Cancel</button
							>
							<button
								class="btn btn-danger"
								onclick={handleDelete}
								disabled={deleting || deleteConfirmInput !== tenant.id}
							>
								{#if deleting}<i class="i-ph-circle-notch animate-spin"></i> Deleting...{:else}Delete
									Tenant{/if}
							</button>
						</div>
					</div>
				{/if}
			</section>
		{/if}
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 800px;
	}

	.page-nav {
		margin-bottom: 4px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.875rem;
		color: var(--text-secondary);
		text-decoration: none;
		transition: color var(--transition-fast);
	}

	.back-link:hover {
		color: var(--primary);
	}

	.back-link :global(i) {
		width: 16px;
		height: 16px;
	}

	.page-header {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.page-title-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}

	.page-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0 0 4px;
	}

	.tenant-id-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.tenant-id-badge :global(i) {
		width: 14px;
		height: 14px;
	}

	.header-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-shrink: 0;
	}

	.status-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.default-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--warning) 12%, var(--bg-subtle));
		color: var(--warning-dark, #a16207);
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.default-badge :global(i) {
		width: 14px;
		height: 14px;
	}

	/* Card */
	.card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 20px 24px;
	}

	.card-danger {
		border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
	}

	.card-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 16px;
	}

	.card-header-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.card-header-row .card-title {
		margin: 0 0 4px;
	}

	.card-description {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.danger-title {
		color: var(--danger);
	}

	/* Detail grid */
	.detail-grid {
		display: flex;
		flex-direction: column;
		gap: 0;
		margin: 0;
	}

	.detail-row {
		display: grid;
		grid-template-columns: 160px 1fr;
		gap: 12px;
		padding: 10px 0;
		border-bottom: 1px solid var(--border-subtle, var(--border));
	}

	.detail-row:last-child {
		border-bottom: none;
	}

	.detail-row dt {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.detail-row dd {
		font-size: 0.875rem;
		color: var(--text-primary);
		margin: 0;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.text-muted {
		color: var(--text-muted);
	}

	/* Badges */
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.badge :global(i) {
		width: 12px;
		height: 12px;
	}

	.badge-active {
		background: var(--success-subtle);
		color: var(--success);
	}

	.badge-inactive {
		background: var(--bg-subtle);
		color: var(--text-muted);
	}

	.badge-default {
		background: color-mix(in srgb, var(--warning) 12%, var(--bg-subtle));
		color: var(--warning-dark, #a16207);
	}

	/* Form */
	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	.form-group-full {
		grid-column: 1 / -1;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.form-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.required {
		color: var(--danger);
	}

	.form-input {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: var(--font-body);
		outline: none;
		width: 100%;
		box-sizing: border-box;
		transition: border-color var(--transition-fast);
	}

	.form-input:focus {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.field-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}

	/* Toggle switch */
	.toggle-label {
		display: flex;
		align-items: center;
		justify-content: space-between;
		cursor: pointer;
	}

	.toggle-label.disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.toggle-switch {
		position: relative;
	}

	.toggle-input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}

	.toggle-slider {
		display: block;
		width: 40px;
		height: 22px;
		background: var(--bg-tertiary);
		border-radius: var(--radius-full);
		position: relative;
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.toggle-switch.disabled .toggle-slider {
		cursor: not-allowed;
	}

	.toggle-slider::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 16px;
		height: 16px;
		background: white;
		border-radius: var(--radius-full);
		transition: transform var(--transition-fast);
		box-shadow: var(--shadow-sm);
	}

	.toggle-switch.checked .toggle-slider {
		background: var(--primary);
	}

	.toggle-switch.checked .toggle-slider::after {
		transform: translateX(18px);
	}

	/* Settings */
	.loading-inline {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-secondary);
		font-size: 0.875rem;
		padding: 8px 0;
	}

	.loading-inline :global(i) {
		width: 16px;
		height: 16px;
	}

	.settings-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.setting-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 0;
		border-bottom: 1px solid var(--border-subtle, var(--border));
	}

	.setting-item:last-child {
		border-bottom: none;
	}

	.setting-item.modified {
		background: color-mix(in srgb, var(--primary) 4%, transparent);
		margin: 0 -8px;
		padding: 12px 8px;
		border-radius: var(--radius-sm);
	}

	.setting-info {
		flex: 1;
		min-width: 0;
	}

	.setting-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
		margin-right: 8px;
	}

	.modified-badge {
		font-size: 0.75rem;
		color: var(--primary);
		font-weight: 500;
	}

	.setting-desc {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin: 4px 0 0;
	}

	.setting-control {
		flex-shrink: 0;
	}

	.settings-select,
	.settings-input {
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: var(--font-body);
		outline: none;
	}

	.settings-select {
		min-width: 160px;
	}

	.settings-input {
		min-width: 200px;
	}

	.settings-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}

	/* Danger Zone */
	.danger-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.danger-label {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 4px;
	}

	.danger-desc {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.delete-confirm-area {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.delete-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	/* Buttons */
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
		border: none;
		text-decoration: none;
		font-family: var(--font-body);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn :global(i) {
		width: 16px;
		height: 16px;
	}

	.btn-primary {
		background: var(--primary);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-dark);
	}

	.btn-secondary {
		background: var(--bg-subtle);
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--bg-card);
	}

	.btn-danger {
		background: var(--danger);
		color: white;
	}

	.btn-danger:hover:not(:disabled) {
		background: var(--danger-dark);
	}

	.btn-danger-outline {
		background: transparent;
		color: var(--danger);
		border: 1px solid var(--danger);
	}

	.btn-danger-outline:hover:not(:disabled) {
		background: var(--danger-subtle);
	}

	/* Alerts */
	.alert {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		background: var(--danger-subtle);
		color: var(--danger);
		border: 1px solid var(--danger-border);
	}

	.alert-warning {
		background: var(--warning-subtle);
		color: var(--warning-dark);
		border: 1px solid var(--warning-border);
	}

	.alert-success {
		background: var(--success-subtle);
		color: var(--success);
		border: 1px solid color-mix(in srgb, var(--success) 30%, var(--border));
	}

	/* Loading */
	.loading-state {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--text-secondary);
		padding: 48px 0;
		font-size: 0.875rem;
	}

	.loading-state :global(i) {
		width: 20px;
		height: 20px;
	}

	@media (max-width: 640px) {
		.form-grid {
			grid-template-columns: 1fr;
		}

		.detail-row {
			grid-template-columns: 1fr;
			gap: 4px;
		}

		.danger-row {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>

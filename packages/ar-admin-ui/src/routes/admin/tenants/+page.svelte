<script lang="ts">
	import { onMount } from 'svelte';
	import { adminTenantsAPI, type Tenant } from '$lib/api/admin-tenants';
	import { tenantStore } from '$lib/stores/tenants.svelte';

	// ==========================================================================
	// State
	// ==========================================================================

	// Use the shared store so AdminHeader selector stays in sync
	let tenants = $derived(tenantStore.tenants);
	let singleTenantMode = $derived(tenantStore.singleTenantMode);
	let singleTenantReason = $derived(tenantStore.singleTenantReason);
	let loading = $state(!tenantStore.loaded);
	let error = $state('');
	let infoMessage = $state('');

	// Create dialog
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newId = $state('');
	let newName = $state('');
	let newDescription = $state('');
	let idValidationError = $state('');

	// Edit dialog
	let showEditDialog = $state(false);
	let editingTenant: Tenant | null = $state(null);
	let editing = $state(false);
	let editError = $state('');
	let editName = $state('');
	let editDescription = $state('');
	let editIsActive = $state(true);

	// Delete dialog
	let showDeleteDialog = $state(false);
	let deletingTenant: Tenant | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');
	let deleteConfirmInput = $state('');

	// Track tenant IDs that have pending deletion jobs
	let pendingDeletions = $state<Set<string>>(new Set());

	// Set default
	let settingDefault = $state('');

	// ==========================================================================
	// Validation
	// ==========================================================================

	// DNS label format: starts and ends with alphanumeric, hyphens allowed in the middle
	const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

	function validateTenantId(value: string): string {
		if (!value) return 'ID is required';
		if (value.length > 63) return 'ID must be 63 characters or fewer';
		if (!TENANT_ID_REGEX.test(value))
			return 'ID must start and end with a lowercase letter or digit (hyphens allowed in between)';
		return '';
	}

	function handleIdInput() {
		idValidationError = validateTenantId(newId);
	}

	// ==========================================================================
	// Data Loading
	// ==========================================================================

	async function loadTenants() {
		loading = true;
		error = '';

		try {
			await tenantStore.reload();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load tenants';
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		// If the store already has data (loaded by layout), skip the initial fetch
		if (!tenantStore.loaded) {
			await loadTenants();
		} else {
			loading = false;
		}
	});

	// ==========================================================================
	// Create
	// ==========================================================================

	function openCreateDialog() {
		if (singleTenantMode) return;
		newId = '';
		newName = '';
		newDescription = '';
		createError = '';
		idValidationError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function handleCreate() {
		idValidationError = validateTenantId(newId);
		if (idValidationError) return;
		if (!newName.trim()) {
			createError = 'Name is required';
			return;
		}

		creating = true;
		createError = '';

		try {
			const created = await adminTenantsAPI.create({
				id: newId,
				name: newName.trim(),
				description: newDescription.trim() || undefined
			});
			tenantStore.add(created);
			closeCreateDialog();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create tenant';
		} finally {
			creating = false;
		}
	}

	// ==========================================================================
	// Edit
	// ==========================================================================

	function openEditDialog(tenant: Tenant) {
		editingTenant = tenant;
		editName = tenant.name;
		editDescription = tenant.description ?? '';
		editIsActive = tenant.is_active;
		editError = '';
		showEditDialog = true;
	}

	function closeEditDialog() {
		showEditDialog = false;
		editingTenant = null;
	}

	async function handleEdit() {
		if (!editingTenant) return;
		const editActiveDisabled = singleTenantMode;
		if (!editName.trim()) {
			editError = 'Name is required';
			return;
		}
		if (editActiveDisabled && editIsActive !== editingTenant.is_active) {
			editError = 'The initial tenant must remain active in single-tenant mode.';
			return;
		}

		editing = true;
		editError = '';

		try {
			const updated = await adminTenantsAPI.update(editingTenant.id, {
				name: editName.trim(),
				description: editDescription.trim() || null,
				is_active: editIsActive
			});
			tenantStore.update(updated);
			closeEditDialog();
		} catch (err) {
			editError = err instanceof Error ? err.message : 'Failed to update tenant';
		} finally {
			editing = false;
		}
	}

	// ==========================================================================
	// Delete
	// ==========================================================================

	function openDeleteDialog(tenant: Tenant) {
		deletingTenant = tenant;
		deleteConfirmInput = '';
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		deletingTenant = null;
	}

	async function handleDelete() {
		if (!deletingTenant) return;
		if (deleteConfirmInput !== deletingTenant.id) {
			deleteError = 'Tenant ID does not match';
			return;
		}

		deleting = true;
		deleteError = '';

		try {
			const result = await adminTenantsAPI.delete(deletingTenant.id);
			// 202 Accepted: deletion is async. Deactivate in store and mark as pending.
			tenantStore.update({ ...deletingTenant, is_active: false });
			pendingDeletions = new Set([...pendingDeletions, deletingTenant.id]);
			closeDeleteDialog();
			// Show job info in page-level info message
			infoMessage = `Tenant "${deletingTenant.id}" deletion queued (job: ${result.job_id}). Data will be removed within the hour.`;
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Failed to delete tenant';
		} finally {
			deleting = false;
		}
	}

	// ==========================================================================
	// Set Default
	// ==========================================================================

	async function handleSetDefault(tenant: Tenant) {
		if (tenant.is_default || settingDefault) return;

		settingDefault = tenant.id;

		try {
			await adminTenantsAPI.setDefault(tenant.id);
			tenantStore.setDefault(tenant.id);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to set default tenant';
		} finally {
			settingDefault = '';
		}
	}
</script>

<div class="page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Tenants</h1>
			<p class="page-description">Manage tenants for this Authrim instance.</p>
		</div>
		<button
			class="btn btn-primary"
			onclick={openCreateDialog}
			disabled={singleTenantMode}
			title={singleTenantMode
				? 'Unavailable in single-tenant mode. Configure an API custom domain to enable multiple tenants.'
				: 'Add a tenant'}
		>
			<i class="i-ph-plus"></i>
			Add Tenant
		</button>
	</div>

	{#if singleTenantMode}
		<div class="alert alert-info">
			<i class="i-ph-info"></i>
			<div>
				<strong>Single-tenant mode</strong>
				<p>
					{singleTenantReason ??
						'API custom domain is not configured. This deployment runs in single-tenant mode.'}
					Configure an API custom domain in setup to enable additional tenants.
				</p>
			</div>
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<i class="i-ph-warning-circle"></i>
			{error}
		</div>
	{/if}

	{#if infoMessage}
		<div class="alert alert-info">
			<i class="i-ph-info"></i>
			{infoMessage}
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			Loading tenants...
		</div>
	{:else if tenants.length === 0}
		<div class="empty-state">
			<i class="i-ph-buildings"></i>
			<p>No tenants found.</p>
		</div>
	{:else}
		<div class="table-container">
			<table class="table">
				<thead>
					<tr>
						<th>ID</th>
						<th>Name</th>
						<th>Description</th>
						<th>Status</th>
						<th>Default</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each tenants as tenant (tenant.id)}
						<tr>
							<td class="tenant-id">{tenant.id}</td>
							<td class="tenant-name">{tenant.name}</td>
							<td class="tenant-description">{tenant.description ?? '—'}</td>
							<td>
								{#if pendingDeletions.has(tenant.id)}
									<span class="badge badge-deleting">Deleting...</span>
								{:else if tenant.is_active}
									<span class="badge badge-active">Active</span>
								{:else}
									<span class="badge badge-inactive">Disabled</span>
								{/if}
							</td>
							<td>
								<button
									class="default-star"
									class:is-default={tenant.is_default}
									class:loading={settingDefault === tenant.id}
									disabled={tenant.is_default ||
										!!settingDefault ||
										pendingDeletions.has(tenant.id)}
									onclick={() => handleSetDefault(tenant)}
									title={tenant.is_default ? 'Default tenant' : 'Set as default'}
									aria-label={tenant.is_default ? 'Default tenant' : 'Set as default'}
								>
									{#if settingDefault === tenant.id}
										<i class="i-ph-circle-notch animate-spin"></i>
									{:else if tenant.is_default}
										<i class="i-ph-star-fill"></i>
									{:else}
										<i class="i-ph-star"></i>
									{/if}
								</button>
							</td>
							<td class="actions">
								<button
									class="btn btn-sm btn-secondary"
									disabled={pendingDeletions.has(tenant.id)}
									onclick={() => openEditDialog(tenant)}
								>
									Edit
								</button>
								{#if !tenant.is_default}
									<button
										class="btn btn-sm btn-danger-outline"
										disabled={pendingDeletions.has(tenant.id)}
										onclick={() => openDeleteDialog(tenant)}
									>
										Delete
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Create Dialog -->
{#if showCreateDialog}
	<div
		class="modal-overlay"
		onclick={closeCreateDialog}
		role="button"
		tabindex="-1"
		aria-label="Close dialog"
		onkeydown={(e) => e.key === 'Escape' && closeCreateDialog()}
	></div>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="create-dialog-title">
		<div class="modal-header">
			<h2 id="create-dialog-title">Add Tenant</h2>
			<button class="modal-close" onclick={closeCreateDialog} aria-label="Close">
				<i class="i-ph-x"></i>
			</button>
		</div>
		<div class="modal-body">
			{#if createError}
				<div class="alert alert-error">{createError}</div>
			{/if}
			<div class="form-group">
				<label for="new-id" class="form-label">Tenant ID <span class="required">*</span></label>
				<input
					id="new-id"
					type="text"
					class="form-input"
					class:error={!!idValidationError}
					bind:value={newId}
					oninput={handleIdInput}
					placeholder="e.g. acme-corp"
					maxlength="63"
					autocomplete="off"
				/>
				{#if idValidationError}
					<p class="field-error">{idValidationError}</p>
				{:else}
					<p class="field-hint">Lowercase letters, numbers, hyphens. Max 63 characters.</p>
				{/if}
			</div>
			<div class="form-group">
				<label for="new-name" class="form-label">Name <span class="required">*</span></label>
				<input
					id="new-name"
					type="text"
					class="form-input"
					bind:value={newName}
					placeholder="e.g. Acme Corporation"
					maxlength="200"
				/>
			</div>
			<div class="form-group">
				<label for="new-description" class="form-label">Description</label>
				<textarea
					id="new-description"
					class="form-input"
					bind:value={newDescription}
					placeholder="Optional description"
					rows="3"
					maxlength="500"
				></textarea>
			</div>
		</div>
		<div class="modal-footer">
			<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
				Cancel
			</button>
			<button
				class="btn btn-primary"
				onclick={handleCreate}
				disabled={creating || !!idValidationError}
			>
				{#if creating}
					<i class="i-ph-circle-notch animate-spin"></i>
					Creating...
				{:else}
					Create Tenant
				{/if}
			</button>
		</div>
	</div>
{/if}

<!-- Edit Dialog -->
{#if showEditDialog && editingTenant}
	<div
		class="modal-overlay"
		onclick={closeEditDialog}
		role="button"
		tabindex="-1"
		aria-label="Close dialog"
		onkeydown={(e) => e.key === 'Escape' && closeEditDialog()}
	></div>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-dialog-title">
		<div class="modal-header">
			<h2 id="edit-dialog-title">Edit Tenant</h2>
			<button class="modal-close" onclick={closeEditDialog} aria-label="Close">
				<i class="i-ph-x"></i>
			</button>
		</div>
		<div class="modal-body">
			{#if editError}
				<div class="alert alert-error">{editError}</div>
			{/if}
			<div class="form-group">
				<p class="form-label">Tenant ID</p>
				<div class="form-static" aria-label="Tenant ID">{editingTenant.id}</div>
				<p class="field-hint">Tenant ID cannot be changed.</p>
			</div>
			<div class="form-group">
				<label for="edit-name" class="form-label">Name <span class="required">*</span></label>
				<input
					id="edit-name"
					type="text"
					class="form-input"
					bind:value={editName}
					placeholder="Display name"
					maxlength="200"
				/>
			</div>
			<div class="form-group">
				<label for="edit-description" class="form-label">Description</label>
				<textarea
					id="edit-description"
					class="form-input"
					bind:value={editDescription}
					placeholder="Optional description"
					rows="3"
					maxlength="500"
				></textarea>
			</div>
			<div class="form-group">
				<label
					class="form-label toggle-label"
					class:disabled={singleTenantMode || editingTenant.is_default}
				>
					<span>Active</span>
					<div
						class="toggle-switch"
						class:checked={editIsActive}
						class:disabled={singleTenantMode || editingTenant.is_default}
					>
						<input
							type="checkbox"
							bind:checked={editIsActive}
							class="toggle-input"
							id="edit-active"
							disabled={singleTenantMode}
						/>
						<label for="edit-active" class="toggle-slider"></label>
					</div>
				</label>
				<p class="field-hint">
					{#if singleTenantMode}
						The initial tenant must remain active in single-tenant mode.
					{:else}
						Inactive tenants are hidden from the tenant selector.
					{/if}
				</p>
			</div>
		</div>
		<div class="modal-footer">
			<button class="btn btn-secondary" onclick={closeEditDialog} disabled={editing}>
				Cancel
			</button>
			<button class="btn btn-primary" onclick={handleEdit} disabled={editing}>
				{#if editing}
					<i class="i-ph-circle-notch animate-spin"></i>
					Saving...
				{:else}
					Save Changes
				{/if}
			</button>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && deletingTenant}
	<div
		class="modal-overlay"
		onclick={closeDeleteDialog}
		role="button"
		tabindex="-1"
		aria-label="Close dialog"
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
	></div>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
		<div class="modal-header">
			<h2 id="delete-dialog-title" class="danger-title">Delete Tenant</h2>
			<button class="modal-close" onclick={closeDeleteDialog} aria-label="Close">
				<i class="i-ph-x"></i>
			</button>
		</div>
		<div class="modal-body">
			{#if deleteError}
				<div class="alert alert-error">{deleteError}</div>
			{/if}
			<div class="alert alert-warning">
				<i class="i-ph-warning"></i>
				<strong>Warning:</strong> This action is irreversible. All data associated with tenant
				<strong>{deletingTenant.id}</strong> will be permanently deleted.
			</div>
			<div class="form-group">
				<label for="delete-confirm" class="form-label">
					Type <strong>{deletingTenant.id}</strong> to confirm deletion:
				</label>
				<input
					id="delete-confirm"
					type="text"
					class="form-input"
					bind:value={deleteConfirmInput}
					placeholder={deletingTenant.id}
					autocomplete="off"
				/>
			</div>
		</div>
		<div class="modal-footer">
			<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
				Cancel
			</button>
			<button
				class="btn btn-danger"
				onclick={handleDelete}
				disabled={deleting || deleteConfirmInput !== deletingTenant.id}
			>
				{#if deleting}
					<i class="i-ph-circle-notch animate-spin"></i>
					Deleting...
				{:else}
					Delete Tenant
				{/if}
			</button>
		</div>
	</div>
{/if}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.page-title {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0 0 4px;
	}

	.page-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	/* Table */
	.table-container {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.table {
		width: 100%;
		border-collapse: collapse;
	}

	.table th {
		padding: 12px 16px;
		text-align: left;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		background: var(--bg-subtle);
		border-bottom: 1px solid var(--border);
	}

	.table td {
		padding: 14px 16px;
		font-size: 0.875rem;
		color: var(--text-primary);
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
	}

	.table tr:last-child td {
		border-bottom: none;
	}

	.tenant-id {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.tenant-name {
		font-weight: 500;
	}

	.tenant-description {
		color: var(--text-secondary);
		max-width: 240px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Badges */
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.badge-active {
		background: var(--success-subtle);
		color: var(--success);
	}

	.badge-inactive {
		background: var(--bg-subtle);
		color: var(--text-muted);
	}

	.badge-deleting {
		background: var(--warning-subtle);
		color: var(--warning-dark);
	}

	/* Default star */
	.default-star {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: none;
		background: transparent;
		cursor: pointer;
		border-radius: var(--radius-sm);
		transition: all var(--transition-fast);
		color: var(--text-muted);
	}

	.default-star:hover:not(:disabled) {
		color: var(--warning);
		background: var(--warning-subtle);
	}

	.default-star.is-default {
		color: var(--warning);
		cursor: default;
	}

	.default-star:disabled:not(.is-default) {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.default-star :global(i) {
		width: 18px;
		height: 18px;
	}

	/* Actions */
	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
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

	.btn-sm {
		padding: 4px 10px;
		font-size: 0.8125rem;
	}

	/* Alert */
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

	.alert-info {
		background: var(--info-subtle, var(--primary-light));
		color: var(--info, var(--primary));
		border: 1px solid var(--info-border, var(--primary-light));
	}

	/* Loading / Empty */
	.loading-state,
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 48px;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.loading-state :global(i),
	.empty-state :global(i) {
		width: 32px;
		height: 32px;
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 100;
		border: none;
		cursor: default;
	}

	.modal {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 100%;
		max-width: 480px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-xl);
		z-index: 101;
		display: flex;
		flex-direction: column;
		max-height: 90vh;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px 24px 16px;
		border-bottom: 1px solid var(--border);
	}

	.modal-header h2 {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.danger-title {
		color: var(--danger) !important;
	}

	.modal-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		border-radius: var(--radius-sm);
		transition: all var(--transition-fast);
	}

	.modal-close:hover {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.modal-close :global(i) {
		width: 18px;
		height: 18px;
	}

	.modal-body {
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		overflow-y: auto;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding: 16px 24px 20px;
		border-top: 1px solid var(--border);
	}

	/* Form */
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
		transition: border-color var(--transition-fast);
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.form-input:focus {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.form-input.error {
		border-color: var(--danger);
	}

	.form-static {
		padding: 8px 12px;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.field-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}

	.field-error {
		font-size: 0.75rem;
		color: var(--danger);
		margin: 0;
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
	}

	.toggle-switch {
		position: relative;
	}

	.toggle-switch.disabled {
		opacity: 0.5;
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
</style>

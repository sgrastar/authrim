<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { adminTenantsAPI, type Tenant } from '$lib/api/admin-tenants';
	import {
		tenantVanityDomainsAPI,
		type TenantVanityDomain
	} from '$lib/api/admin-tenant-vanity-domains';
	import {
		adminSettingsAPI,
		scopedSettingsAPI,
		type CategorySettings,
		type CategoryMetaFull
	} from '$lib/api/admin-settings';
	import { getTenantProvisioningDraftUiState } from '$lib/admin/tenant-d1-ui-state';
	import { tenantStore } from '$lib/stores/tenants.svelte';

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

	// Provisioning cleanup
	let cleanupProvisioning = $state(false);
	let cleanupProvisioningError = $state('');
	let retryProvisioning = $state(false);
	let retryProvisioningError = $state('');

	// Tenant settings (login-entry category)
	let settingsMeta = $state<CategoryMetaFull | null>(null);
	let settings = $state<CategorySettings | null>(null);
	let settingsLoading = $state(false);
	let settingsError = $state('');

	// Vanity domains
	let vanityDomains = $state<TenantVanityDomain[]>([]);
	let vanityCloudflareConfigured = $state(false);
	let vanityLoading = $state(false);
	let vanityError = $state('');
	let vanitySuccess = $state('');
	let newVanityHostname = $state('');
	let vanityCreating = $state(false);
	let vanitySyncingId = $state<string | null>(null);
	let vanityVerifyingId = $state<string | null>(null);
	let vanityDeletingId = $state<string | null>(null);
	let vanityPrimaryId = $state<string | null>(null);

	const singleTenantMode = $derived(tenantStore.singleTenantMode);
	const provisioningFailed = $derived(tenant?.provisioning_status === 'provisioning_failed');
	const provisioningDraftState = $derived(getTenantProvisioningDraftUiState(tenant));
	const tenantOperational = $derived(!!tenant?.is_active && !provisioningFailed);

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

	async function loadVanityDomains() {
		vanityLoading = true;
		vanityError = '';
		try {
			const response = await tenantVanityDomainsAPI.list(tenantId);
			vanityDomains = response.domains;
			vanityCloudflareConfigured = response.cloudflare_configured;
		} catch (err) {
			vanityError = err instanceof Error ? err.message : 'Failed to load vanity domains';
		} finally {
			vanityLoading = false;
		}
	}

	onMount(async () => {
		await loadTenant();
		if (tenantOperational) {
			await Promise.all([loadSettings(), loadVanityDomains()]);
		}
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

	async function handleCleanupProvisioning() {
		if (!tenant || cleanupProvisioning) return;
		cleanupProvisioning = true;
		cleanupProvisioningError = '';
		try {
			await adminTenantsAPI.cleanupProvisioning(tenant.id);
			tenantStore.remove(tenant.id);
			goto('/admin/tenants');
		} catch (err) {
			cleanupProvisioningError =
				err instanceof Error ? err.message : 'Failed to cleanup tenant provisioning draft';
		} finally {
			cleanupProvisioning = false;
		}
	}

	async function handleRetryProvisioning() {
		if (!tenant || retryProvisioning) return;
		retryProvisioning = true;
		retryProvisioningError = '';
		try {
			const updated = await adminTenantsAPI.retryProvisioning(tenant.id);
			tenantStore.update(updated);
			tenant = updated;
			await Promise.all([loadSettings(), loadVanityDomains()]);
		} catch (err) {
			retryProvisioningError =
				err instanceof Error ? err.message : 'Failed to retry tenant provisioning';
		} finally {
			retryProvisioning = false;
		}
	}

	// ==========================================================================
	// Settings
	// ==========================================================================

	function getSettingValue(key: string): unknown {
		return settings?.values[key];
	}

	function formatValidationRecords(records: unknown): string {
		if (!records) return 'No validation records returned yet.';
		return JSON.stringify(records, null, 2);
	}

	async function handleCreateVanityDomain() {
		const hostname = newVanityHostname.trim();
		if (!hostname) {
			vanityError = 'Hostname is required';
			return;
		}
		vanityCreating = true;
		vanityError = '';
		vanitySuccess = '';
		try {
			const response = await tenantVanityDomainsAPI.create(tenantId, hostname);
			newVanityHostname = '';
			vanitySuccess = response.manual_setup_required
				? 'Vanity domain saved. Add it manually in Cloudflare Custom Hostnames and create the DNS records shown below.'
				: response.cloudflare_error
					? `Vanity domain saved, but Cloudflare returned an error: ${response.cloudflare_error}`
					: 'Vanity domain created. Refresh status after DNS validation is complete.';
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : 'Failed to create vanity domain';
		} finally {
			vanityCreating = false;
		}
	}

	async function handleSyncVanityDomain(id: string) {
		vanitySyncingId = id;
		vanityError = '';
		vanitySuccess = '';
		try {
			await tenantVanityDomainsAPI.sync(tenantId, id);
			vanitySuccess = 'Cloudflare status refreshed.';
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : 'Failed to refresh vanity domain';
		} finally {
			vanitySyncingId = null;
		}
	}

	async function handleVerifyVanityDomain(id: string) {
		vanityVerifyingId = id;
		vanityError = '';
		vanitySuccess = '';
		try {
			await tenantVanityDomainsAPI.verify(tenantId, id);
			vanitySuccess = 'Vanity domain marked as verified.';
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : 'Failed to verify vanity domain';
		} finally {
			vanityVerifyingId = null;
		}
	}


	async function handleSetPrimaryVanityDomain(id: string) {
		vanityPrimaryId = id;
		vanityError = '';
		vanitySuccess = '';
		try {
			await tenantVanityDomainsAPI.setPrimary(tenantId, id);
			vanitySuccess = 'Primary vanity domain updated.';
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : 'Failed to set primary vanity domain';
		} finally {
			vanityPrimaryId = null;
		}
	}

	async function handleDeleteVanityDomain(id: string) {
		vanityDeletingId = id;
		vanityError = '';
		vanitySuccess = '';
		try {
			await tenantVanityDomainsAPI.delete(tenantId, id);
			vanitySuccess = 'Vanity domain deleted.';
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : 'Failed to delete vanity domain';
		} finally {
			vanityDeletingId = null;
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
					{#if tenant.is_default}
						<span class="default-badge">
							<i class="i-ph-star-fill"></i>
							Default Tenant
						</span>
					{:else if tenantOperational}
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
					{/if}
					{#if !isEditing && tenantOperational}
						<button class="btn btn-primary" onclick={startEdit}>
							<i class="i-ph-pencil"></i>
							Edit
						</button>
					{/if}
				</div>
			</div>

			<!-- Status badge -->
			<div class="status-row">
				{#if provisioningFailed}
					<span class="badge badge-error">Provisioning Failed</span>
				{:else if tenant.is_active}
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

		{#if provisioningFailed || !tenant.is_active}
			<section class="card status-card">
				<div class="status-card-header">
					<i class={provisioningFailed ? 'i-ph-warning-circle' : 'i-ph-pause-circle'}></i>
					<div>
						<h2 class="card-title">
							{provisioningDraftState.title}
						</h2>
						<p class="card-description">
							{provisioningDraftState.description}
						</p>
					</div>
				</div>
				{#if provisioningDraftState.showActions}
					<dl class="detail-grid compact-details">
						<div class="detail-row">
							<dt>Slot</dt>
							<dd class="mono">{provisioningDraftState.slot}</dd>
						</div>
						<div class="detail-row">
							<dt>Last Error</dt>
							<dd>{provisioningDraftState.error}</dd>
						</div>
						{#if tenant.provisioning_updated_at}
							<div class="detail-row">
								<dt>Updated</dt>
								<dd>{new Date(tenant.provisioning_updated_at * 1000).toLocaleString()}</dd>
							</div>
						{/if}
					</dl>
					{#if cleanupProvisioningError}
						<div class="alert alert-error">{cleanupProvisioningError}</div>
					{/if}
					{#if retryProvisioningError}
						<div class="alert alert-error">{retryProvisioningError}</div>
					{/if}
					<div class="form-actions">
						<button
							class="btn btn-secondary"
							onclick={handleRetryProvisioning}
							disabled={retryProvisioning || cleanupProvisioning}
						>
							{#if retryProvisioning}
								<i class="i-ph-circle-notch animate-spin"></i>
								Retrying
							{:else}
								<i class="i-ph-arrows-clockwise"></i>
								Retry
							{/if}
						</button>
						<button
							class="btn btn-danger-outline"
							onclick={handleCleanupProvisioning}
							disabled={cleanupProvisioning || retryProvisioning}
						>
							{#if cleanupProvisioning}
								<i class="i-ph-circle-notch animate-spin"></i>
								Cleaning
							{:else}
								<i class="i-ph-trash"></i>
								Cleanup Draft
							{/if}
						</button>
					</div>
				{/if}
			</section>
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

		{#if !singleTenantMode && tenantOperational}
			<!-- Vanity Domains -->
			<section class="card">
				<div class="card-header-row">
					<div>
						<h2 class="card-title">Vanity Domains</h2>
						<p class="card-description">
							Primary active vanity domains become the tenant canonical issuer.
						</p>
					</div>
					<button class="btn btn-secondary" onclick={loadVanityDomains} disabled={vanityLoading}>
						{#if vanityLoading}
							<i class="i-ph-circle-notch animate-spin"></i>
							Refreshing
						{:else}
							<i class="i-ph-arrows-clockwise"></i>
							Refresh
						{/if}
					</button>
				</div>

				{#if vanityError}
					<div class="alert alert-error">{vanityError}</div>
				{/if}
				{#if vanitySuccess}
					<div class="alert alert-success">{vanitySuccess}</div>
				{/if}
				{#if !vanityCloudflareConfigured}
					<div class="alert alert-warning">
						<i class="i-ph-warning"></i>
						Cloudflare automation is not configured. Create a Cloudflare Custom Hostname manually
						and add the required CNAME and HTTP ownership validation records.
					</div>
				{/if}

				<div class="vanity-create-row">
					<div class="form-group vanity-host-input">
						<label for="vanity-hostname" class="form-label">Hostname</label>
						<input
							id="vanity-hostname"
							type="text"
							class="form-input"
							bind:value={newVanityHostname}
							placeholder="login.example.com"
							autocomplete="off"
						/>
					</div>
					<button
						class="btn btn-primary"
						onclick={handleCreateVanityDomain}
						disabled={vanityCreating}
					>
						{#if vanityCreating}
							<i class="i-ph-circle-notch animate-spin"></i>
							Adding
						{:else}
							Add Domain
						{/if}
					</button>
				</div>

				{#if vanityLoading}
					<div class="loading-inline"><i class="i-ph-circle-notch animate-spin"></i> Loading...</div>
				{:else if vanityDomains.length === 0}
					<p class="empty-text">No vanity domains configured.</p>
				{:else}
					<div class="vanity-domain-list">
						{#each vanityDomains as domain (domain.id)}
							<div class="vanity-domain-row">
								<div class="vanity-domain-main">
									<div class="vanity-host-line">
										<span class="mono">{domain.hostname}</span>
										{#if domain.is_primary}
											<span class="badge badge-default">Primary</span>
										{/if}
										<span class:badge-active={domain.status === 'active'} class="badge">
											{domain.status}
										</span>
									</div>
									<div class="vanity-meta">
										<span>SSL: {domain.ssl_status ?? 'pending'}</span>
										<span>Ownership: {domain.ownership_status ?? 'pending'}</span>
										{#if domain.last_sync_at}
											<span>Synced: {new Date(domain.last_sync_at * 1000).toLocaleString()}</span>
										{/if}
									</div>
									<details class="validation-details">
										<summary>Validation records</summary>
										<pre>{formatValidationRecords(domain.validation_records)}</pre>
									</details>
								</div>
								<div class="vanity-actions">
									<button
										class="btn btn-secondary"
										onclick={() => handleSyncVanityDomain(domain.id)}
										disabled={vanitySyncingId === domain.id}
									>
										{#if vanitySyncingId === domain.id}
											<i class="i-ph-circle-notch animate-spin"></i>
										{/if}
										Sync
									</button>
									<button
										class="btn btn-secondary"
										onclick={() => handleSetPrimaryVanityDomain(domain.id)}
										disabled={domain.is_primary || domain.status !== 'active' || vanityPrimaryId === domain.id}
										title={domain.status !== 'active'
											? 'Only active vanity domains can be primary'
											: 'Set as primary canonical issuer'}
									>
										Primary
									</button>
									{#if domain.status !== 'active'}
										<button
											class="btn btn-secondary"
											onclick={() => handleVerifyVanityDomain(domain.id)}
											disabled={vanityVerifyingId === domain.id}
										>
											Verify
										</button>
									{/if}
									<button
										class="btn btn-danger-outline"
										onclick={() => handleDeleteVanityDomain(domain.id)}
										disabled={vanityDeletingId === domain.id}
									>
										{#if vanityDeletingId === domain.id}
											<i class="i-ph-circle-notch animate-spin"></i>
										{/if}
										Delete
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		{#if tenantOperational}
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
		{/if}

		<!-- Danger Zone -->
		{#if tenantOperational && !tenant.is_default}
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

	.status-card {
		border-color: color-mix(in srgb, var(--danger) 28%, var(--border));
	}

	.status-card-header {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.status-card-header :global(i) {
		width: 22px;
		height: 22px;
		color: var(--danger);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.compact-details {
		margin-top: 16px;
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

	.badge-error {
		background: color-mix(in srgb, var(--danger) 12%, var(--bg-subtle));
		color: var(--danger);
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

	.setting-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
		margin-right: 8px;
	}

	/* Vanity domains */
	.vanity-create-row {
		display: flex;
		align-items: flex-end;
		gap: 12px;
		margin: 16px 0;
	}

	.vanity-host-input {
		flex: 1;
		min-width: 0;
	}

	.vanity-domain-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.vanity-domain-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 0;
		border-top: 1px solid var(--border-subtle, var(--border));
	}

	.vanity-domain-main {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: 8px;
	}

	.vanity-host-line {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.vanity-meta {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.validation-details summary {
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	.validation-details pre {
		overflow: auto;
		max-height: 220px;
		margin: 8px 0 0;
		padding: 12px;
		border-radius: var(--radius-sm);
		background: var(--bg-subtle);
		color: var(--text-primary);
		font-size: 0.75rem;
	}

	.vanity-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.empty-text {
		color: var(--text-secondary);
		font-size: 0.875rem;
		margin: 0;
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

		.vanity-create-row,
		.vanity-domain-row {
			flex-direction: column;
			align-items: stretch;
		}

		.vanity-actions {
			justify-content: flex-start;
		}
	}
</style>

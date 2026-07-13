<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminTenantsAPI,
		type Tenant,
		type TenantLifecycleCommand,
		type TenantLifecycleJob,
		type UpdateTenantRequest
	} from '$lib/api/admin-tenants';
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
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { LL } from '$i18n/i18n-svelte';

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

	// Lifecycle actions
	let lifecycleCommand = $state<TenantLifecycleCommand | null>(null);
	let lifecycleReason = $state('');
	let lifecycleConfirmInput = $state('');
	let lifecycleSubmitting = $state(false);
	let lifecycleError = $state('');
	let lifecycleResult = $state('');
	let lifecycleJobs = $state<TenantLifecycleJob[]>([]);
	let lifecycleJobsLoading = $state(false);
	let lifecycleRetryingId = $state<string | null>(null);
	let lifecyclePollTimer: ReturnType<typeof setInterval> | null = null;

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
	const tenantOperational = $derived(tenant?.lifecycle_state === 'active' && !provisioningFailed);
	const lifecycleActions = $derived.by((): TenantLifecycleCommand[] => {
		if (!tenant || tenant.is_default || singleTenantMode) return [];
		switch (tenant.lifecycle_state) {
			case 'active':
				return ['suspend', 'freeze'];
			case 'suspended':
				return ['resume', 'freeze'];
			case 'frozen':
				return ['unfreeze'];
			case 'migration_read_only':
				return ['freeze'];
			case 'restore_pending':
			case 'restore_validating':
				return ['restore-validate'];
			default:
				return [];
		}
	});

	// ==========================================================================
	// Validation
	// ==========================================================================

	const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

	function validateTenantCode(value: string): string {
		if (!value) return $LL.admin_tenants_validation_code_required();
		if (value.length > 63) return $LL.admin_tenants_validation_code_too_long();
		if (!TENANT_ID_REGEX.test(value)) return $LL.admin_tenants_validation_code_format();
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
			error = err instanceof Error ? err.message : $LL.admin_tenants_load_tenant_failed();
		} finally {
			loading = false;
		}
	}

	async function loadLifecycleJobs(silent = false) {
		if (!tenantId) return;
		if (!silent) lifecycleJobsLoading = true;
		try {
			lifecycleJobs = await adminTenantsAPI.lifecycleJobs(tenantId);
		} catch (err) {
			if (!silent) {
				lifecycleError =
					err instanceof Error ? err.message : $LL.admin_tenants_lifecycle_jobs_load_failed();
			}
		} finally {
			if (!silent) lifecycleJobsLoading = false;
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
			settingsError = err instanceof Error ? err.message : $LL.admin_tenants_load_settings_failed();
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
			vanityError = err instanceof Error ? err.message : $LL.admin_tenants_load_vanity_failed();
		} finally {
			vanityLoading = false;
		}
	}

	onMount(async () => {
		await loadTenant();
		await loadLifecycleJobs();
		lifecyclePollTimer = setInterval(async () => {
			if (lifecycleJobs.some((job) => job.status === 'pending' || job.status === 'processing')) {
				await Promise.all([loadLifecycleJobs(true), loadTenant()]);
			}
		}, 3000);
		if (tenantOperational) {
			await Promise.all([loadSettings(), loadVanityDomains()]);
		}
	});

	onDestroy(() => {
		if (lifecyclePollTimer) clearInterval(lifecyclePollTimer);
	});

	// ==========================================================================
	// Edit
	// ==========================================================================

	function startEdit() {
		if (!tenant) return;
		editName = tenant.name;
		editTenantCode = tenant.tenant_code;
		editDescription = tenant.description ?? '';
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
			saveError = $LL.admin_tenants_name_required();
			return;
		}
		saving = true;
		saveError = '';
		try {
			const payload: UpdateTenantRequest = {
				name: editName.trim(),
				tenant_code: editTenantCode.trim(),
				description: editDescription.trim() || null
			};
			const updated = await adminTenantsAPI.update(tenant.id, payload);
			tenantStore.update(updated);
			tenant = updated;
			isEditing = false;
		} catch (err) {
			saveError = err instanceof Error ? err.message : $LL.admin_tenants_save_failed();
		} finally {
			saving = false;
		}
	}

	function lifecycleActionLabel(command: TenantLifecycleCommand): string {
		switch (command) {
			case 'suspend':
				return $LL.admin_tenants_lifecycle_suspend();
			case 'resume':
				return $LL.admin_tenants_lifecycle_resume();
			case 'freeze':
				return $LL.admin_tenants_lifecycle_freeze();
			case 'unfreeze':
				return $LL.admin_tenants_lifecycle_unfreeze();
			case 'restore-validate':
				return $LL.admin_tenants_lifecycle_restore_validate();
		}
	}

	function selectLifecycleCommand(command: TenantLifecycleCommand) {
		lifecycleCommand = command;
		lifecycleReason = '';
		lifecycleConfirmInput = '';
		lifecycleError = '';
		lifecycleResult = '';
	}

	async function handleLifecycleCommand() {
		if (!tenant || !lifecycleCommand || lifecycleSubmitting) return;
		if (lifecycleReason.trim().length < 3) {
			lifecycleError = $LL.admin_tenants_lifecycle_reason_required();
			return;
		}
		if (lifecycleConfirmInput !== tenant.id) {
			lifecycleError = $LL.admin_tenants_lifecycle_confirm_mismatch();
			return;
		}

		lifecycleSubmitting = true;
		lifecycleError = '';
		try {
			const result = await adminTenantsAPI.lifecycleCommand(tenant.id, lifecycleCommand, {
				expected_state: tenant.lifecycle_state,
				expected_updated_at: tenant.updated_at,
				reason: lifecycleReason.trim()
			});
			lifecycleResult = result.validation_required
				? $LL.admin_tenants_lifecycle_validation_queued({ jobId: result.job_id })
				: $LL.admin_tenants_lifecycle_completed();
			lifecycleCommand = null;
			await loadTenant();
			await loadLifecycleJobs();
			if (tenant) tenantStore.update(tenant);
		} catch (err) {
			lifecycleError =
				err instanceof Error ? err.message : $LL.admin_tenants_lifecycle_action_failed();
		} finally {
			lifecycleSubmitting = false;
		}
	}

	async function retryLifecycleJob(jobId: string) {
		if (lifecycleRetryingId) return;
		lifecycleRetryingId = jobId;
		lifecycleError = '';
		try {
			await adminTenantsAPI.retryLifecycleJob(tenantId, jobId);
			await loadLifecycleJobs();
		} catch (err) {
			lifecycleError =
				err instanceof Error ? err.message : $LL.admin_tenants_lifecycle_retry_failed();
		} finally {
			lifecycleRetryingId = null;
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
			deleteError = $LL.admin_tenants_delete_id_mismatch();
			return;
		}
		deleting = true;
		deleteError = '';
		try {
			await adminTenantsAPI.delete(tenant.id);
			tenantStore.update({ ...tenant, lifecycle_state: 'deleting' });
			goto('/admin/tenants');
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_tenants_delete_failed();
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
			error = err instanceof Error ? err.message : $LL.admin_tenants_save_failed();
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
				err instanceof Error ? err.message : $LL.admin_tenants_cleanup_failed();
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
				err instanceof Error ? err.message : $LL.admin_tenants_retry_failed();
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
		if (!records) return $LL.admin_tenants_no_validation_records();
		return JSON.stringify(records, null, 2);
	}

	async function handleCreateVanityDomain() {
		const hostname = newVanityHostname.trim();
		if (!hostname) {
			vanityError = $LL.admin_tenants_hostname_required();
			return;
		}
		vanityCreating = true;
		vanityError = '';
		vanitySuccess = '';
		try {
			const response = await tenantVanityDomainsAPI.create(tenantId, hostname);
			newVanityHostname = '';
			vanitySuccess = response.manual_setup_required
				? $LL.admin_tenants_vanity_saved_manual()
				: response.cloudflare_error
					? $LL.admin_tenants_vanity_saved_cloudflare_error({
							error: response.cloudflare_error
						})
					: $LL.admin_tenants_vanity_created();
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : $LL.admin_tenants_vanity_create_failed();
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
			vanitySuccess = $LL.admin_tenants_vanity_refreshed();
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : $LL.admin_tenants_vanity_refresh_failed();
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
			vanitySuccess = $LL.admin_tenants_vanity_verified();
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : $LL.admin_tenants_vanity_verify_failed();
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
			vanitySuccess = $LL.admin_tenants_vanity_primary_updated();
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : $LL.admin_tenants_vanity_primary_failed();
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
			vanitySuccess = $LL.admin_tenants_vanity_deleted();
			await loadVanityDomains();
		} catch (err) {
			vanityError = err instanceof Error ? err.message : $LL.admin_tenants_vanity_delete_failed();
		} finally {
			vanityDeletingId = null;
		}
	}

	function lifecycleLabel(state: string): string {
		switch (state) {
			case 'active':
				return $LL.admin_tenants_active();
			case 'suspended':
				return $LL.admin_tenants_suspended();
			case 'frozen':
				return $LL.admin_tenants_frozen();
			case 'migration_read_only':
				return $LL.admin_tenants_migration_read_only();
			case 'provisioning':
				return $LL.admin_tenants_provisioning();
			case 'deleting':
				return $LL.admin_tenants_deleting();
			case 'deleted':
				return $LL.admin_tenants_deleted();
			case 'restore_pending':
				return $LL.admin_tenants_restore_pending();
			case 'restore_validating':
				return $LL.admin_tenants_restore_validating();
			default:
				return state;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_tenants_detail_head_title({ name: tenant?.name ?? tenantId })}</title>
</svelte:head>

<AdminPageShell width="narrow">
	<div class="tenant-detail-stack">
		{#if loading}
			<div class="loading-state">
				<i class="i-ph-circle-notch animate-spin"></i>
				{$LL.admin_tenants_loading_tenant()}
			</div>
		{:else if error && !tenant}
			<div class="alert alert-error">
				<i class="i-ph-warning-circle"></i>
				{error}
			</div>
		{:else if tenant}
			{@const currentTenant = tenant}
			{#snippet titleAccessory()}
				<div class="status-row">
					{#if provisioningFailed}
						<span class="badge badge-error">{$LL.admin_tenants_provisioning_failed()}</span>
					{:else if currentTenant.lifecycle_state === 'active'}
						<span class="badge badge-active">{$LL.admin_tenants_active()}</span>
					{:else}
						<span class="badge badge-inactive">{lifecycleLabel(currentTenant.lifecycle_state)}</span
						>
					{/if}
					{#if currentTenant.is_default}
						<span class="default-badge">
							<i class="i-ph-star-fill"></i>
							{$LL.admin_tenants_default_tenant()}
						</span>
					{/if}
				</div>
			{/snippet}

			{#snippet actions()}
				<div class="tenant-detail-actions">
					{#if !currentTenant.is_default && tenantOperational}
						<button
							class="btn btn-secondary"
							onclick={handleSetDefault}
							disabled={!!settingDefault}
							title={$LL.admin_tenants_set_default_title()}
						>
							{#if settingDefault}
								<i class="i-ph-circle-notch animate-spin"></i>
							{:else}
								<i class="i-ph-star"></i>
							{/if}
							{$LL.admin_tenants_set_default()}
						</button>
					{/if}
					{#if !isEditing && tenantOperational}
						<button class="btn btn-primary" onclick={startEdit}>
							<i class="i-ph-pencil"></i>
							{$LL.admin_tenants_edit()}
						</button>
					{/if}
				</div>
			{/snippet}

			<AdminPageHeader
				title={currentTenant.name}
				eyebrow={currentTenant.id}
				description={currentTenant.description ?? undefined}
				{titleAccessory}
				{actions}
			/>

			{#if error}
				<div class="alert alert-error">
					<i class="i-ph-warning-circle"></i>
					{error}
				</div>
			{/if}

			{#if provisioningFailed || tenant.lifecycle_state !== 'active'}
				<section class="card status-card">
					<div class="status-card-header">
						<i class={provisioningFailed ? 'i-ph-warning-circle' : 'i-ph-pause-circle'}></i>
						<div>
							<h2 class="card-title">
								{provisioningFailed
									? $LL.admin_tenants_provisioning_failed()
									: $LL.admin_tenants_provisioning_inactive_title()}
							</h2>
							<p class="card-description">
								{provisioningFailed
									? $LL.admin_tenants_provisioning_failed_description()
									: $LL.admin_tenants_provisioning_inactive_description()}
							</p>
						</div>
					</div>
					{#if provisioningDraftState.showActions}
						<dl class="detail-grid compact-details">
							<div class="detail-row">
								<dt>{$LL.admin_tenants_slot()}</dt>
								<dd class="mono">{provisioningDraftState.slot}</dd>
							</div>
							<div class="detail-row">
								<dt>{$LL.admin_tenants_last_error()}</dt>
								<dd>{tenant.provisioning_error ?? $LL.admin_tenants_no_error_detail()}</dd>
							</div>
							{#if tenant.provisioning_updated_at}
								<div class="detail-row">
									<dt>{$LL.admin_tenants_updated()}</dt>
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
									{$LL.admin_tenants_retrying()}
								{:else}
									<i class="i-ph-arrows-clockwise"></i>
									{$LL.admin_tenants_retry()}
								{/if}
							</button>
							<button
								class="btn btn-danger-outline"
								onclick={handleCleanupProvisioning}
								disabled={cleanupProvisioning || retryProvisioning}
							>
								{#if cleanupProvisioning}
									<i class="i-ph-circle-notch animate-spin"></i>
									{$LL.admin_tenants_cleaning()}
								{:else}
									<i class="i-ph-trash"></i>
									{$LL.admin_tenants_cleanup_draft()}
								{/if}
							</button>
						</div>
					{/if}
				</section>
			{/if}

			<!-- Info Card (view mode) or Edit Form -->
			{#if isEditing}
				<section class="card">
					<h2 class="card-title">{$LL.admin_tenants_edit_title()}</h2>
					{#if saveError}
						<div class="alert alert-error">{saveError}</div>
					{/if}
					<div class="form-grid">
						<div class="form-group">
							<label for="edit-name" class="form-label"
								>{$LL.admin_tenants_name()} <span class="required">*</span></label
							>
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
								>{$LL.admin_tenants_tenant_code()} <span class="required">*</span></label
							>
							<input
								id="edit-code"
								type="text"
								class="form-input"
								bind:value={editTenantCode}
								placeholder={$LL.admin_tenants_discovery_code_placeholder()}
								maxlength="63"
							/>
							<p class="field-hint">{$LL.admin_tenants_code_edit_hint()}</p>
						</div>
						<div class="form-group form-group-full">
							<label for="edit-description" class="form-label"
								>{$LL.admin_tenants_description_label()}</label
							>
							<textarea
								id="edit-description"
								class="form-input"
								bind:value={editDescription}
								rows="3"
								maxlength="500"
							></textarea>
						</div>
					</div>
					<div class="form-actions">
						<button class="btn btn-secondary" onclick={cancelEdit} disabled={saving}
							>{$LL.admin_tenants_cancel()}</button
						>
						<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
							{#if saving}<i class="i-ph-circle-notch animate-spin"></i>
								{$LL.admin_tenants_saving()}{:else}{$LL.admin_tenants_save_changes()}{/if}
						</button>
					</div>
				</section>
			{:else}
				<section class="card">
					<h2 class="card-title">{$LL.admin_tenants_details_title()}</h2>
					<dl class="detail-grid">
						<div class="detail-row">
							<dt>{$LL.admin_tenants_tenant_id()}</dt>
							<dd class="mono">{tenant.id}</dd>
						</div>
						<div class="detail-row">
							<dt>{$LL.admin_tenants_tenant_code()}</dt>
							<dd class="mono">{tenant.tenant_code}</dd>
						</div>
						<div class="detail-row">
							<dt>{$LL.admin_tenants_name()}</dt>
							<dd>{tenant.name}</dd>
						</div>
						<div class="detail-row">
							<dt>{$LL.admin_tenants_description_label()}</dt>
							<dd>{tenant.description ?? '—'}</dd>
						</div>
						<div class="detail-row">
							<dt>{$LL.admin_tenants_status()}</dt>
							<dd>
								{#if tenant.lifecycle_state === 'active'}
									<span class="badge badge-active">{$LL.admin_tenants_active()}</span>
								{:else}
									<span class="badge badge-inactive">{lifecycleLabel(tenant.lifecycle_state)}</span>
								{/if}
							</dd>
						</div>
						<div class="detail-row">
							<dt>{$LL.admin_tenants_default()}</dt>
							<dd>
								{#if tenant.is_default}
									<span class="badge badge-default"
										><i class="i-ph-star-fill"></i>{$LL.admin_tenants_yes()}</span
									>
								{:else}
									<span class="text-muted">{$LL.admin_tenants_no()}</span>
								{/if}
							</dd>
						</div>
						<div class="detail-row">
							<dt>{$LL.admin_tenants_created()}</dt>
							<dd>{new Date(tenant.created_at * 1000).toLocaleString()}</dd>
						</div>
						<div class="detail-row">
							<dt>{$LL.admin_tenants_updated()}</dt>
							<dd>{new Date(tenant.updated_at * 1000).toLocaleString()}</dd>
						</div>
					</dl>
				</section>
			{/if}

			<section class="card">
				<h2 class="card-title">{$LL.admin_tenants_lifecycle_actions_title()}</h2>
				<p class="card-description">{$LL.admin_tenants_lifecycle_actions_description()}</p>
				{#if lifecycleResult}<div class="alert alert-success">{lifecycleResult}</div>{/if}
				{#if lifecycleError}<div class="alert alert-error">{lifecycleError}</div>{/if}
				{#if lifecycleActions.length === 0}
					<p class="field-hint">{$LL.admin_tenants_lifecycle_no_actions()}</p>
				{:else}
					<div class="form-actions">
						{#each lifecycleActions as command}
							<button
								class={command === 'freeze' || command === 'suspend'
									? 'btn btn-danger-outline'
									: 'btn btn-secondary'}
								onclick={() => selectLifecycleCommand(command)}
								disabled={lifecycleSubmitting}
							>
								{lifecycleActionLabel(command)}
							</button>
						{/each}
					</div>
				{/if}

				{#if lifecycleCommand}
					<div class="form-grid lifecycle-command-form">
						<div class="form-group form-group-full">
							<label for="lifecycle-reason" class="form-label"
								>{$LL.admin_tenants_lifecycle_reason()}</label
							>
							<textarea
								id="lifecycle-reason"
								class="form-input"
								bind:value={lifecycleReason}
								rows="3"
							></textarea>
						</div>
						<div class="form-group form-group-full">
							<label for="lifecycle-confirm" class="form-label"
								>{$LL.admin_tenants_lifecycle_confirm({ tenantId: tenant.id })}</label
							>
							<input id="lifecycle-confirm" class="form-input" bind:value={lifecycleConfirmInput} />
						</div>
					</div>
					<div class="form-actions">
						<button
							class="btn btn-secondary"
							onclick={() => (lifecycleCommand = null)}
							disabled={lifecycleSubmitting}>{$LL.admin_tenants_cancel()}</button
						>
						<button
							class="btn btn-primary"
							onclick={handleLifecycleCommand}
							disabled={lifecycleSubmitting}
						>
							{#if lifecycleSubmitting}<i class="i-ph-circle-notch animate-spin"></i>{/if}
							{lifecycleActionLabel(lifecycleCommand)}
						</button>
					</div>
				{/if}

				<h3 class="subsection-title">{$LL.admin_tenants_lifecycle_history()}</h3>
				{#if lifecycleJobsLoading}
					<p class="field-hint">{$LL.admin_tenants_loading()}</p>
				{:else if lifecycleJobs.length === 0}
					<p class="field-hint">{$LL.admin_tenants_lifecycle_history_empty()}</p>
				{:else}
					<div class="lifecycle-history">
						{#each lifecycleJobs as job}
							<article class="lifecycle-job">
								<div class="card-header-row">
									<div>
										<strong>{job.config?.command ?? 'lifecycle validation'}</strong>
										<span class="badge badge-inactive">{job.status}</span>
										<p class="field-hint">{job.config?.reason ?? '—'}</p>
									</div>
									{#if job.status === 'failed' || job.status === 'partial_failure'}
										<button
											class="btn btn-secondary"
											onclick={() => retryLifecycleJob(job.id)}
											disabled={Boolean(lifecycleRetryingId)}
										>
											{$LL.admin_tenants_lifecycle_retry()}
										</button>
									{/if}
								</div>
								{#if job.error_message}<div class="alert alert-error">{job.error_message}</div>{/if}
								{#if job.progress?.checks?.length}
									<ul class="lifecycle-checks">
										{#each job.progress.checks as check}
											<li>
												<strong>{check.id}</strong>: {check.status}
												{#if check.evidence}<span> — {check.evidence}</span>{/if}
											</li>
										{/each}
									</ul>
								{/if}
								<p class="field-hint">
									{new Date(job.created_at * 1000).toLocaleString()} · {job.attempt_count ??
										0}/{job.max_attempts ?? 3}
								</p>
							</article>
						{/each}
					</div>
				{/if}
			</section>

			{#if !singleTenantMode && tenantOperational}
				<!-- Vanity Domains -->
				<section class="card">
					<div class="card-header-row">
						<div>
							<h2 class="card-title">{$LL.admin_tenants_vanity_title()}</h2>
							<p class="card-description">
								{$LL.admin_tenants_vanity_description()}
							</p>
						</div>
						<button class="btn btn-secondary" onclick={loadVanityDomains} disabled={vanityLoading}>
							{#if vanityLoading}
								<i class="i-ph-circle-notch animate-spin"></i>
								{$LL.admin_tenants_refreshing()}
							{:else}
								<i class="i-ph-arrows-clockwise"></i>
								{$LL.admin_tenants_refresh()}
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
							{$LL.admin_tenants_cloudflare_warning()}
						</div>
					{/if}

					<div class="vanity-create-row">
						<div class="form-group vanity-host-input">
							<label for="vanity-hostname" class="form-label">{$LL.admin_tenants_hostname()}</label>
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
								{$LL.admin_tenants_adding()}
							{:else}
								{$LL.admin_tenants_add_domain()}
							{/if}
						</button>
					</div>

					{#if vanityLoading}
						<div class="loading-inline">
							<i class="i-ph-circle-notch animate-spin"></i>
							{$LL.admin_tenants_loading_short()}
						</div>
					{:else if vanityDomains.length === 0}
						<p class="empty-text">{$LL.admin_tenants_no_vanity_domains()}</p>
					{:else}
						<div class="vanity-domain-list">
							{#each vanityDomains as domain (domain.id)}
								<div class="vanity-domain-row">
									<div class="vanity-domain-main">
										<div class="vanity-host-line">
											<span class="mono">{domain.hostname}</span>
											{#if domain.is_primary}
												<span class="badge badge-default">{$LL.admin_tenants_primary()}</span>
											{/if}
											<span class:badge-active={domain.status === 'active'} class="badge">
												{domain.status}
											</span>
										</div>
										<div class="vanity-meta">
											<span>{$LL.admin_tenants_ssl()}: {domain.ssl_status ?? 'pending'}</span>
											<span
												>{$LL.admin_tenants_ownership()}: {domain.ownership_status ??
													'pending'}</span
											>
											{#if domain.last_sync_at}
												<span
													>{$LL.admin_tenants_synced()}: {new Date(
														domain.last_sync_at * 1000
													).toLocaleString()}</span
												>
											{/if}
										</div>
										<details class="validation-details">
											<summary>{$LL.admin_tenants_validation_records()}</summary>
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
											{$LL.admin_tenants_sync()}
										</button>
										<button
											class="btn btn-secondary"
											onclick={() => handleSetPrimaryVanityDomain(domain.id)}
											disabled={domain.is_primary ||
												domain.status !== 'active' ||
												vanityPrimaryId === domain.id}
											title={domain.status !== 'active'
												? $LL.admin_tenants_primary_title_inactive()
												: $LL.admin_tenants_primary_title_active()}
										>
											{$LL.admin_tenants_primary()}
										</button>
										{#if domain.status !== 'active'}
											<button
												class="btn btn-secondary"
												onclick={() => handleVerifyVanityDomain(domain.id)}
												disabled={vanityVerifyingId === domain.id}
											>
												{$LL.admin_tenants_verify()}
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
											{$LL.admin_tenants_delete()}
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
							<h2 class="card-title">{$LL.admin_tenants_login_entry_title()}</h2>
							<p class="card-description">
								{$LL.admin_tenants_login_entry_description()}
							</p>
						</div>
						<a class="btn btn-secondary" href="/admin/tenant-discovery"
							>{$LL.admin_tenants_open_tenant_discovery()}</a
						>
					</div>

					{#if settingsLoading}
						<div class="loading-inline">
							<i class="i-ph-circle-notch animate-spin"></i>
							{$LL.admin_tenants_loading_short()}
						</div>
					{:else if settingsError}
						<div class="alert alert-error">{settingsError}</div>
					{:else if settingsMeta && settings}
						<div class="settings-summary">
							<div class="setting-summary-item">
								<span class="setting-label">{$LL.admin_tenants_entry_mode()}</span>
								<span>{String(getSettingValue('login-entry.mode'))}</span>
							</div>
							<div class="setting-summary-item">
								<span class="setting-label">{$LL.admin_tenants_selection_policy()}</span>
								<span>{String(getSettingValue('login-entry.selection_policy'))}</span>
							</div>
							<div class="setting-summary-item">
								<span class="setting-label">{$LL.admin_tenants_discovery_methods()}</span>
								<span>{String(getSettingValue('login-entry.discovery_methods'))}</span>
							</div>
						</div>
					{/if}
				</section>
			{/if}

			<!-- Danger Zone -->
			{#if tenantOperational && !tenant.is_default}
				<section class="card card-danger">
					<h2 class="card-title danger-title">{$LL.admin_tenants_danger_zone()}</h2>
					{#if !showDeleteConfirm}
						<div class="danger-row">
							<div>
								<p class="danger-label">{$LL.admin_tenants_delete_tenant()}</p>
								<p class="danger-desc">
									{$LL.admin_tenants_delete_description()}
								</p>
							</div>
							<button class="btn btn-danger-outline" onclick={openDeleteConfirm}>
								<i class="i-ph-trash"></i>
								{$LL.admin_tenants_delete_tenant()}
							</button>
						</div>
					{:else}
						<div class="delete-confirm-area">
							{#if deleteError}
								<div class="alert alert-error">{deleteError}</div>
							{/if}
							<div class="alert alert-warning">
								<i class="i-ph-warning"></i>
								{$LL.admin_tenants_delete_warning({ id: tenant.id })}
							</div>
							<div class="form-group">
								<label for="delete-confirm" class="form-label">
									{$LL.admin_tenants_delete_confirm_label({ id: tenant.id })}
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
									>{$LL.admin_tenants_cancel()}</button
								>
								<button
									class="btn btn-danger"
									onclick={handleDelete}
									disabled={deleting || deleteConfirmInput !== tenant.id}
								>
									{#if deleting}<i class="i-ph-circle-notch animate-spin"></i>
										{$LL.admin_tenants_deleting_progress()}{:else}{$LL.admin_tenants_delete_tenant()}{/if}
								</button>
							</div>
						</div>
					{/if}
				</section>
			{/if}
		{/if}
	</div>
</AdminPageShell>

<style>
	.tenant-detail-stack {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.tenant-detail-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: flex-end;
		flex-wrap: wrap;
		flex-shrink: 0;
	}

	.status-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.default-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.default-badge :global(i) {
		width: 14px;
		height: 14px;
	}

	/* Card */
	.card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 20px 24px;
	}

	.card-danger {
		border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-border));
	}

	.subsection-title {
		margin: 24px 0 12px;
		font-size: 0.95rem;
	}

	.lifecycle-history {
		display: grid;
		gap: 12px;
	}

	.lifecycle-job {
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
	}

	.lifecycle-checks {
		margin: 10px 0;
		padding-left: 20px;
		font-size: 0.82rem;
		color: var(--color-text-muted);
	}

	.status-card {
		border-color: color-mix(in srgb, var(--color-danger) 28%, var(--color-border));
	}

	.status-card-header {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.status-card-header :global(i) {
		width: 22px;
		height: 22px;
		color: var(--color-danger);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.compact-details {
		margin-top: 16px;
	}

	.card-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text);
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
		color: var(--color-text-muted);
		margin: 0;
	}

	.danger-title {
		color: var(--color-danger);
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
		border-bottom: 1px solid var(--color-border);
	}

	.detail-row:last-child {
		border-bottom: none;
	}

	.detail-row dt {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		font-weight: 500;
	}

	.detail-row dd {
		font-size: 0.875rem;
		color: var(--color-text);
		margin: 0;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.text-muted {
		color: var(--color-text-muted);
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
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.badge-inactive {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.badge-error {
		background: color-mix(in srgb, var(--color-danger) 14%, transparent);
		color: var(--color-danger);
	}

	.badge-default {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
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
		color: var(--color-text);
	}

	.required {
		color: var(--color-danger);
	}

	.form-input {
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.875rem;
		font-family: var(--font-body);
		outline: none;
		width: 100%;
		box-sizing: border-box;
		transition: border-color var(--transition-fast);
	}

	.form-input:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.field-hint {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		margin: 0;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	/* Settings */
	.loading-inline {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--color-text-muted);
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
		color: var(--color-text);
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
		border-top: 1px solid var(--color-border);
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
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}

	.validation-details summary {
		cursor: pointer;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
	}

	.validation-details pre {
		overflow: auto;
		max-height: 220px;
		margin: 8px 0 0;
		padding: 12px;
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
		color: var(--color-text);
		font-size: 0.75rem;
	}

	.vanity-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.empty-text {
		color: var(--color-text-muted);
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
		color: var(--color-text);
		margin: 0 0 4px;
	}

	.danger-desc {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
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
		border-radius: var(--radius-control);
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
		background: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.btn-primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-accent) 88%, var(--color-text));
	}

	.btn-secondary {
		background: var(--color-surface-muted);
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--color-surface);
	}

	.btn-danger {
		background: var(--color-danger);
		color: var(--color-accent-contrast);
	}

	.btn-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger) 88%, var(--color-text));
	}

	.btn-danger-outline {
		background: transparent;
		color: var(--color-danger);
		border: 1px solid var(--color-danger);
	}

	.btn-danger-outline:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
	}

	/* Alerts */
	.alert {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 16px;
		border-radius: var(--radius-control);
		font-size: 0.875rem;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		color: var(--color-danger);
		border: 1px solid color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
	}

	.alert-warning {
		background: color-mix(in srgb, var(--color-warning) 14%, var(--color-surface));
		color: var(--color-warning);
		border: 1px solid color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
	}

	.alert-success {
		background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface));
		color: var(--color-success);
		border: 1px solid color-mix(in srgb, var(--color-success) 42%, var(--color-border));
	}

	/* Loading */
	.loading-state {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--color-text-muted);
		padding: 48px 0;
		font-size: 0.875rem;
	}

	.loading-state :global(i) {
		width: 20px;
		height: 20px;
	}

	@media (max-width: 640px) {
		.card {
			padding: 18px;
		}

		.card-header-row {
			align-items: stretch;
			flex-direction: column;
		}

		.card-header-row .btn {
			justify-content: center;
			width: 100%;
		}

		.tenant-detail-actions {
			justify-content: flex-start;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}

		.form-actions,
		.delete-actions {
			align-items: stretch;
			flex-direction: column;
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

		.vanity-actions .btn,
		.vanity-create-row .btn {
			justify-content: center;
			width: 100%;
		}
	}
</style>

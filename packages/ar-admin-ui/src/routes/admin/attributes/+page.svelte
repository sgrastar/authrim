<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminAttributesAPI,
		type UserAttribute,
		type AttributeStats,
		type AttributeSourceType,
		isAttributeExpired
	} from '$lib/api/admin-attributes';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { Modal, ToggleSwitch } from '$lib/components';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	// State
	let attributes: UserAttribute[] = $state([]);
	let stats: AttributeStats | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// ABAC Feature Flag state
	let abacEnabled = $state(false);
	let abacLoading = $state(true);
	let abacError = $state('');
	let abacSaving = $state(false);
	let featureFlagsVersion = $state('');
	let pagination = $state({
		page: 1,
		limit: 20,
		total: 0,
		total_pages: 0
	});

	// Filters
	let filterUserId = $state('');
	let filterAttributeName = $state('');
	let filterSourceType = $state<AttributeSourceType | ''>('');
	let filterSearch = $state('');
	let includeExpired = $state(false);

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let createForm = $state({
		user_id: '',
		attribute_name: '',
		attribute_value: '',
		has_expiry: false,
		expires_at: ''
	});

	// Delete dialog state
	let showDeleteDialog = $state(false);
	let attributeToDelete: UserAttribute | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	// Cleanup dialog state
	let showCleanupDialog = $state(false);
	let cleaningUp = $state(false);
	let cleanupError = $state('');
	let cleanupResult: { deleted_count: number } | null = $state(null);
	let loadedTenantId = $state('');

	async function loadAttributes() {
		loading = true;
		error = '';

		try {
			const response = await adminAttributesAPI.listAttributes({
				page: pagination.page,
				limit: pagination.limit,
				user_id: filterUserId || undefined,
				attribute_name: filterAttributeName || undefined,
				source_type: filterSourceType || undefined,
				include_expired: includeExpired,
				search: filterSearch || undefined
			});

			attributes = response.attributes;
			pagination = response.pagination;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_attributes_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadStats() {
		try {
			stats = await adminAttributesAPI.getStats();
		} catch {
			stats = null;
		}
	}

	function applyFilters() {
		pagination.page = 1;
		loadAttributes();
	}

	function clearFilters() {
		filterUserId = '';
		filterAttributeName = '';
		filterSourceType = '';
		filterSearch = '';
		includeExpired = false;
		pagination.page = 1;
		loadAttributes();
	}

	function goToPage(newPage: number) {
		if (newPage < 1 || newPage > pagination.total_pages) return;
		pagination.page = newPage;
		loadAttributes();
	}

	function openCreateDialog() {
		createForm = {
			user_id: filterUserId || '',
			attribute_name: '',
			attribute_value: '',
			has_expiry: false,
			expires_at: ''
		};
		createError = '';
		showCreateDialog = true;
	}

	async function submitCreate() {
		if (!createForm.user_id || !createForm.attribute_name) {
			createError = $LL.admin_attributes_user_and_name_required();
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminAttributesAPI.createAttribute({
				user_id: createForm.user_id,
				attribute_name: createForm.attribute_name,
				attribute_value: createForm.attribute_value,
				expires_at:
					createForm.has_expiry && createForm.expires_at
						? Math.floor(new Date(createForm.expires_at).getTime() / 1000)
						: undefined
			});

			showCreateDialog = false;
			loadAttributes();
			loadStats();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_attributes_create_failed();
		} finally {
			creating = false;
		}
	}

	function openDeleteDialog(attr: UserAttribute, event: Event) {
		event.stopPropagation();
		attributeToDelete = attr;
		deleteError = '';
		showDeleteDialog = true;
	}

	async function confirmDelete() {
		if (!attributeToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminAttributesAPI.deleteAttribute(attributeToDelete.id);
			showDeleteDialog = false;
			attributeToDelete = null;
			loadAttributes();
			loadStats();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_attributes_delete_failed();
		} finally {
			deleting = false;
		}
	}

	async function cleanupExpired() {
		cleaningUp = true;
		cleanupError = '';
		cleanupResult = null;

		try {
			cleanupResult = await adminAttributesAPI.deleteExpiredAttributes();
			loadAttributes();
			loadStats();
		} catch (err) {
			cleanupError = err instanceof Error ? err.message : $LL.admin_attributes_cleanup_failed();
		} finally {
			cleaningUp = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function getSourceBadgeClass(sourceType: string): string {
		switch (sourceType) {
			case 'vc':
				return 'badge badge-success';
			case 'saml':
				return 'badge badge-info';
			case 'manual':
				return 'badge badge-neutral';
			default:
				return 'badge badge-neutral';
		}
	}

	function formatSourceType(sourceType: AttributeSourceType): string {
		switch (sourceType) {
			case 'vc':
				return $LL.admin_attributes_source_vc();
			case 'saml':
				return $LL.admin_attributes_source_saml();
			case 'manual':
				return $LL.admin_attributes_source_manual();
			default:
				return sourceType;
		}
	}

	function formatExpirationStatusLocalized(expiresAt: number | null): string {
		if (!expiresAt) return $LL.admin_attributes_never_expires();
		const now = Date.now();
		const expiresAtMs = expiresAt * 1000;
		if (expiresAtMs < now) {
			return $LL.admin_attributes_expired();
		}
		const daysUntil = Math.ceil((expiresAtMs - now) / (1000 * 60 * 60 * 24));
		if (daysUntil <= 7) {
			return daysUntil === 1
				? $LL.admin_attributes_expires_in_one_day()
				: $LL.admin_attributes_expires_in_days({ count: daysUntil });
		}
		return new Date(expiresAtMs).toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	async function loadAbacStatus() {
		abacLoading = true;
		abacError = '';

		try {
			const settings = await adminSettingsAPI.getSettings('feature-flags');
			abacEnabled = settings.values['feature.enable_abac'] === true;
			featureFlagsVersion = settings.version;
		} catch (err) {
			abacError = err instanceof Error ? err.message : $LL.admin_attributes_abac_load_failed();
		} finally {
			abacLoading = false;
		}
	}

	async function toggleAbac() {
		if (abacSaving) return;

		abacSaving = true;
		abacError = '';

		try {
			if (!featureFlagsVersion) {
				const settings = await adminSettingsAPI.getSettings('feature-flags');
				featureFlagsVersion = settings.version;
				abacEnabled = settings.values['feature.enable_abac'] === true;
			}

			const newValue = !abacEnabled;
			const result = await adminSettingsAPI.updateSettings('feature-flags', {
				ifMatch: featureFlagsVersion,
				set: { 'feature.enable_abac': newValue }
			});
			abacEnabled = newValue;
			featureFlagsVersion = result.version;
		} catch (err) {
			abacError = err instanceof Error ? err.message : $LL.admin_attributes_abac_update_failed();
			await loadAbacStatus();
		} finally {
			abacSaving = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		pagination.page = 1;
		loadAbacStatus();
		loadAttributes();
		loadStats();
	});
</script>

<svelte:head>
	<title>{$LL.admin_attributes_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Info Banner -->
	<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
		<div class="flex items-start">
			<span class="i-ph-info text-blue-600 text-xl mr-3 mt-0.5"></span>
			<div>
				<h3 class="font-semibold text-blue-900 mb-1">{$LL.admin_attributes_info_title()}</h3>
				<p class="text-sm text-blue-800">
					{$LL.admin_attributes_info_prefix()}
					<strong>End Users</strong>{$LL.admin_attributes_info_middle()}
					<strong>Admin Operator</strong>
					{$LL.admin_attributes_info_suffix()}
					<a href="/admin/admin-abac" class="underline hover:text-blue-900">Admin ABAC</a>.
				</p>
			</div>
		</div>
	</div>

	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_attributes_title()}</h1>
			<p class="page-description">
				{$LL.admin_attributes_description()}
			</p>
		</div>
		<div class="page-actions">
			<button
				class="btn btn-secondary"
				onclick={() => (showCleanupDialog = true)}
				disabled={!abacEnabled}
			>
				<i class="i-ph-trash"></i>
				{$LL.admin_attributes_cleanup_expired()}
			</button>
			<button class="btn btn-primary" onclick={openCreateDialog} disabled={!abacEnabled}>
				<i class="i-ph-plus"></i>
				{$LL.admin_attributes_add_attribute()}
			</button>
		</div>
	</div>

	<!-- ABAC Feature Flag Toggle -->
	<div class="panel feature-toggle-panel">
		<div class="feature-toggle-row">
			<div class="feature-toggle-info">
				<h3 class="feature-toggle-title">{$LL.admin_attributes_abac_engine()}</h3>
				<p class="feature-toggle-description">
					{$LL.admin_attributes_abac_description()}
				</p>
			</div>
			<div class="feature-toggle-control">
				{#if abacLoading}
					<span class="loading-text">{$LL.admin_attributes_loading()}</span>
				{:else}
					<ToggleSwitch checked={abacEnabled} disabled={abacSaving} onchange={toggleAbac} />
				{/if}
			</div>
		</div>
		{#if abacError}
			<div class="alert alert-error alert-sm">{abacError}</div>
		{/if}
		{#if abacSaving}
			<div class="saving-indicator">{$LL.admin_attributes_saving()}</div>
		{/if}
	</div>

	{#if !abacEnabled && !abacLoading}
		<div class="alert alert-warning">
			<strong>{$LL.admin_attributes_abac_disabled_title()}</strong>
			{$LL.admin_attributes_abac_disabled_description()}
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadAttributes}
				>{$LL.admin_attributes_retry()}</button
			>
		</div>
	{/if}

	<!-- Stats Cards -->
	{#if stats}
		<div class="stats-grid">
			<div class="stat-card">
				<span class="stat-value">{stats.total}</span>
				<span class="stat-label">{$LL.admin_attributes_total_attributes()}</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.active}</span>
				<span class="stat-label">{$LL.admin_attributes_active()}</span>
			</div>
			<div class="stat-card stat-card-warning">
				<span class="stat-value">{stats.expired}</span>
				<span class="stat-label">{$LL.admin_attributes_expired()}</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.unique_users}</span>
				<span class="stat-label">{$LL.admin_attributes_users_with_attributes()}</span>
			</div>
		</div>

		<!-- Source Distribution -->
		{#if stats.by_source.length > 0}
			<div class="panel">
				<h3 class="panel-title">{$LL.admin_attributes_by_source()}</h3>
				<div class="distribution-bars">
					{#each stats.by_source as source (source.source_type)}
						<div class="distribution-item">
							<span class={getSourceBadgeClass(source.source_type)}>
								{formatSourceType(source.source_type as AttributeSourceType)}
							</span>
							<div class="bar-container">
								<div
									class="bar bar-{source.source_type}"
									style="width: {(source.count / stats.total) * 100}%"
								></div>
							</div>
							<span class="distribution-count">{source.count}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<input
					type="text"
					class="form-input"
					placeholder={$LL.admin_attributes_search_placeholder()}
					bind:value={filterSearch}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<input
					type="text"
					class="form-input"
					placeholder={$LL.admin_attributes_user_id()}
					bind:value={filterUserId}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<input
					type="text"
					class="form-input"
					placeholder={$LL.admin_attributes_attribute_name()}
					bind:value={filterAttributeName}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterSourceType} onchange={applyFilters}>
					<option value="">{$LL.admin_attributes_all_sources()}</option>
					<option value="vc">{$LL.admin_attributes_source_vc()}</option>
					<option value="saml">{$LL.admin_attributes_source_saml()}</option>
					<option value="manual">{$LL.admin_attributes_source_manual()}</option>
				</select>
			</div>
			<div class="form-group" style="min-width: 180px;">
				<ToggleSwitch
					bind:checked={includeExpired}
					label={$LL.admin_attributes_include_expired()}
					size="sm"
				/>
			</div>
			<div class="form-group">
				<button class="btn btn-primary" onclick={applyFilters}
					>{$LL.admin_attributes_apply()}</button
				>
				<button class="btn btn-secondary" onclick={clearFilters}
					>{$LL.admin_attributes_clear()}</button
				>
			</div>
		</div>
	</div>

	<!-- Attributes Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_attributes_loading()}</p>
		</div>
	{:else if attributes.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_attributes_empty()}</p>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_attributes_add_attribute()}</button
				>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_attributes_user()}</th>
						<th>{$LL.admin_attributes_attribute()}</th>
						<th>{$LL.admin_attributes_value()}</th>
						<th>{$LL.admin_attributes_source()}</th>
						<th>{$LL.admin_attributes_verified()}</th>
						<th>{$LL.admin_attributes_expiration()}</th>
						<th class="text-right">{$LL.admin_attributes_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each attributes as attr (attr.id)}
						<tr class:expired={isAttributeExpired(attr)}>
							<td>
								<div class="user-cell">
									<a href="/admin/users/{attr.user_id}" class="cell-link">
										{attr.user_email || attr.user_id}
									</a>
									{#if attr.user_name}
										<span class="cell-secondary">{attr.user_name}</span>
									{/if}
								</div>
							</td>
							<td>
								<code class="code-inline">{attr.attribute_name}</code>
							</td>
							<td class="truncate" title={attr.attribute_value}>
								{attr.attribute_value.length > 50
									? attr.attribute_value.substring(0, 50) + '...'
									: attr.attribute_value}
							</td>
							<td>
								<span class={getSourceBadgeClass(attr.source_type)}>
									{formatSourceType(attr.source_type as AttributeSourceType)}
								</span>
							</td>
							<td class="muted nowrap">{formatDate(attr.verified_at)}</td>
							<td>
								<span
									class:danger-text={isAttributeExpired(attr)}
									class:warning-text={attr.expires_at &&
										attr.expires_at * 1000 - Date.now() < 7 * 24 * 60 * 60 * 1000 &&
										!isAttributeExpired(attr)}
								>
									{formatExpirationStatusLocalized(attr.expires_at)}
								</span>
							</td>
							<td class="text-right">
								<button class="btn btn-danger btn-sm" onclick={(e) => openDeleteDialog(attr, e)}>
									{$LL.admin_attributes_delete()}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if pagination.total_pages > 1}
			<div class="pagination">
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page === 1}
					onclick={() => goToPage(pagination.page - 1)}
				>
					{$LL.admin_attributes_previous()}
				</button>
				<span class="pagination-info">
					{$LL.admin_attributes_page_of({
						page: pagination.page,
						totalPages: pagination.total_pages
					})}
					<span class="muted">{$LL.admin_attributes_total_count({ count: pagination.total })}</span>
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page === pagination.total_pages}
					onclick={() => goToPage(pagination.page + 1)}
				>
					{$LL.admin_attributes_next()}
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={() => (showCreateDialog = false)}
	title={$LL.admin_attributes_add_user_attribute()}
	size="md"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="form-group">
		<label for="user-id" class="form-label">{$LL.admin_attributes_user_id()}</label>
		<input
			id="user-id"
			type="text"
			class="form-input"
			bind:value={createForm.user_id}
			placeholder="user_123"
		/>
	</div>

	<div class="form-group">
		<label for="attr-name" class="form-label">{$LL.admin_attributes_attribute_name_title()}</label>
		<input
			id="attr-name"
			type="text"
			class="form-input"
			bind:value={createForm.attribute_name}
			placeholder="subscription_tier, verified_email, country..."
		/>
	</div>

	<div class="form-group">
		<label for="attr-value" class="form-label">{$LL.admin_attributes_attribute_value()}</label>
		<input
			id="attr-value"
			type="text"
			class="form-input"
			bind:value={createForm.attribute_value}
			placeholder="premium, true, US..."
		/>
	</div>

	<div class="form-group">
		<ToggleSwitch
			bind:checked={createForm.has_expiry}
			label={$LL.admin_attributes_set_expiration()}
			description={$LL.admin_attributes_set_expiration_description()}
		/>
	</div>

	{#if createForm.has_expiry}
		<div class="form-group">
			<label for="expires-at" class="form-label">{$LL.admin_attributes_expires_at()}</label>
			<input
				id="expires-at"
				type="datetime-local"
				class="form-input"
				bind:value={createForm.expires_at}
			/>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showCreateDialog = false)}>
			{$LL.admin_attributes_cancel()}
		</button>
		<button class="btn btn-primary" onclick={submitCreate} disabled={creating}>
			{creating ? $LL.admin_attributes_creating() : $LL.admin_attributes_create()}
		</button>
	{/snippet}
</Modal>

<!-- Delete Dialog -->
<Modal
	open={showDeleteDialog && !!attributeToDelete}
	onClose={() => (showDeleteDialog = false)}
	title={$LL.admin_attributes_delete_attribute()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	<p class="modal-description">
		{$LL.admin_attributes_delete_confirm_prefix()}
		<strong>{attributeToDelete?.attribute_name ?? ''}</strong>
		{$LL.admin_attributes_delete_confirm_middle()}
		<strong>{(attributeToDelete?.user_email || attributeToDelete?.user_id) ?? ''}</strong
		>{$LL.admin_attributes_delete_confirm_suffix()}
	</p>
	<p class="danger-text">{$LL.admin_attributes_cannot_be_undone()}</p>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}>
			{$LL.admin_attributes_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_attributes_deleting() : $LL.admin_attributes_delete()}
		</button>
	{/snippet}
</Modal>

<!-- Cleanup Dialog -->
<Modal
	open={showCleanupDialog}
	onClose={() => (showCleanupDialog = false)}
	title={$LL.admin_attributes_cleanup_expired_title()}
	size="md"
>
	{#if cleanupError}
		<div class="alert alert-error">{cleanupError}</div>
	{/if}

	{#if cleanupResult}
		<div class="alert alert-success">
			<p>
				{$LL.admin_attributes_cleanup_success_prefix()}
				<strong>{cleanupResult.deleted_count}</strong>
				{$LL.admin_attributes_cleanup_success_suffix()}
			</p>
		</div>
	{:else}
		<p class="modal-description">
			{$LL.admin_attributes_cleanup_description()}
			{#if stats}
				{$LL.admin_attributes_cleanup_current_prefix()}
				<strong>{stats.expired}</strong>
				{$LL.admin_attributes_cleanup_current_suffix()}
			{/if}
		</p>
		<p class="danger-text">{$LL.admin_attributes_cannot_be_undone()}</p>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showCleanupDialog = false)}>
			{$LL.admin_attributes_close()}
		</button>
		{#if !cleanupResult}
			<button class="btn btn-danger" onclick={cleanupExpired} disabled={cleaningUp}>
				{cleaningUp ? $LL.admin_attributes_cleaning_up() : $LL.admin_attributes_delete_expired()}
			</button>
		{/if}
	{/snippet}
</Modal>

<style>
	/* Feature Toggle Panel Styles */
	.feature-toggle-panel {
		margin-bottom: 1.5rem;
		padding: 1rem 1.25rem;
	}

	.feature-toggle-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.feature-toggle-info {
		flex: 1;
	}

	.feature-toggle-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.feature-toggle-description {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.feature-toggle-control {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.loading-text {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.saving-indicator {
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.alert-sm {
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	.alert-warning {
		background-color: rgba(234, 179, 8, 0.1);
		border: 1px solid rgba(234, 179, 8, 0.3);
		border-radius: 0.375rem;
		padding: 0.75rem 1rem;
		color: var(--text-primary);
		margin-bottom: 1rem;
	}
</style>

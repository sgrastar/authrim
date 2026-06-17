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
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminPagination from '$lib/components/admin/AdminPagination.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminToolbar from '$lib/components/admin/AdminToolbar.svelte';

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

{#snippet pageActions()}
	<button
		class="btn btn-secondary"
		onclick={() => (showCleanupDialog = true)}
		disabled={!abacEnabled}
	>
		<i class="i-ph-trash" aria-hidden="true"></i>
		{$LL.admin_attributes_cleanup_expired()}
	</button>
	<button class="btn btn-primary" onclick={openCreateDialog} disabled={!abacEnabled}>
		<i class="i-ph-plus" aria-hidden="true"></i>
		{$LL.admin_attributes_add_attribute()}
	</button>
{/snippet}

<AdminPageShell>
	<!-- Info Banner -->
	<div class="info-banner">
		<div class="info-banner__content">
			<span class="i-ph-info info-banner__icon" aria-hidden="true"></span>
			<div>
				<h3 class="info-banner__title">{$LL.admin_attributes_info_title()}</h3>
				<p class="info-banner__text">
					{$LL.admin_attributes_info_prefix()}
					<strong>End Users</strong>{$LL.admin_attributes_info_middle()}
					<strong>Admin Operator</strong>
					{$LL.admin_attributes_info_suffix()}
					<a href="/admin/admin-abac">Admin ABAC</a>.
				</p>
			</div>
		</div>
	</div>

	<!-- Page Header -->
	<AdminPageHeader
		title={$LL.admin_attributes_title()}
		description={$LL.admin_attributes_description()}
		actions={pageActions}
	/>

	<!-- ABAC Feature Flag Toggle -->
	<AdminSection>
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
	</AdminSection>

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
			<AdminSection title={$LL.admin_attributes_by_source()}>
				<div class="distribution-bars">
					{#each stats.by_source as source (source.source_type)}
						<div class="distribution-item">
							<span class={getSourceBadgeClass(source.source_type)}>
								{formatSourceType(source.source_type as AttributeSourceType)}
							</span>
							<progress
								class="distribution-progress distribution-progress--{source.source_type}"
								value={source.count}
								max={stats.total}
							>
								{source.count}
							</progress>
							<span class="distribution-count">{source.count}</span>
						</div>
					{/each}
				</div>
			</AdminSection>
		{/if}
	{/if}

	<!-- Filters -->
	<AdminSection>
		<AdminToolbar>
			<div class="admin-field admin-field--search">
				<label for="attribute-search" class="admin-field__label">
					{$LL.admin_attributes_search_placeholder()}
				</label>
				<input
					id="attribute-search"
					type="text"
					class="admin-input"
					placeholder={$LL.admin_attributes_search_placeholder()}
					bind:value={filterSearch}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="admin-field admin-field--compact">
				<label for="attribute-user-id" class="admin-field__label">
					{$LL.admin_attributes_user_id()}
				</label>
				<input
					id="attribute-user-id"
					type="text"
					class="admin-input"
					placeholder={$LL.admin_attributes_user_id()}
					bind:value={filterUserId}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="admin-field admin-field--compact">
				<label for="attribute-name-filter" class="admin-field__label">
					{$LL.admin_attributes_attribute_name()}
				</label>
				<input
					id="attribute-name-filter"
					type="text"
					class="admin-input"
					placeholder={$LL.admin_attributes_attribute_name()}
					bind:value={filterAttributeName}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="admin-field admin-field--compact">
				<label for="attribute-source-filter" class="admin-field__label">
					{$LL.admin_attributes_source()}
				</label>
				<select
					id="attribute-source-filter"
					class="admin-select"
					bind:value={filterSourceType}
					onchange={applyFilters}
				>
					<option value="">{$LL.admin_attributes_all_sources()}</option>
					<option value="vc">{$LL.admin_attributes_source_vc()}</option>
					<option value="saml">{$LL.admin_attributes_source_saml()}</option>
					<option value="manual">{$LL.admin_attributes_source_manual()}</option>
				</select>
			</div>
			<div class="admin-field admin-field--compact toggle-field">
				<ToggleSwitch
					bind:checked={includeExpired}
					label={$LL.admin_attributes_include_expired()}
					size="sm"
				/>
			</div>
			<div class="toolbar-actions">
				<button class="btn btn-primary" onclick={applyFilters}
					>{$LL.admin_attributes_apply()}</button
				>
				<button class="btn btn-secondary" onclick={clearFilters}
					>{$LL.admin_attributes_clear()}</button
				>
			</div>
		</AdminToolbar>
	</AdminSection>

	<!-- Attributes Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_attributes_loading()}</p>
		</div>
	{:else if attributes.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_attributes_empty()}</p>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_attributes_add_attribute()}</button
				>
			</div>
		</AdminSection>
	{:else}
		<AdminSection title={$LL.admin_attributes_title()}>
			<AdminDataTable width="xwide">
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
			</AdminDataTable>
		</AdminSection>

		<!-- Pagination -->
		{#if pagination.total_pages > 1}
			<AdminPagination
				label={$LL.admin_attributes_title()}
				info={`${$LL.admin_attributes_page_of({
					page: pagination.page,
					totalPages: pagination.total_pages
				})} · ${$LL.admin_attributes_total_count({ count: pagination.total })}`}
				previousLabel={$LL.admin_attributes_previous()}
				nextLabel={$LL.admin_attributes_next()}
				hasPrevious={pagination.page > 1}
				hasNext={pagination.page < pagination.total_pages}
				onPrevious={() => goToPage(pagination.page - 1)}
				onNext={() => goToPage(pagination.page + 1)}
			/>
		{/if}
	{/if}
</AdminPageShell>

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

	<div class="admin-field dialog-field">
		<label for="user-id" class="admin-field__label">{$LL.admin_attributes_user_id()}</label>
		<input
			id="user-id"
			type="text"
			class="admin-input"
			bind:value={createForm.user_id}
			placeholder="user_123"
		/>
	</div>

	<div class="admin-field dialog-field">
		<label for="attr-name" class="admin-field__label"
			>{$LL.admin_attributes_attribute_name_title()}</label
		>
		<input
			id="attr-name"
			type="text"
			class="admin-input"
			bind:value={createForm.attribute_name}
			placeholder="subscription_tier, verified_email, country..."
		/>
	</div>

	<div class="admin-field dialog-field">
		<label for="attr-value" class="admin-field__label"
			>{$LL.admin_attributes_attribute_value()}</label
		>
		<input
			id="attr-value"
			type="text"
			class="admin-input"
			bind:value={createForm.attribute_value}
			placeholder="premium, true, US..."
		/>
	</div>

	<div class="admin-field dialog-field">
		<ToggleSwitch
			bind:checked={createForm.has_expiry}
			label={$LL.admin_attributes_set_expiration()}
			description={$LL.admin_attributes_set_expiration_description()}
		/>
	</div>

	{#if createForm.has_expiry}
		<div class="admin-field dialog-field">
			<label for="expires-at" class="admin-field__label">{$LL.admin_attributes_expires_at()}</label>
			<input
				id="expires-at"
				type="datetime-local"
				class="admin-input"
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
	.info-banner {
		margin-bottom: 18px;
		border: 1px solid color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
		border-radius: var(--radius-panel);
		padding: 16px;
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
	}

	.info-banner__content {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.info-banner__icon {
		flex: 0 0 auto;
		color: var(--color-accent);
		font-size: 1.25rem;
	}

	.info-banner__title {
		margin: 0 0 4px;
		color: var(--color-text);
		font-size: 0.95rem;
		font-weight: 700;
	}

	.info-banner__text {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.88rem;
		line-height: 1.6;
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
		color: var(--color-text);
	}

	.feature-toggle-description {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.feature-toggle-control {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.loading-text {
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.saving-indicator {
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.alert-sm {
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	.alert-warning {
		background-color: color-mix(in srgb, var(--color-warning) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-warning) 32%, var(--color-border));
		border-radius: var(--radius-panel);
		padding: 0.75rem 1rem;
		color: var(--color-text);
		margin-bottom: 1rem;
	}

	.distribution-bars {
		display: grid;
		gap: 12px;
	}

	.distribution-item {
		display: grid;
		grid-template-columns: minmax(120px, auto) minmax(180px, 1fr) auto;
		align-items: center;
		gap: 12px;
	}

	.distribution-progress {
		width: 100%;
		height: 10px;
		overflow: hidden;
		border: 0;
		border-radius: 999px;
		background: var(--color-surface-raised);
	}

	.distribution-progress::-webkit-progress-bar {
		background: var(--color-surface-raised);
	}

	.distribution-progress::-webkit-progress-value {
		background: var(--color-accent);
		border-radius: 999px;
	}

	.distribution-progress::-moz-progress-bar {
		background: var(--color-accent);
		border-radius: 999px;
	}

	.distribution-progress--vc::-webkit-progress-value,
	.distribution-progress--vc::-moz-progress-bar {
		background: var(--color-success);
	}

	.distribution-progress--saml::-webkit-progress-value,
	.distribution-progress--saml::-moz-progress-bar {
		background: var(--color-info);
	}

	.distribution-count {
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 0.85rem;
	}

	.toggle-field {
		justify-content: end;
		min-width: 180px;
	}

	.toolbar-actions {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
	}

	.dialog-field {
		display: grid;
		gap: 6px;
		margin-bottom: 16px;
	}

	.dialog-field :global(.admin-field__label) {
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
		color: var(--color-text-subtle);
	}

	.dialog-field :global(.admin-input) {
		width: 100%;
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.dialog-field :global(.admin-input:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	@media (max-width: 720px) {
		.feature-toggle-row,
		.info-banner__content {
			align-items: flex-start;
			flex-direction: column;
		}

		.distribution-item {
			grid-template-columns: 1fr;
		}

		.toolbar-actions {
			width: 100%;
		}
	}
</style>

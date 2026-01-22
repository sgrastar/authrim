<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminAttributesAPI,
		type UserAttribute,
		type AttributeStats,
		type AttributeSourceType,
		getSourceTypeLabel,
		isAttributeExpired,
		formatExpirationStatus
	} from '$lib/api/admin-attributes';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';

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
	let cleanupResult: { deleted_count: number } | null = $state(null);

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
			console.error('Failed to load attributes:', err);
			error = err instanceof Error ? err.message : 'Failed to load attributes';
		} finally {
			loading = false;
		}
	}

	async function loadStats() {
		try {
			stats = await adminAttributesAPI.getStats();
		} catch (err) {
			console.error('Failed to load stats:', err);
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
			createError = 'User ID and attribute name are required';
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
			console.error('Failed to create attribute:', err);
			createError = err instanceof Error ? err.message : 'Failed to create attribute';
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
			console.error('Failed to delete attribute:', err);
			deleteError = err instanceof Error ? err.message : 'Failed to delete attribute';
		} finally {
			deleting = false;
		}
	}

	async function cleanupExpired() {
		cleaningUp = true;
		cleanupResult = null;

		try {
			cleanupResult = await adminAttributesAPI.deleteExpiredAttributes();
			loadAttributes();
			loadStats();
		} catch (err) {
			console.error('Failed to cleanup expired attributes:', err);
		} finally {
			cleaningUp = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleDateString('en-US', {
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

	async function loadAbacStatus() {
		abacLoading = true;
		abacError = '';

		try {
			const settings = await adminSettingsAPI.getSettings('feature-flags');
			abacEnabled = settings.values['feature.enable_abac'] === true;
			featureFlagsVersion = settings.version;
		} catch (err) {
			console.error('Failed to load ABAC status:', err);
			abacError = 'Failed to load ABAC status';
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
			featureFlagsVersion = result.newVersion;
		} catch (err) {
			console.error('Failed to update ABAC status:', err);
			abacError = err instanceof Error ? err.message : 'Failed to update ABAC status';
			await loadAbacStatus();
		} finally {
			abacSaving = false;
		}
	}

	onMount(() => {
		loadAbacStatus();
		loadAttributes();
		loadStats();
	});
</script>

<svelte:head>
	<title>Attribute-Based Access Control - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Attribute-Based Access Control</h1>
			<p class="page-description">
				Control access based on user attributes like subscription tier, location, or verified credentials.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={() => (showCleanupDialog = true)} disabled={!abacEnabled}>
				<i class="i-ph-trash"></i>
				Cleanup Expired
			</button>
			<button class="btn btn-primary" onclick={openCreateDialog} disabled={!abacEnabled}>
				<i class="i-ph-plus"></i>
				Add Attribute
			</button>
		</div>
	</div>

	<!-- ABAC Feature Flag Toggle -->
	<div class="panel feature-toggle-panel">
		<div class="feature-toggle-row">
			<div class="feature-toggle-info">
				<h3 class="feature-toggle-title">ABAC Engine</h3>
				<p class="feature-toggle-description">
					Enable Attribute-Based Access Control. When enabled, user attributes can be used in policy conditions.
				</p>
			</div>
			<div class="feature-toggle-control">
				{#if abacLoading}
					<span class="loading-text">Loading...</span>
				{:else}
					<ToggleSwitch
						checked={abacEnabled}
						disabled={abacSaving}
						onchange={toggleAbac}
					/>
				{/if}
			</div>
		</div>
		{#if abacError}
			<div class="alert alert-error alert-sm">{abacError}</div>
		{/if}
		{#if abacSaving}
			<div class="saving-indicator">Saving...</div>
		{/if}
	</div>

	{#if !abacEnabled && !abacLoading}
		<div class="alert alert-warning">
			<strong>ABAC is disabled.</strong> Enable it above to manage user attributes. When disabled, attribute-based conditions in policies will not be evaluated.
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadAttributes}>Retry</button>
		</div>
	{/if}

	<!-- Stats Cards -->
	{#if stats}
		<div class="stats-grid">
			<div class="stat-card">
				<span class="stat-value">{stats.total}</span>
				<span class="stat-label">Total Attributes</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.active}</span>
				<span class="stat-label">Active</span>
			</div>
			<div class="stat-card stat-card-warning">
				<span class="stat-value">{stats.expired}</span>
				<span class="stat-label">Expired</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.unique_users}</span>
				<span class="stat-label">Users with Attributes</span>
			</div>
		</div>

		<!-- Source Distribution -->
		{#if stats.by_source.length > 0}
			<div class="panel">
				<h3 class="panel-title">By Source</h3>
				<div class="distribution-bars">
					{#each stats.by_source as source (source.source_type)}
						<div class="distribution-item">
							<span class={getSourceBadgeClass(source.source_type)}>
								{getSourceTypeLabel(source.source_type as AttributeSourceType)}
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
					placeholder="Search..."
					bind:value={filterSearch}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<input
					type="text"
					class="form-input"
					placeholder="User ID"
					bind:value={filterUserId}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<input
					type="text"
					class="form-input"
					placeholder="Attribute name"
					bind:value={filterAttributeName}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterSourceType} onchange={applyFilters}>
					<option value="">All Sources</option>
					<option value="vc">Verifiable Credential</option>
					<option value="saml">SAML IdP</option>
					<option value="manual">Manual</option>
				</select>
			</div>
			<div class="form-group" style="min-width: 180px;">
				<ToggleSwitch bind:checked={includeExpired} label="Include expired" size="sm" />
			</div>
			<div class="form-group">
				<button class="btn btn-primary" onclick={applyFilters}>Apply</button>
				<button class="btn btn-secondary" onclick={clearFilters}>Clear</button>
			</div>
		</div>
	</div>

	<!-- Attributes Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if attributes.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No attributes found.</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>Add Attribute</button>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>User</th>
						<th>Attribute</th>
						<th>Value</th>
						<th>Source</th>
						<th>Verified</th>
						<th>Expiration</th>
						<th class="text-right">Actions</th>
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
									{getSourceTypeLabel(attr.source_type as AttributeSourceType)}
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
									{formatExpirationStatus(attr.expires_at)}
								</span>
							</td>
							<td class="text-right">
								<button class="btn btn-danger btn-sm" onclick={(e) => openDeleteDialog(attr, e)}>
									Delete
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
					Previous
				</button>
				<span class="pagination-info">
					Page {pagination.page} of {pagination.total_pages}
					<span class="muted">({pagination.total} total)</span>
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page === pagination.total_pages}
					onclick={() => goToPage(pagination.page + 1)}
				>
					Next
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Create Dialog -->
{#if showCreateDialog}
	<div
		class="modal-overlay"
		onclick={() => (showCreateDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showCreateDialog = false)}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Add User Attribute</h2>
			</div>

			<div class="modal-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-group">
					<label for="user-id" class="form-label">User ID</label>
					<input
						id="user-id"
						type="text"
						class="form-input"
						bind:value={createForm.user_id}
						placeholder="user_123"
					/>
				</div>

				<div class="form-group">
					<label for="attr-name" class="form-label">Attribute Name</label>
					<input
						id="attr-name"
						type="text"
						class="form-input"
						bind:value={createForm.attribute_name}
						placeholder="subscription_tier, verified_email, country..."
					/>
				</div>

				<div class="form-group">
					<label for="attr-value" class="form-label">Attribute Value</label>
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
						label="Set expiration"
						description="Set an expiration date for this attribute"
					/>
				</div>

				{#if createForm.has_expiry}
					<div class="form-group">
						<label for="expires-at" class="form-label">Expires At</label>
						<input
							id="expires-at"
							type="datetime-local"
							class="form-input"
							bind:value={createForm.expires_at}
						/>
					</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showCreateDialog = false)}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={submitCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete Dialog -->
{#if showDeleteDialog && attributeToDelete}
	<div
		class="modal-overlay"
		onclick={() => (showDeleteDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showDeleteDialog = false)}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Delete Attribute</h2>
			</div>

			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to delete the attribute
					<strong>{attributeToDelete.attribute_name}</strong> for user
					<strong>{attributeToDelete.user_email || attributeToDelete.user_id}</strong>?
				</p>
				<p class="danger-text">This action cannot be undone.</p>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Cleanup Dialog -->
{#if showCleanupDialog}
	<div
		class="modal-overlay"
		onclick={() => (showCleanupDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showCleanupDialog = false)}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Cleanup Expired Attributes</h2>
			</div>

			<div class="modal-body">
				{#if cleanupResult}
					<div class="alert alert-success">
						<p>
							Successfully deleted <strong>{cleanupResult.deleted_count}</strong> expired attributes.
						</p>
					</div>
				{:else}
					<p class="modal-description">
						This will permanently delete all expired attributes from the system.
						{#if stats}
							Currently there are <strong>{stats.expired}</strong> expired attributes.
						{/if}
					</p>
					<p class="danger-text">This action cannot be undone.</p>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showCleanupDialog = false)}>
					Close
				</button>
				{#if !cleanupResult}
					<button class="btn btn-danger" onclick={cleanupExpired} disabled={cleaningUp}>
						{cleaningUp ? 'Cleaning up...' : 'Delete Expired'}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

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

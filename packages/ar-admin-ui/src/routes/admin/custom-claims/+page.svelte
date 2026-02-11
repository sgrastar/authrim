<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminCustomClaimsAPI,
		type CustomClaimSchema,
		type CustomClaimStats,
		type FieldType,
		type ScopeMode,
		type ValidationRules,
		getFieldTypeLabel,
		getOperationStatusInfo,
		parseValidationRules,
		parseRequiredScopes
	} from '$lib/api/admin-custom-claims';
	import { Modal } from '$lib/components';

	// State
	let schemas: CustomClaimSchema[] = $state([]);
	let stats: CustomClaimStats | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let pagination = $state({
		page: 1,
		limit: 20,
		total: 0,
		total_pages: 0
	});

	// Filters
	let filterSearch = $state('');
	let filterFieldType = $state<FieldType | ''>('');
	let filterIsPii = $state<'' | '0' | '1'>('');
	let filterIsActive = $state<'' | '0' | '1'>('');

	// Create dialog
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let createForm = $state({
		field_key: '',
		display_label: '',
		field_type: 'string' as FieldType,
		is_pii: false,
		is_required: false,
		description: '',
		validation_rules_json: '',
		include_in_id_token: false,
		include_in_userinfo: false,
		include_in_introspection: false,
		required_scopes_text: '',
		scope_mode: 'any' as ScopeMode,
		claim_namespace: ''
	});

	// Edit dialog
	let showEditDialog = $state(false);
	let editing = $state(false);
	let editError = $state('');
	let editSchema: CustomClaimSchema | null = $state(null);
	let editForm = $state({
		display_label: '',
		field_type: 'string' as FieldType,
		is_required: false,
		is_active: true,
		description: '',
		validation_rules_json: '',
		include_in_id_token: false,
		include_in_userinfo: false,
		include_in_introspection: false,
		required_scopes_text: '',
		scope_mode: 'any' as ScopeMode,
		display_order: 0,
		claim_namespace: ''
	});

	// Delete dialog
	let showDeleteDialog = $state(false);
	let schemaToDelete: CustomClaimSchema | null = $state(null);
	let deleteUserCount = $state(0);
	let deleteUserCountApproximate = $state(false);
	let deleting = $state(false);
	let deleteError = $state('');

	// Rename dialog
	let showRenameDialog = $state(false);
	let schemaToRename: CustomClaimSchema | null = $state(null);
	let renameNewKey = $state('');
	let renameUserCount = $state(0);
	let renameUserCountApproximate = $state(false);
	let renaming = $state(false);
	let renameError = $state('');

	// =========================================================================
	// Data Loading
	// =========================================================================

	async function loadSchemas() {
		loading = true;
		error = '';

		try {
			const response = await adminCustomClaimsAPI.listSchemas({
				page: pagination.page,
				limit: pagination.limit,
				search: filterSearch || undefined,
				field_type: filterFieldType || undefined,
				is_pii: filterIsPii || undefined,
				is_active: filterIsActive || undefined
			});

			schemas = response.schemas;
			pagination = response.pagination;
		} catch (err) {
			console.error('Failed to load schemas:', err);
			error = err instanceof Error ? err.message : 'Failed to load schemas';
		} finally {
			loading = false;
		}
	}

	async function loadStats() {
		try {
			stats = await adminCustomClaimsAPI.getStats();
		} catch (err) {
			console.error('Failed to load stats:', err);
		}
	}

	function applyFilters() {
		pagination.page = 1;
		loadSchemas();
	}

	function clearFilters() {
		filterSearch = '';
		filterFieldType = '';
		filterIsPii = '';
		filterIsActive = '';
		pagination.page = 1;
		loadSchemas();
	}

	function goToPage(newPage: number) {
		if (newPage < 1 || newPage > pagination.total_pages) return;
		pagination.page = newPage;
		loadSchemas();
	}

	// =========================================================================
	// Create
	// =========================================================================

	function openCreateDialog() {
		createForm = {
			field_key: '',
			display_label: '',
			field_type: 'string',
			is_pii: false,
			is_required: false,
			description: '',
			validation_rules_json: '',
			include_in_id_token: false,
			include_in_userinfo: false,
			include_in_introspection: false,
			required_scopes_text: '',
			scope_mode: 'any',
			claim_namespace: ''
		};
		createError = '';
		showCreateDialog = true;
	}

	async function submitCreate() {
		if (!createForm.field_key || !createForm.display_label) {
			createError = 'Field Key and Display Label are required';
			return;
		}

		creating = true;
		createError = '';

		try {
			let validationRules: ValidationRules | null = null;
			if (createForm.validation_rules_json.trim()) {
				try {
					validationRules = JSON.parse(createForm.validation_rules_json);
				} catch {
					createError = 'Invalid JSON in validation rules';
					creating = false;
					return;
				}
			}

			let requiredScopes: string[] | null = null;
			if (createForm.required_scopes_text.trim()) {
				requiredScopes = createForm.required_scopes_text
					.split(',')
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
			}

			await adminCustomClaimsAPI.createSchema({
				field_key: createForm.field_key,
				display_label: createForm.display_label,
				field_type: createForm.field_type,
				is_pii: createForm.is_pii,
				is_required: createForm.is_required,
				description: createForm.description || null,
				validation_rules: validationRules,
				include_in_id_token: createForm.include_in_id_token,
				include_in_userinfo: createForm.include_in_userinfo,
				include_in_introspection: createForm.include_in_introspection,
				required_scopes: requiredScopes,
				scope_mode: createForm.scope_mode,
				claim_namespace: createForm.claim_namespace || null
			});

			showCreateDialog = false;
			loadSchemas();
			loadStats();
		} catch (err) {
			console.error('Failed to create schema:', err);
			createError = err instanceof Error ? err.message : 'Failed to create schema';
		} finally {
			creating = false;
		}
	}

	// =========================================================================
	// Edit
	// =========================================================================

	function openEditDialog(schema: CustomClaimSchema) {
		editSchema = schema;
		const rules = parseValidationRules(schema.validation_rules);
		const scopes = parseRequiredScopes(schema.required_scopes);
		editForm = {
			display_label: schema.display_label,
			field_type: schema.field_type,
			is_required: !!schema.is_required,
			is_active: !!schema.is_active,
			description: schema.description || '',
			validation_rules_json: rules ? JSON.stringify(rules, null, 2) : '',
			include_in_id_token: !!schema.include_in_id_token,
			include_in_userinfo: !!schema.include_in_userinfo,
			include_in_introspection: !!schema.include_in_introspection,
			required_scopes_text: scopes ? scopes.join(', ') : '',
			scope_mode: schema.scope_mode,
			display_order: schema.display_order,
			claim_namespace: schema.claim_namespace || ''
		};
		editError = '';
		showEditDialog = true;
	}

	async function submitEdit() {
		if (!editSchema) return;

		editing = true;
		editError = '';

		try {
			let validationRules: ValidationRules | null = null;
			if (editForm.validation_rules_json.trim()) {
				try {
					validationRules = JSON.parse(editForm.validation_rules_json);
				} catch {
					editError = 'Invalid JSON in validation rules';
					editing = false;
					return;
				}
			}

			let requiredScopes: string[] | null = null;
			if (editForm.required_scopes_text.trim()) {
				requiredScopes = editForm.required_scopes_text
					.split(',')
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
			}

			await adminCustomClaimsAPI.updateSchema(editSchema.id, {
				display_label: editForm.display_label,
				field_type: editForm.field_type,
				is_required: editForm.is_required,
				is_active: editForm.is_active,
				description: editForm.description || null,
				validation_rules: validationRules,
				include_in_id_token: editForm.include_in_id_token,
				include_in_userinfo: editForm.include_in_userinfo,
				include_in_introspection: editForm.include_in_introspection,
				required_scopes: requiredScopes,
				scope_mode: editForm.scope_mode,
				display_order: editForm.display_order,
				claim_namespace: editForm.claim_namespace || null
			});

			showEditDialog = false;
			editSchema = null;
			loadSchemas();
			loadStats();
		} catch (err) {
			console.error('Failed to update schema:', err);
			editError = err instanceof Error ? err.message : 'Failed to update schema';
		} finally {
			editing = false;
		}
	}

	// =========================================================================
	// Delete
	// =========================================================================

	async function openDeleteDialog(schema: CustomClaimSchema, event: Event) {
		event.stopPropagation();
		schemaToDelete = schema;
		deleteError = '';
		deleteUserCount = 0;
		deleteUserCountApproximate = false;

		try {
			const detail = await adminCustomClaimsAPI.getSchema(schema.id);
			deleteUserCount = detail.user_count;
			deleteUserCountApproximate = detail.user_count_approximate;
		} catch (err) {
			console.error('Failed to fetch user count:', err);
			deleteUserCount = -1;
			deleteUserCountApproximate = true;
		}

		showDeleteDialog = true;
	}

	async function confirmDelete() {
		if (!schemaToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminCustomClaimsAPI.deleteSchema(schemaToDelete.id);
			showDeleteDialog = false;
			schemaToDelete = null;
			loadSchemas();
			loadStats();
		} catch (err) {
			console.error('Failed to delete schema:', err);
			deleteError = err instanceof Error ? err.message : 'Failed to delete schema';
		} finally {
			deleting = false;
		}
	}

	// =========================================================================
	// Rename
	// =========================================================================

	async function openRenameDialog(schema: CustomClaimSchema, event: Event) {
		event.stopPropagation();
		schemaToRename = schema;
		renameNewKey = '';
		renameError = '';
		renameUserCount = 0;
		renameUserCountApproximate = false;

		try {
			const detail = await adminCustomClaimsAPI.getSchema(schema.id);
			renameUserCount = detail.user_count;
			renameUserCountApproximate = detail.user_count_approximate;
		} catch (err) {
			console.error('Failed to fetch user count:', err);
			renameUserCount = -1;
			renameUserCountApproximate = true;
		}

		showRenameDialog = true;
	}

	async function confirmRename() {
		if (!schemaToRename || !renameNewKey) return;

		renaming = true;
		renameError = '';

		try {
			await adminCustomClaimsAPI.renameSchema(schemaToRename.id, renameNewKey);
			showRenameDialog = false;
			schemaToRename = null;
			loadSchemas();
			loadStats();
		} catch (err) {
			console.error('Failed to rename schema:', err);
			renameError = err instanceof Error ? err.message : 'Failed to rename schema';
		} finally {
			renaming = false;
		}
	}

	// =========================================================================
	// Retry
	// =========================================================================

	async function retryOperation(schema: CustomClaimSchema) {
		try {
			await adminCustomClaimsAPI.retryOperation(schema.id);
			loadSchemas();
			loadStats();
		} catch (err) {
			console.error('Failed to retry operation:', err);
			error = err instanceof Error ? err.message : 'Failed to retry operation';
		}
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	function getTokenBadges(schema: CustomClaimSchema): string[] {
		const badges: string[] = [];
		if (schema.include_in_id_token) badges.push('ID Token');
		if (schema.include_in_userinfo) badges.push('UserInfo');
		if (schema.include_in_introspection) badges.push('Introspection');
		return badges;
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

	onMount(() => {
		loadSchemas();
		loadStats();
	});
</script>

<svelte:head>
	<title>Custom Claims Schema - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Error State Banner -->
	{#if stats && stats.error_count > 0}
		<div class="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
			<div class="flex items-start">
				<span class="i-ph-warning text-red-600 text-xl mr-3 mt-0.5"></span>
				<div class="flex-1">
					<h3 class="font-semibold text-red-900 mb-1">Operation Errors Detected</h3>
					<p class="text-sm text-red-800">
						{stats.error_count} schema(s) have failed operations that require attention.
						Filter by "Error" status to review and retry.
					</p>
				</div>
			</div>
		</div>
	{/if}

	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Custom Claims Schema</h1>
			<p class="page-description">
				Define and manage custom claim fields for users. Control field types, validation rules, and
				how claims map to OIDC tokens.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				Add Custom Claim
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadSchemas}>Retry</button>
		</div>
	{/if}

	<!-- Stats Cards -->
	{#if stats}
		<div class="stats-grid">
			<div class="stat-card">
				<span class="stat-value">{stats.total}</span>
				<span class="stat-label">Total Schemas</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.active_non_pii}</span>
				<span class="stat-label">Non-PII (Active)</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.active_pii}</span>
				<span class="stat-label">PII (Active)</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.non_pii_users_with_data}</span>
				<span class="stat-label">Non-PII Users</span>
			</div>
			{#if stats.pii_users_with_data >= 0}
				<div class="stat-card">
					<span class="stat-value">~{stats.pii_users_with_data}</span>
					<span class="stat-label">PII Users (approx.)</span>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<input
					type="text"
					class="form-input"
					placeholder="Search field key, label, description..."
					bind:value={filterSearch}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterFieldType} onchange={applyFilters}>
					<option value="">All Types</option>
					<option value="string">String</option>
					<option value="number">Number</option>
					<option value="boolean">Boolean</option>
					<option value="date">Date</option>
					<option value="enum">Enum</option>
				</select>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterIsPii} onchange={applyFilters}>
					<option value="">All (PII/Non-PII)</option>
					<option value="0">Non-PII</option>
					<option value="1">PII</option>
				</select>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterIsActive} onchange={applyFilters}>
					<option value="">All Status</option>
					<option value="1">Active</option>
					<option value="0">Inactive</option>
				</select>
			</div>
			<div class="form-group">
				<button class="btn btn-primary" onclick={applyFilters}>Apply</button>
				<button class="btn btn-secondary" onclick={clearFilters}>Clear</button>
			</div>
		</div>
	</div>

	<!-- Schemas Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if schemas.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No custom claim schemas found.</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>Add Custom Claim</button>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Field Key</th>
						<th>Label</th>
						<th>Type</th>
						<th>PII</th>
						<th>Token</th>
						<th>Required</th>
						<th>Status</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each schemas as schema (schema.id)}
						{@const statusInfo = getOperationStatusInfo(schema.operation_status)}
						{@const tokenBadges = getTokenBadges(schema)}
						<tr
							class="cursor-pointer hover:bg-gray-50"
							class:opacity-50={!schema.is_active}
							onclick={() => openEditDialog(schema)}
						>
							<td>
								<div class="flex items-center gap-2">
									<code class="text-sm font-mono">{schema.field_key}</code>
									{#if schema.claim_namespace}
										<span class="badge badge-neutral text-xs" title={schema.claim_namespace}
											>NS</span
										>
									{/if}
								</div>
							</td>
							<td>{schema.display_label}</td>
							<td>
								<span class="badge badge-neutral">{getFieldTypeLabel(schema.field_type)}</span>
							</td>
							<td>
								{#if schema.is_pii}
									<span class="badge badge-warning">PII</span>
								{:else}
									<span class="badge badge-success">Non-PII</span>
								{/if}
							</td>
							<td>
								{#if tokenBadges.length > 0}
									<div class="flex flex-wrap gap-1">
										{#each tokenBadges as badge (badge)}
											<span class="badge badge-info text-xs">{badge}</span>
										{/each}
									</div>
								{:else}
									<span class="text-gray-400">-</span>
								{/if}
							</td>
							<td>
								{#if schema.is_required}
									<span class="badge badge-error">Required</span>
								{:else}
									<span class="text-gray-400">Optional</span>
								{/if}
							</td>
							<td>
								{#if schema.operation_status === 'error'}
									<span class="badge badge-error">{statusInfo.label}</span>
									<button
										class="btn btn-secondary btn-xs ml-1"
										onclick={(e) => {
											e.stopPropagation();
											retryOperation(schema);
										}}
										title="Retry failed operation"
									>
										<i class="i-ph-arrow-clockwise"></i>
									</button>
								{:else if schema.operation_status !== 'active'}
									<span class="badge badge-warning">{statusInfo.label}</span>
								{:else if !schema.is_active}
									<span class="badge badge-neutral">Inactive</span>
								{:else}
									<span class="badge badge-success">Active</span>
								{/if}
							</td>
							<td>
								<div class="flex gap-1">
									<button
										class="btn btn-secondary btn-xs"
										title="Rename"
										onclick={(e) => openRenameDialog(schema, e)}
										disabled={schema.operation_status !== 'active'}
									>
										<i class="i-ph-pencil-simple"></i>
									</button>
									<button
										class="btn btn-danger btn-xs"
										title="Delete"
										onclick={(e) => openDeleteDialog(schema, e)}
										disabled={schema.operation_status !== 'active' &&
											schema.operation_status !== 'error'}
									>
										<i class="i-ph-trash"></i>
									</button>
								</div>
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
					disabled={pagination.page <= 1}
					onclick={() => goToPage(pagination.page - 1)}
				>
					Previous
				</button>
				<span class="pagination-info">
					Page {pagination.page} of {pagination.total_pages} ({pagination.total} total)
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page >= pagination.total_pages}
					onclick={() => goToPage(pagination.page + 1)}
				>
					Next
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Create Modal -->
<Modal
	open={showCreateDialog}
	onClose={() => {
		showCreateDialog = false;
		createError = '';
	}}
	title="Create Custom Claim Schema"
	size="lg"
>
	{#if createError}
		<div class="alert alert-error alert-sm mb-4">{createError}</div>
	{/if}

	<div class="form-grid">
		<div class="form-group">
			<label class="form-label" for="create-field-key">Field Key *</label>
			<input
				id="create-field-key"
				type="text"
				class="form-input"
				placeholder="e.g. employee_id"
				bind:value={createForm.field_key}
			/>
			<p class="form-hint">
				snake_case, starts with a letter, max 64 chars. Cannot use reserved OIDC claim names.
			</p>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-display-label">Display Label *</label>
			<input
				id="create-display-label"
				type="text"
				class="form-input"
				placeholder="e.g. Employee ID"
				bind:value={createForm.display_label}
			/>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-field-type">Field Type</label>
			<select id="create-field-type" class="form-select" bind:value={createForm.field_type}>
				<option value="string">String</option>
				<option value="number">Number</option>
				<option value="boolean">Boolean</option>
				<option value="date">Date</option>
				<option value="enum">Enum</option>
			</select>
		</div>

		<div class="form-group">
			<label class="form-label">
				<input type="checkbox" bind:checked={createForm.is_pii} />
				PII (Personal Identifiable Information)
			</label>
			<p class="form-hint text-amber-600">
				Cannot be changed after creation. PII data is stored in a separate encrypted database.
			</p>
		</div>

		<div class="form-group">
			<label class="form-label">
				<input type="checkbox" bind:checked={createForm.is_required} />
				Required field
			</label>
		</div>

		<div class="form-group col-span-2">
			<label class="form-label" for="create-description">Description</label>
			<textarea
				id="create-description"
				class="form-input"
				rows="2"
				placeholder="Optional description..."
				bind:value={createForm.description}
			></textarea>
		</div>

		<div class="form-group col-span-2">
			<label class="form-label" for="create-validation">Validation Rules (JSON)</label>
			<textarea
				id="create-validation"
				class="form-input font-mono text-sm"
				rows="3"
				placeholder={'e.g. {"min_length": 1, "max_length": 100}'}
				bind:value={createForm.validation_rules_json}
			></textarea>
			<p class="form-hint">
				String: min_length, max_length, pattern. Number: min, max. Enum: enum_values (array).
				Date: min_date, max_date (ISO 8601).
			</p>
		</div>

		<!-- Token Integration -->
		<div class="form-group col-span-2">
			<h4 class="font-semibold text-sm mb-2">Token / Endpoint Integration</h4>
			<div class="flex gap-4 flex-wrap">
				<label class="form-label">
					<input type="checkbox" bind:checked={createForm.include_in_id_token} />
					ID Token
				</label>
				<label class="form-label">
					<input type="checkbox" bind:checked={createForm.include_in_userinfo} />
					UserInfo
				</label>
				<label class="form-label">
					<input type="checkbox" bind:checked={createForm.include_in_introspection} />
					Introspection
					<small style="color: var(--color-warning, #b08800); display: block; font-size: 0.75rem;"
						>現在、Introspectionレスポンスへのカスタムクレーム埋め込みは無効です。UserInfoエンドポイントをご利用ください。</small
					>
				</label>
			</div>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-scopes">Required Scopes (comma-separated)</label>
			<input
				id="create-scopes"
				type="text"
				class="form-input"
				placeholder="e.g. profile, employee"
				bind:value={createForm.required_scopes_text}
			/>
			<p class="form-hint">Leave empty to always include when token flags are set.</p>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-scope-mode">Scope Mode</label>
			<select id="create-scope-mode" class="form-select" bind:value={createForm.scope_mode}>
				<option value="any">Any (one scope suffices)</option>
				<option value="all">All (all scopes required)</option>
			</select>
		</div>

		<div class="form-group col-span-2">
			<label class="form-label" for="create-namespace">Claim Namespace (optional)</label>
			<input
				id="create-namespace"
				type="text"
				class="form-input"
				placeholder="e.g. https://example.com/claims/"
				bind:value={createForm.claim_namespace}
			/>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showCreateDialog = false)}>Cancel</button>
		<button class="btn btn-primary" onclick={submitCreate} disabled={creating}>
			{creating ? 'Creating...' : 'Create'}
		</button>
	{/snippet}
</Modal>

<!-- Edit Modal -->
<Modal
	open={showEditDialog}
	onClose={() => {
		showEditDialog = false;
		editSchema = null;
		editError = '';
		editForm = {
			display_label: '',
			field_type: 'string' as FieldType,
			is_required: false,
			is_active: true,
			description: '',
			validation_rules_json: '',
			include_in_id_token: false,
			include_in_userinfo: false,
			include_in_introspection: false,
			required_scopes_text: '',
			scope_mode: 'any' as ScopeMode,
			display_order: 0,
			claim_namespace: ''
		};
	}}
	title="Edit Custom Claim Schema"
	size="lg"
>
	{#if editError}
		<div class="alert alert-error alert-sm mb-4">{editError}</div>
	{/if}

	{#if editSchema}
		<!-- Read-only fields -->
		<div class="mb-4 bg-gray-50 rounded-lg p-3">
			<div class="grid grid-cols-2 gap-2 text-sm">
				<div>
					<span class="text-gray-500">Field Key:</span>
					<code class="ml-1 font-mono">{editSchema.field_key}</code>
				</div>
				<div>
					<span class="text-gray-500">PII:</span>
					<span class="ml-1">{editSchema.is_pii ? 'Yes (PII)' : 'No (Non-PII)'}</span>
				</div>
				<div>
					<span class="text-gray-500">Version:</span>
					<span class="ml-1">{editSchema.schema_version}</span>
				</div>
				<div>
					<span class="text-gray-500">Created:</span>
					<span class="ml-1">{formatDate(editSchema.created_at)}</span>
				</div>
			</div>
		</div>

		<div class="form-grid">
			<div class="form-group">
				<label class="form-label" for="edit-display-label">Display Label</label>
				<input
					id="edit-display-label"
					type="text"
					class="form-input"
					bind:value={editForm.display_label}
				/>
			</div>

			<div class="form-group">
				<label class="form-label" for="edit-field-type">Field Type</label>
				<select id="edit-field-type" class="form-select" bind:value={editForm.field_type}>
					<option value="string">String</option>
					<option value="number">Number</option>
					<option value="boolean">Boolean</option>
					<option value="date">Date</option>
					<option value="enum">Enum</option>
				</select>
			</div>

			<div class="form-group">
				<label class="form-label">
					<input type="checkbox" bind:checked={editForm.is_required} />
					Required field
				</label>
			</div>

			<div class="form-group">
				<label class="form-label">
					<input type="checkbox" bind:checked={editForm.is_active} />
					Active
				</label>
			</div>

			<div class="form-group">
				<label class="form-label" for="edit-display-order">Display Order</label>
				<input
					id="edit-display-order"
					type="number"
					class="form-input"
					bind:value={editForm.display_order}
				/>
			</div>

			<div class="form-group col-span-2">
				<label class="form-label" for="edit-description">Description</label>
				<textarea
					id="edit-description"
					class="form-input"
					rows="2"
					bind:value={editForm.description}
				></textarea>
			</div>

			<div class="form-group col-span-2">
				<label class="form-label" for="edit-validation">Validation Rules (JSON)</label>
				<textarea
					id="edit-validation"
					class="form-input font-mono text-sm"
					rows="3"
					bind:value={editForm.validation_rules_json}
				></textarea>
			</div>

			<!-- Token Integration -->
			<div class="form-group col-span-2">
				<h4 class="font-semibold text-sm mb-2">Token / Endpoint Integration</h4>
				<div class="flex gap-4 flex-wrap">
					<label class="form-label">
						<input type="checkbox" bind:checked={editForm.include_in_id_token} />
						ID Token
					</label>
					<label class="form-label">
						<input type="checkbox" bind:checked={editForm.include_in_userinfo} />
						UserInfo
					</label>
					<label class="form-label">
						<input type="checkbox" bind:checked={editForm.include_in_introspection} />
						Introspection
						<small style="color: var(--color-warning, #b08800); display: block; font-size: 0.75rem;"
							>現在、Introspectionレスポンスへのカスタムクレーム埋め込みは無効です。UserInfoエンドポイントをご利用ください。</small
						>
					</label>
				</div>
			</div>

			<div class="form-group">
				<label class="form-label" for="edit-scopes">Required Scopes (comma-separated)</label>
				<input
					id="edit-scopes"
					type="text"
					class="form-input"
					bind:value={editForm.required_scopes_text}
				/>
			</div>

			<div class="form-group">
				<label class="form-label" for="edit-scope-mode">Scope Mode</label>
				<select id="edit-scope-mode" class="form-select" bind:value={editForm.scope_mode}>
					<option value="any">Any</option>
					<option value="all">All</option>
				</select>
			</div>

			<div class="form-group col-span-2">
				<label class="form-label" for="edit-namespace">Claim Namespace</label>
				<input
					id="edit-namespace"
					type="text"
					class="form-input"
					bind:value={editForm.claim_namespace}
				/>
			</div>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showEditDialog = false)}>Cancel</button>
		<button class="btn btn-primary" onclick={submitEdit} disabled={editing}>
			{editing ? 'Saving...' : 'Save Changes'}
		</button>
	{/snippet}
</Modal>

<!-- Delete Modal -->
<Modal
	open={showDeleteDialog && !!schemaToDelete}
	onClose={() => {
		showDeleteDialog = false;
		schemaToDelete = null;
		deleteError = '';
		deleteUserCount = 0;
		deleteUserCountApproximate = false;
	}}
	title="Delete Custom Claim Schema"
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error alert-sm mb-4">{deleteError}</div>
	{/if}

	{#if schemaToDelete}
		<div class="alert alert-warning mb-4">
			<strong>Warning:</strong> This will permanently delete the schema and all associated user data.
			This action cannot be undone.
		</div>

		<div class="bg-gray-50 rounded-lg p-3 mb-4">
			<p>
				<strong>Field Key:</strong>
				<code>{schemaToDelete.field_key}</code>
			</p>
			<p><strong>Label:</strong> {schemaToDelete.display_label}</p>
			<p><strong>Type:</strong> {getFieldTypeLabel(schemaToDelete.field_type)}</p>
			<p>
				<strong>Storage:</strong>
				{schemaToDelete.is_pii ? 'PII Database' : 'Core Database'}
			</p>
			{#if deleteUserCount > 0}
				<p class="text-red-600 font-semibold mt-2">
					Affected users: {deleteUserCountApproximate ? '~' : ''}{deleteUserCount}
					{deleteUserCountApproximate ? '(approximate)' : ''}
				</p>
			{:else if deleteUserCount < 0}
				<p class="text-amber-600 font-semibold mt-2">
					Could not fetch affected user count. Proceed with caution.
				</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}>Cancel</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? 'Deleting...' : 'Delete Schema & Data'}
		</button>
	{/snippet}
</Modal>

<!-- Rename Modal -->
<Modal
	open={showRenameDialog && !!schemaToRename}
	onClose={() => {
		showRenameDialog = false;
		schemaToRename = null;
		renameError = '';
		renameNewKey = '';
		renameUserCount = 0;
		renameUserCountApproximate = false;
	}}
	title="Rename Custom Claim Field Key"
	size="md"
>
	{#if renameError}
		<div class="alert alert-error alert-sm mb-4">{renameError}</div>
	{/if}

	{#if schemaToRename}
		<!-- Recommended approach -->
		<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
			<h4 class="font-semibold text-blue-900 text-sm mb-1">Recommended Approach</h4>
			<ol class="text-sm text-blue-800 list-decimal list-inside space-y-1">
				<li>Deactivate this schema (set inactive)</li>
				<li>Create a new schema with the desired field_key</li>
				<li>Migrate user data in the background</li>
				<li>Delete the old schema</li>
			</ol>
		</div>

		<!-- Direct rename warning -->
		<div class="alert alert-warning mb-4">
			<strong>Direct rename warning:</strong> Renaming changes the claim name in API responses and tokens.
			This may break integrations with Relying Parties (RP) that expect the old claim name.
		</div>

		<div class="bg-gray-50 rounded-lg p-3 mb-4">
			<p>
				<strong>Current Field Key:</strong>
				<code>{schemaToRename.field_key}</code>
			</p>
			{#if renameUserCount > 0}
				<p class="text-amber-600 font-semibold mt-1">
					Affected users: {renameUserCountApproximate ? '~' : ''}{renameUserCount}
					{renameUserCountApproximate ? '(approximate)' : ''}
				</p>
			{:else if renameUserCount < 0}
				<p class="text-amber-600 font-semibold mt-1">
					Could not fetch affected user count. Proceed with caution.
				</p>
			{/if}
		</div>

		<div class="form-group">
			<label class="form-label" for="rename-new-key">New Field Key</label>
			<input
				id="rename-new-key"
				type="text"
				class="form-input"
				placeholder="e.g. new_field_name"
				bind:value={renameNewKey}
			/>
			<p class="form-hint">snake_case, starts with a letter, max 64 chars.</p>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showRenameDialog = false)}>Cancel</button>
		<button
			class="btn btn-warning"
			onclick={confirmRename}
			disabled={renaming || !renameNewKey}
		>
			{renaming ? 'Renaming...' : 'Rename Field Key'}
		</button>
	{/snippet}
</Modal>

<style>
	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.col-span-2 {
		grid-column: span 2;
	}

	.form-hint {
		font-size: 0.75rem;
		color: #6b7280;
		margin-top: 0.25rem;
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminCustomClaimsAPI,
		type CustomClaimPreset,
		type CustomClaimSchema,
		type CustomClaimStats,
		type FieldType,
		type ScopeMode,
		type ValidationRules,
		type OperationStatus
	} from '$lib/api/admin-custom-claims';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

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
	let filterIsSystem = $state<'' | '0' | '1'>('');
	let collapsedSchemaGroups = $state<string[]>([]);

	// Preset dialog
	let showPresetDialog = $state(false);
	let loadingPresets = $state(false);
	let applyingPreset = $state(false);
	let presetError = $state('');
	let presets = $state<CustomClaimPreset[]>([]);
	let existingPresetFieldKeys = $state<string[]>([]);
	let selectedPresetId = $state('');
	let selectedPresetFieldKeys = $state<string[]>([]);

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
				is_active: filterIsActive || undefined,
				is_system: filterIsSystem || undefined
			});

			schemas = response.schemas;
			pagination = response.pagination;
		} catch {
			error = $LL.admin_custom_claims_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadStats() {
		try {
			stats = await adminCustomClaimsAPI.getStats();
		} catch {
			// Stats are supplemental; keep the schema list usable if this request fails.
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
		filterIsSystem = '';
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

	async function openPresetDialog() {
		showPresetDialog = true;
		presetError = '';
		loadingPresets = true;

		try {
			const response = await adminCustomClaimsAPI.listPresets();
			presets = response.presets;
			existingPresetFieldKeys = response.existing_field_keys;
			selectedPresetId = response.presets[0]?.id ?? '';
			selectMissingPresetFields();
		} catch (err) {
			presetError =
				err instanceof Error ? err.message : $LL.admin_custom_claims_presets_load_failed();
		} finally {
			loadingPresets = false;
		}
	}

	function currentPreset(): CustomClaimPreset | null {
		return presets.find((preset) => preset.id === selectedPresetId) ?? null;
	}

	function selectMissingPresetFields() {
		const preset = currentPreset();
		if (!preset) {
			selectedPresetFieldKeys = [];
			return;
		}
		const existing = new Set(existingPresetFieldKeys);
		selectedPresetFieldKeys = preset.fields
			.filter((field) => !existing.has(field.field_key))
			.map((field) => field.field_key);
	}

	function togglePresetField(fieldKey: string) {
		selectedPresetFieldKeys = selectedPresetFieldKeys.includes(fieldKey)
			? selectedPresetFieldKeys.filter((candidate) => candidate !== fieldKey)
			: [...selectedPresetFieldKeys, fieldKey];
	}

	async function applyPreset() {
		if (!selectedPresetId || selectedPresetFieldKeys.length === 0) {
			presetError = $LL.admin_custom_claims_select_field_error();
			return;
		}
		applyingPreset = true;
		presetError = '';

		try {
			await adminCustomClaimsAPI.applyPreset(selectedPresetId, selectedPresetFieldKeys);
			showPresetDialog = false;
			await loadSchemas();
			await loadStats();
		} catch (err) {
			presetError =
				err instanceof Error ? err.message : $LL.admin_custom_claims_apply_preset_failed();
		} finally {
			applyingPreset = false;
		}
	}

	async function submitCreate() {
		if (!createForm.field_key || !createForm.display_label) {
			createError = $LL.admin_custom_claims_required_error();
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
					createError = $LL.admin_custom_claims_invalid_json_error();
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
			createError = err instanceof Error ? err.message : $LL.admin_custom_claims_create_failed();
		} finally {
			creating = false;
		}
	}

	// =========================================================================
	// Delete
	// =========================================================================

	async function _openDeleteDialog(schema: CustomClaimSchema, event: Event) {
		event.stopPropagation();
		schemaToDelete = schema;
		deleteError = '';
		deleteUserCount = 0;
		deleteUserCountApproximate = false;

		try {
			const detail = await adminCustomClaimsAPI.getSchema(schema.id);
			deleteUserCount = detail.user_count;
			deleteUserCountApproximate = detail.user_count_approximate;
		} catch {
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
			deleteError = err instanceof Error ? err.message : $LL.admin_custom_claims_delete_failed();
		} finally {
			deleting = false;
		}
	}

	// =========================================================================
	// Rename
	// =========================================================================

	async function _openRenameDialog(schema: CustomClaimSchema, event: Event) {
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
		} catch {
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
			renameError = err instanceof Error ? err.message : $LL.admin_custom_claims_rename_failed();
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
			error = err instanceof Error ? err.message : $LL.admin_custom_claims_retry_failed();
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

	function usageBindingLabel(bindingId: string): string {
		switch (bindingId) {
			case 'passkey.signup':
				return $LL.admin_custom_claims_usage_passkey_signup();
			case 'email_otp.login':
				return $LL.admin_custom_claims_usage_email_otp_login();
			case 'email_otp.signup':
				return $LL.admin_custom_claims_usage_email_otp_signup();
			default:
				return bindingId;
		}
	}

	function hasBlockingUsage(schema: CustomClaimSchema): boolean {
		return (
			schema.usage_bindings?.some((binding) => binding.protection === 'delete_blocked') ?? false
		);
	}

	function fieldTypeLabel(type: FieldType): string {
		switch (type) {
			case 'string':
				return $LL.admin_custom_claims_field_type_string();
			case 'number':
				return $LL.admin_custom_claims_field_type_number();
			case 'boolean':
				return $LL.admin_custom_claims_field_type_boolean();
			case 'date':
				return $LL.admin_custom_claims_field_type_date();
			case 'enum':
				return $LL.admin_custom_claims_field_type_enum();
			default:
				return type;
		}
	}

	function operationStatusLabel(status: OperationStatus): string {
		switch (status) {
			case 'active':
				return $LL.admin_custom_claims_active();
			case 'renaming':
				return $LL.admin_custom_claims_status_renaming();
			case 'deleting':
				return $LL.admin_custom_claims_status_deleting();
			case 'error':
				return $LL.admin_custom_claims_status_error();
			default:
				return status;
		}
	}

	function schemaGroupLabel(key: string): string {
		switch (key) {
			case 'identity':
				return $LL.admin_custom_claims_group_identity();
			case 'name':
				return $LL.admin_custom_claims_group_name();
			case 'contact':
				return $LL.admin_custom_claims_group_contact();
			case 'address':
				return $LL.admin_custom_claims_group_address();
			case 'profile':
				return $LL.admin_custom_claims_group_profile();
			case 'access':
				return $LL.admin_custom_claims_group_access();
			default:
				return $LL.admin_custom_claims_group_custom();
		}
	}

	type SchemaGroup = {
		key: string;
		label: string;
		order: number;
		schemas: CustomClaimSchema[];
	};

	const schemaGroupOrders: Record<string, number> = {
		identity: 10,
		name: 20,
		contact: 30,
		address: 40,
		profile: 50,
		access: 60,
		custom: 90
	};

	function schemaGroupKey(schema: CustomClaimSchema): string {
		if (schema.ui_group_key) return schema.ui_group_key;
		const key = schema.field_key.toLowerCase();
		if (
			['sub', 'subject', 'subject_id', 'user_id', 'external_id', 'linked_identity'].includes(key)
		) {
			return 'identity';
		}
		if (
			[
				'name',
				'given_name',
				'family_name',
				'middle_name',
				'nickname',
				'preferred_username'
			].includes(key)
		) {
			return 'name';
		}
		if (key === 'email' || key === 'email_verified' || key.startsWith('phone_number')) {
			return 'contact';
		}
		if (key === 'address' || key.startsWith('address_')) {
			return 'address';
		}
		if (
			['profile', 'picture', 'website', 'birthdate', 'zoneinfo', 'locale', 'updated_at'].includes(
				key
			)
		) {
			return 'profile';
		}
		if (['groups', 'roles', 'entitlements', 'permissions', 'org', 'organization'].includes(key)) {
			return 'access';
		}
		return schema.is_system ? 'profile' : 'custom';
	}

	const groupedSchemas = $derived.by<SchemaGroup[]>(() => {
		const groups: SchemaGroup[] = [];
		for (const schema of schemas) {
			const key = schemaGroupKey(schema);
			const label = schema.ui_group_label || schemaGroupLabel(key);
			const order = schema.ui_group_order ?? schemaGroupOrders[key] ?? schemaGroupOrders.custom;
			let group = groups.find((candidate) => candidate.key === key);
			if (!group) {
				group = {
					key,
					label,
					order,
					schemas: []
				};
				groups.push(group);
			}
			group.schemas.push(schema);
		}
		return groups
			.map((group) => ({
				...group,
				schemas: group.schemas.toSorted(
					(a, b) =>
						(a.ui_field_order ?? a.display_order) - (b.ui_field_order ?? b.display_order) ||
						a.display_order - b.display_order ||
						a.display_label.localeCompare(b.display_label)
				)
			}))
			.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
	});

	function isSchemaGroupCollapsed(key: string): boolean {
		return collapsedSchemaGroups.includes(key);
	}

	function toggleSchemaGroup(key: string) {
		collapsedSchemaGroups = isSchemaGroupCollapsed(key)
			? collapsedSchemaGroups.filter((candidate) => candidate !== key)
			: [...collapsedSchemaGroups, key];
	}

	onMount(() => {
		loadSchemas();
		loadStats();
	});
</script>

<svelte:head>
	<title>{$LL.admin_custom_claims_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Error State Banner -->
	{#if stats && stats.error_count > 0}
		<div class="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
			<div class="flex items-start">
				<span class="i-ph-warning text-red-600 text-xl mr-3 mt-0.5"></span>
				<div class="flex-1">
					<h3 class="font-semibold text-red-900 mb-1">
						{$LL.admin_custom_claims_operation_errors_title()}
					</h3>
					<p class="text-sm text-red-800">
						{$LL.admin_custom_claims_operation_errors_description({
							count: stats.error_count
						})}
					</p>
				</div>
			</div>
		</div>
	{/if}

	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_custom_claims_title()}</h1>
			<p class="page-description">
				{$LL.admin_custom_claims_description()}
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={openPresetDialog}>
				<i class="i-ph-list-plus"></i>
				{$LL.admin_custom_claims_add_from_preset()}
			</button>
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				{$LL.admin_custom_claims_add_schema()}
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadSchemas}
				>{$LL.admin_custom_claims_retry()}</button
			>
		</div>
	{/if}

	<!-- Stats Cards -->
	{#if stats}
		<div class="stats-grid">
			<div class="stat-card">
				<span class="stat-value">{stats.total}</span>
				<span class="stat-label">{$LL.admin_custom_claims_stats_total()}</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.active_non_pii}</span>
				<span class="stat-label">{$LL.admin_custom_claims_stats_non_pii_active()}</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.active_pii}</span>
				<span class="stat-label">{$LL.admin_custom_claims_stats_pii_active()}</span>
			</div>
			<div class="stat-card">
				<span class="stat-value">{stats.non_pii_users_with_data}</span>
				<span class="stat-label">{$LL.admin_custom_claims_stats_non_pii_users()}</span>
			</div>
			{#if stats.pii_users_with_data >= 0}
				<div class="stat-card">
					<span class="stat-value">~{stats.pii_users_with_data}</span>
					<span class="stat-label">{$LL.admin_custom_claims_stats_pii_users_approx()}</span>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="schema-note">
			<div>
				<strong>{$LL.admin_custom_claims_system_note_title()}</strong>
				<p>
					{$LL.admin_custom_claims_system_note_description()}
				</p>
			</div>
		</div>
		<div class="filter-row">
			<div class="form-group">
				<input
					type="text"
					class="form-input"
					placeholder={$LL.admin_custom_claims_search_placeholder()}
					bind:value={filterSearch}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterFieldType} onchange={applyFilters}>
					<option value="">{$LL.admin_custom_claims_all_types()}</option>
					<option value="string">{$LL.admin_custom_claims_field_type_string()}</option>
					<option value="number">{$LL.admin_custom_claims_field_type_number()}</option>
					<option value="boolean">{$LL.admin_custom_claims_field_type_boolean()}</option>
					<option value="date">{$LL.admin_custom_claims_field_type_date()}</option>
					<option value="enum">{$LL.admin_custom_claims_field_type_enum()}</option>
				</select>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterIsPii} onchange={applyFilters}>
					<option value="">{$LL.admin_custom_claims_all_pii()}</option>
					<option value="0">Non-PII</option>
					<option value="1">PII</option>
				</select>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterIsActive} onchange={applyFilters}>
					<option value="">{$LL.admin_custom_claims_all_status()}</option>
					<option value="1">{$LL.admin_custom_claims_active()}</option>
					<option value="0">{$LL.admin_custom_claims_inactive()}</option>
				</select>
			</div>
			<div class="form-group">
				<select class="form-select" bind:value={filterIsSystem} onchange={applyFilters}>
					<option value="">{$LL.admin_custom_claims_all()}</option>
					<option value="0">{$LL.admin_custom_claims_custom()}</option>
					<option value="1">{$LL.admin_custom_claims_system()}</option>
				</select>
			</div>
			<div class="form-group">
				<button class="btn btn-primary" onclick={applyFilters}
					>{$LL.admin_custom_claims_apply()}</button
				>
				<button class="btn btn-secondary" onclick={clearFilters}
					>{$LL.admin_custom_claims_clear()}</button
				>
			</div>
		</div>
	</div>

	<!-- Schemas Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_custom_claims_loading()}</p>
		</div>
	{:else if schemas.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_custom_claims_empty()}</p>
				<button class="btn btn-secondary" onclick={openPresetDialog}
					>{$LL.admin_custom_claims_add_from_preset()}</button
				>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_custom_claims_add_schema()}</button
				>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table schema-table">
				<thead>
					<tr>
						<th>{$LL.admin_custom_claims_field_key()}</th>
						<th>{$LL.admin_custom_claims_label()}</th>
						<th>{$LL.admin_custom_claims_type()}</th>
						<th>PII</th>
						<th>{$LL.admin_custom_claims_token()}</th>
						<th>{$LL.admin_custom_claims_required()}</th>
						<th>{$LL.admin_custom_claims_status()}</th>
					</tr>
				</thead>
				<tbody>
					{#each groupedSchemas as group (group.key)}
						<tr class="schema-group-row">
							<td colspan="7">
								<button
									type="button"
									class="schema-group-toggle"
									aria-expanded={!isSchemaGroupCollapsed(group.key)}
									onclick={() => toggleSchemaGroup(group.key)}
								>
									<span>{group.label}</span>
									<span class="schema-group-count">{group.schemas.length}</span>
									<i
										class={isSchemaGroupCollapsed(group.key)
											? 'i-ph-caret-right'
											: 'i-ph-caret-down'}
										aria-hidden="true"
									></i>
								</button>
							</td>
						</tr>
						{#if !isSchemaGroupCollapsed(group.key)}
							{#each group.schemas as schema (schema.id)}
								{@const tokenBadges = getTokenBadges(schema)}
								<tr
									class="cursor-pointer hover:bg-gray-50"
									class:opacity-50={!schema.is_active}
									onclick={() => goto(`/admin/custom-claims/${schema.id}`)}
								>
									<td>
										<div class="flex items-center gap-2 flex-wrap">
											<code class="text-sm font-mono">{schema.field_key}</code>
											{#if schema.is_system}
												<span class="badge badge-neutral text-xs"
													>{$LL.admin_custom_claims_system()}</span
												>
											{/if}
											{#if schema.is_system_used || hasBlockingUsage(schema)}
												<span class="badge badge-warning text-xs"
													>{$LL.admin_custom_claims_used_by_system()}</span
												>
											{/if}
											{#if schema.claim_namespace}
												<span class="badge badge-neutral text-xs" title={schema.claim_namespace}
													>NS</span
												>
											{/if}
										</div>
										{#if schema.usage_bindings && schema.usage_bindings.length > 0}
											<div class="usage-bindings">
												{#each schema.usage_bindings as binding (binding.id)}
													<span
														class:usage-binding-blocked={binding.protection === 'delete_blocked'}
														class="usage-binding"
														title={binding.reason ?? binding.binding_id}
													>
														{usageBindingLabel(binding.binding_id)}
													</span>
												{/each}
											</div>
										{/if}
									</td>
									<td>{schema.display_label}</td>
									<td>
										<span class="badge badge-neutral">{fieldTypeLabel(schema.field_type)}</span>
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
											<span class="badge badge-error"
												>{$LL.admin_custom_claims_required_badge()}</span
											>
										{:else}
											<span class="text-gray-400">{$LL.admin_custom_claims_optional()}</span>
										{/if}
									</td>
									<td>
										{#if schema.operation_status === 'error'}
											<span class="badge badge-error"
												>{operationStatusLabel(schema.operation_status)}</span
											>
											<button
												class="btn btn-secondary btn-xs ml-1"
												onclick={(e) => {
													e.stopPropagation();
													retryOperation(schema);
												}}
												title={$LL.admin_custom_claims_retry_failed_operation()}
											>
												<i class="i-ph-arrow-clockwise"></i>
											</button>
										{:else if schema.operation_status !== 'active'}
											<span class="badge badge-warning"
												>{operationStatusLabel(schema.operation_status)}</span
											>
										{:else if !schema.is_active}
											<span class="badge badge-neutral">{$LL.admin_custom_claims_inactive()}</span>
										{:else}
											<span class="badge badge-success">{$LL.admin_custom_claims_active()}</span>
										{/if}
									</td>
								</tr>
							{/each}
						{/if}
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
					{$LL.admin_custom_claims_previous()}
				</button>
				<span class="pagination-info">
					{$LL.admin_custom_claims_page_info({
						page: pagination.page,
						totalPages: pagination.total_pages,
						total: pagination.total
					})}
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page >= pagination.total_pages}
					onclick={() => goToPage(pagination.page + 1)}
				>
					{$LL.admin_custom_claims_next()}
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Preset Modal -->
<Modal
	open={showPresetDialog}
	onClose={() => {
		showPresetDialog = false;
		presetError = '';
	}}
	title={$LL.admin_custom_claims_preset_title()}
	size="lg"
>
	{#if presetError}
		<div class="alert alert-error alert-sm mb-4">{presetError}</div>
	{/if}

	{#if loadingPresets}
		<div class="loading-state compact">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_custom_claims_loading_presets()}</p>
		</div>
	{:else if presets.length === 0}
		<div class="empty-state">
			<p class="empty-state-description">{$LL.admin_custom_claims_no_presets()}</p>
		</div>
	{:else}
		<div class="form-group">
			<label class="form-label" for="claim-preset">{$LL.admin_custom_claims_preset()}</label>
			<select
				id="claim-preset"
				class="form-select"
				bind:value={selectedPresetId}
				onchange={selectMissingPresetFields}
			>
				{#each presets as preset (preset.id)}
					<option value={preset.id}>{preset.label}</option>
				{/each}
			</select>
			{#if currentPreset()}
				<p class="form-hint">{currentPreset()?.description}</p>
			{/if}
		</div>

		{#if currentPreset()}
			<div class="preset-field-list">
				{#each currentPreset()?.fields ?? [] as field (field.field_key)}
					{@const exists = existingPresetFieldKeys.includes(field.field_key)}
					<label class="preset-field" class:disabled={exists}>
						<input
							type="checkbox"
							disabled={exists}
							checked={selectedPresetFieldKeys.includes(field.field_key)}
							onchange={() => togglePresetField(field.field_key)}
						/>
						<span>
							<strong>{field.display_label}</strong>
							<code>{field.field_key}</code>
							<small>{field.description}</small>
						</span>
						<span class="preset-field-meta">
							<span class="badge badge-neutral">{fieldTypeLabel(field.field_type)}</span>
							{#if field.is_pii}
								<span class="badge badge-warning">PII</span>
							{:else}
								<span class="badge badge-success">Non-PII</span>
							{/if}
							{#if exists}
								<span class="badge badge-neutral">{$LL.admin_custom_claims_exists()}</span>
							{/if}
						</span>
					</label>
				{/each}
			</div>
		{/if}

		<div class="modal-actions">
			<button
				class="btn btn-secondary"
				onclick={() => {
					showPresetDialog = false;
					presetError = '';
				}}
				disabled={applyingPreset}
			>
				{$LL.admin_custom_claims_cancel()}
			</button>
			<button
				class="btn btn-primary"
				onclick={applyPreset}
				disabled={applyingPreset || selectedPresetFieldKeys.length === 0}
			>
				{#if applyingPreset}
					<i class="i-ph-circle-notch loading-spinner"></i>
					{$LL.admin_custom_claims_applying()}
				{:else}
					{$LL.admin_custom_claims_apply_selected_fields()}
				{/if}
			</button>
		</div>
	{/if}
</Modal>

<!-- Create Modal -->
<Modal
	open={showCreateDialog}
	onClose={() => {
		showCreateDialog = false;
		createError = '';
	}}
	title={$LL.admin_custom_claims_add_schema()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-error alert-sm mb-4">{createError}</div>
	{/if}

	<div class="form-grid">
		<div class="form-group">
			<label class="form-label" for="create-field-key"
				>{$LL.admin_custom_claims_field_key_required()}</label
			>
			<input
				id="create-field-key"
				type="text"
				class="form-input"
				placeholder={$LL.admin_custom_claims_field_key_placeholder()}
				bind:value={createForm.field_key}
			/>
			<p class="form-hint">
				{$LL.admin_custom_claims_field_key_hint()}
			</p>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-display-label"
				>{$LL.admin_custom_claims_display_label_required()}</label
			>
			<input
				id="create-display-label"
				type="text"
				class="form-input"
				placeholder={$LL.admin_custom_claims_display_label_placeholder()}
				bind:value={createForm.display_label}
			/>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-field-type"
				>{$LL.admin_custom_claims_field_type()}</label
			>
			<select id="create-field-type" class="form-select" bind:value={createForm.field_type}>
				<option value="string">{$LL.admin_custom_claims_field_type_string()}</option>
				<option value="number">{$LL.admin_custom_claims_field_type_number()}</option>
				<option value="boolean">{$LL.admin_custom_claims_field_type_boolean()}</option>
				<option value="date">{$LL.admin_custom_claims_field_type_date()}</option>
				<option value="enum">{$LL.admin_custom_claims_field_type_enum()}</option>
			</select>
		</div>

		<div class="form-group">
			<label class="form-label">
				<input type="checkbox" bind:checked={createForm.is_pii} />
				{$LL.admin_custom_claims_pii_full()}
			</label>
			<p class="form-hint text-amber-600">
				{$LL.admin_custom_claims_pii_hint()}
			</p>
		</div>

		<div class="form-group">
			<label class="form-label">
				<input type="checkbox" bind:checked={createForm.is_required} />
				{$LL.admin_custom_claims_required_field()}
			</label>
		</div>

		<div class="form-group col-span-2">
			<label class="form-label" for="create-description"
				>{$LL.admin_custom_claims_description_label()}</label
			>
			<textarea
				id="create-description"
				class="form-input"
				rows="2"
				placeholder={$LL.admin_custom_claims_description_placeholder()}
				bind:value={createForm.description}
			></textarea>
		</div>

		<div class="form-group col-span-2">
			<label class="form-label" for="create-validation"
				>{$LL.admin_custom_claims_validation_rules()}</label
			>
			<textarea
				id="create-validation"
				class="form-input font-mono text-sm"
				rows="3"
				placeholder={$LL.admin_custom_claims_validation_placeholder()}
				bind:value={createForm.validation_rules_json}
			></textarea>
			<p class="form-hint">
				{$LL.admin_custom_claims_validation_hint()}
			</p>
		</div>

		<!-- Token Integration -->
		<div class="form-group col-span-2">
			<h4 class="font-semibold text-sm mb-2">
				{$LL.admin_custom_claims_token_integration()}
			</h4>
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
						>{$LL.admin_custom_claims_introspection_disabled_use_userinfo()}</small
					>
				</label>
			</div>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-scopes"
				>{$LL.admin_custom_claims_required_scopes()}</label
			>
			<input
				id="create-scopes"
				type="text"
				class="form-input"
				placeholder={$LL.admin_custom_claims_required_scopes_placeholder()}
				bind:value={createForm.required_scopes_text}
			/>
			<p class="form-hint">{$LL.admin_custom_claims_required_scopes_hint()}</p>
		</div>

		<div class="form-group">
			<label class="form-label" for="create-scope-mode"
				>{$LL.admin_custom_claims_scope_mode()}</label
			>
			<select id="create-scope-mode" class="form-select" bind:value={createForm.scope_mode}>
				<option value="any">{$LL.admin_custom_claims_scope_mode_any()}</option>
				<option value="all">{$LL.admin_custom_claims_scope_mode_all()}</option>
			</select>
		</div>

		<div class="form-group col-span-2">
			<label class="form-label" for="create-namespace"
				>{$LL.admin_custom_claims_claim_namespace()}</label
			>
			<input
				id="create-namespace"
				type="text"
				class="form-input"
				placeholder={$LL.admin_custom_claims_claim_namespace_placeholder()}
				bind:value={createForm.claim_namespace}
			/>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showCreateDialog = false)}
			>{$LL.admin_custom_claims_cancel()}</button
		>
		<button class="btn btn-primary" onclick={submitCreate} disabled={creating}>
			{creating ? $LL.admin_custom_claims_creating() : $LL.admin_custom_claims_create()}
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
	title={$LL.admin_custom_claims_delete_title()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error alert-sm mb-4">{deleteError}</div>
	{/if}

	{#if schemaToDelete}
		<div class="alert alert-warning mb-4">
			<strong>{$LL.admin_custom_claims_warning_label()}</strong>
			{$LL.admin_custom_claims_delete_warning()}
		</div>

		<div class="bg-gray-50 rounded-lg p-3 mb-4">
			<p>
				<strong>{$LL.admin_custom_claims_field_key()}:</strong>
				<code>{schemaToDelete.field_key}</code>
			</p>
			<p><strong>{$LL.admin_custom_claims_label()}:</strong> {schemaToDelete.display_label}</p>
			<p>
				<strong>{$LL.admin_custom_claims_type()}:</strong>
				{fieldTypeLabel(schemaToDelete.field_type)}
			</p>
			<p>
				<strong>{$LL.admin_custom_claims_storage()}:</strong>
				{schemaToDelete.is_pii
					? $LL.admin_custom_claims_pii_database()
					: $LL.admin_custom_claims_core_database()}
			</p>
			{#if deleteUserCount > 0}
				<p class="text-red-600 font-semibold mt-2">
					{$LL.admin_custom_claims_affected_users({
						prefix: deleteUserCountApproximate ? '~' : '',
						count: deleteUserCount,
						suffix: deleteUserCountApproximate ? $LL.admin_custom_claims_approx() : ''
					})}
				</p>
			{:else if deleteUserCount < 0}
				<p class="text-amber-600 font-semibold mt-2">
					{$LL.admin_custom_claims_fetch_user_count_failed()}
				</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}
			>{$LL.admin_custom_claims_cancel()}</button
		>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_custom_claims_deleting() : $LL.admin_custom_claims_delete_schema_data()}
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
	title={$LL.admin_custom_claims_rename_custom_title()}
	size="md"
>
	{#if renameError}
		<div class="alert alert-error alert-sm mb-4">{renameError}</div>
	{/if}

	{#if schemaToRename}
		<!-- Recommended approach -->
		<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
			<h4 class="font-semibold text-blue-900 text-sm mb-1">
				{$LL.admin_custom_claims_recommended_approach()}
			</h4>
			<ol class="text-sm text-blue-800 list-decimal list-inside space-y-1">
				<li>{$LL.admin_custom_claims_rename_step_deactivate()}</li>
				<li>{$LL.admin_custom_claims_rename_step_create()}</li>
				<li>{$LL.admin_custom_claims_rename_step_migrate()}</li>
				<li>{$LL.admin_custom_claims_rename_step_delete()}</li>
			</ol>
		</div>

		<!-- Direct rename warning -->
		<div class="alert alert-warning mb-4">
			<strong>{$LL.admin_custom_claims_direct_rename_warning_label()}</strong>
			{$LL.admin_custom_claims_direct_rename_warning()}
		</div>

		<div class="bg-gray-50 rounded-lg p-3 mb-4">
			<p>
				<strong>{$LL.admin_custom_claims_current_field_key()}:</strong>
				<code>{schemaToRename.field_key}</code>
			</p>
			{#if renameUserCount > 0}
				<p class="text-amber-600 font-semibold mt-1">
					{$LL.admin_custom_claims_affected_users({
						prefix: renameUserCountApproximate ? '~' : '',
						count: renameUserCount,
						suffix: renameUserCountApproximate ? $LL.admin_custom_claims_approx() : ''
					})}
				</p>
			{:else if renameUserCount < 0}
				<p class="text-amber-600 font-semibold mt-1">
					{$LL.admin_custom_claims_fetch_user_count_failed()}
				</p>
			{/if}
		</div>

		<div class="form-group">
			<label class="form-label" for="rename-new-key"
				>{$LL.admin_custom_claims_new_field_key()}</label
			>
			<input
				id="rename-new-key"
				type="text"
				class="form-input"
				placeholder={$LL.admin_custom_claims_field_key_placeholder()}
				bind:value={renameNewKey}
			/>
			<p class="form-hint">{$LL.admin_custom_claims_field_key_short_hint()}</p>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showRenameDialog = false)}
			>{$LL.admin_custom_claims_cancel()}</button
		>
		<button class="btn btn-warning" onclick={confirmRename} disabled={renaming || !renameNewKey}>
			{renaming ? $LL.admin_custom_claims_renaming() : $LL.admin_custom_claims_rename_field_key()}
		</button>
	{/snippet}
</Modal>

<style>
	.schema-note {
		margin-bottom: 1rem;
		padding: 0.875rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
	}

	.schema-note strong {
		display: block;
		color: var(--text-primary);
		font-size: 0.875rem;
		font-weight: 600;
	}

	.schema-note p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

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

	.loading-state.compact {
		min-height: 8rem;
	}

	.preset-field-list {
		display: grid;
		gap: 0.5rem;
		max-height: min(58vh, 34rem);
		overflow: auto;
		padding-right: 0.25rem;
	}

	.preset-field {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.75rem;
		align-items: center;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		cursor: pointer;
	}

	.preset-field.disabled {
		opacity: 0.65;
		cursor: not-allowed;
	}

	.preset-field strong,
	.preset-field code,
	.preset-field small {
		display: block;
	}

	.preset-field code {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.preset-field small {
		margin-top: 0.25rem;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.preset-field-meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.375rem;
	}

	.usage-bindings {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}

	.usage-binding {
		display: inline-flex;
		align-items: center;
		border-radius: 999px;
		padding: 0.0625rem 0.375rem;
		background: color-mix(in srgb, var(--info, #3b82f6) 10%, transparent);
		color: var(--text-secondary);
		font-size: 0.6875rem;
		font-weight: 600;
	}

	.usage-binding-blocked {
		background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent);
		color: var(--warning, #b45309);
	}

	/* Compact row spacing for schema list */
	:global(.schema-table td) {
		padding: 6px 16px;
	}

	:global(.schema-table th) {
		padding: 8px 16px;
	}

	:global(.schema-table .schema-group-row td) {
		padding: 0;
		background: color-mix(in srgb, var(--bg-subtle) 92%, var(--bg-card));
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}

	.schema-group-toggle {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		border: 0;
		color: var(--text-primary);
		background: transparent;
		font-size: 0.8125rem;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
	}

	.schema-group-toggle:hover,
	.schema-group-toggle:focus-visible {
		background: color-mix(in srgb, var(--primary) 6%, transparent);
		outline: none;
	}

	.schema-group-count {
		min-width: 1.5rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 999px;
		color: var(--primary);
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		font-size: 0.6875rem;
		font-weight: 700;
		text-align: center;
	}
</style>

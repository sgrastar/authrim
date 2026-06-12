<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminCustomClaimsAPI,
		type CustomClaimSchema,
		type FieldType,
		type ScopeMode,
		type ValidationRules,
		type OperationStatus,
		parseValidationRules,
		parseRequiredScopes
	} from '$lib/api/admin-custom-claims';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	const schemaId = $derived($page.params.id ?? '');

	// Data
	let schema = $state<CustomClaimSchema | null>(null);
	let userCount = $state(0);
	let userCountApproximate = $state(false);
	let loading = $state(true);
	let error = $state('');

	// Edit form
	let saving = $state(false);
	let saveError = $state('');
	let saveSuccess = $state(false);
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
		claim_namespace: '',
		is_searchable: false,
		is_exportable: false,
		is_vc_claim: false,
		show_on_registration: false,
		registration_required: false,
		registration_order: 0,
		registration_placeholder: ''
	});

	// Delete dialog
	let showDeleteDialog = $state(false);
	let deleting = $state(false);
	let deleteError = $state('');

	// Rename dialog
	let showRenameDialog = $state(false);
	let renameNewKey = $state('');
	let renaming = $state(false);
	let renameError = $state('');

	// =========================================================================
	// Data Loading
	// =========================================================================

	async function loadSchema() {
		loading = true;
		error = '';

		try {
			const response = await adminCustomClaimsAPI.getSchema(schemaId);
			schema = response.schema;
			userCount = response.user_count;
			userCountApproximate = response.user_count_approximate;
			populateForm(response.schema);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_custom_claims_detail_load_failed();
		} finally {
			loading = false;
		}
	}

	function populateForm(s: CustomClaimSchema) {
		const rules = parseValidationRules(s.validation_rules);
		const scopes = parseRequiredScopes(s.required_scopes);
		editForm = {
			display_label: s.display_label,
			field_type: s.field_type,
			is_required: !!s.is_required,
			is_active: !!s.is_active,
			description: s.description || '',
			validation_rules_json: rules ? JSON.stringify(rules, null, 2) : '',
			include_in_id_token: !!s.include_in_id_token,
			include_in_userinfo: !!s.include_in_userinfo,
			include_in_introspection: !!s.include_in_introspection,
			required_scopes_text: scopes ? scopes.join(', ') : '',
			scope_mode: s.scope_mode,
			display_order: s.display_order,
			claim_namespace: s.claim_namespace || '',
			is_searchable: !!s.is_searchable,
			is_exportable: !!s.is_exportable,
			is_vc_claim: !!s.is_vc_claim,
			show_on_registration: !!s.show_on_registration,
			registration_required: !!s.registration_required,
			registration_order: (s.registration_order as number) ?? 0,
			registration_placeholder: (s.registration_placeholder as string) || ''
		};
	}

	// =========================================================================
	// Save
	// =========================================================================

	async function submitSave() {
		if (!schema) return;

		saving = true;
		saveError = '';
		saveSuccess = false;

		try {
			let validationRules: ValidationRules | null = null;
			if (editForm.validation_rules_json.trim()) {
				try {
					validationRules = JSON.parse(editForm.validation_rules_json);
				} catch {
					saveError = $LL.admin_custom_claims_invalid_json_error();
					saving = false;
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

			const result = await adminCustomClaimsAPI.updateSchema(schema.id, {
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
				claim_namespace: editForm.claim_namespace || null,
				is_searchable: editForm.is_searchable,
				is_exportable: editForm.is_exportable,
				is_vc_claim: editForm.is_vc_claim,
				show_on_registration: editForm.show_on_registration,
				registration_required: editForm.show_on_registration && editForm.registration_required,
				registration_order: editForm.registration_order,
				registration_placeholder: editForm.registration_placeholder || null
			});

			schema = result.schema;
			saveSuccess = true;
			setTimeout(() => (saveSuccess = false), 3000);
		} catch (err) {
			saveError = err instanceof Error ? err.message : $LL.admin_custom_claims_save_failed();
		} finally {
			saving = false;
		}
	}

	// =========================================================================
	// Delete
	// =========================================================================

	async function confirmDelete() {
		if (!schema) return;
		deleting = true;
		deleteError = '';

		try {
			await adminCustomClaimsAPI.deleteSchema(schema.id);
			goto('/admin/schema-settings');
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_custom_claims_delete_failed();
			deleting = false;
		}
	}

	// =========================================================================
	// Rename
	// =========================================================================

	async function confirmRename() {
		if (!schema || !renameNewKey) return;
		renaming = true;
		renameError = '';

		try {
			const result = await adminCustomClaimsAPI.renameSchema(schema.id, renameNewKey);
			schema = result.schema;
			showRenameDialog = false;
			renameNewKey = '';
		} catch (err) {
			renameError = err instanceof Error ? err.message : $LL.admin_custom_claims_rename_failed();
		} finally {
			renaming = false;
		}
	}

	// =========================================================================
	// Retry
	// =========================================================================

	async function retryOperation() {
		if (!schema) return;
		try {
			const result = await adminCustomClaimsAPI.retryOperation(schema.id);
			if (result.schema) schema = result.schema;
		} catch (err) {
			saveError = err instanceof Error ? err.message : $LL.admin_custom_claims_retry_failed();
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

	function formatAdminTimestamp(ts: number): string {
		return new Date(ts * 1000).toLocaleString();
	}

	onMount(() => {
		loadSchema();
	});

	$effect(() => {
		if (!editForm.show_on_registration && editForm.registration_required) {
			editForm.registration_required = false;
		}
	});

	const isSystem = $derived(!!schema?.is_system);
	const hasBlockingUsage = $derived(
		schema?.usage_bindings?.some((binding) => binding.protection === 'delete_blocked') ?? false
	);
	const isEditable = $derived(schema?.operation_status === 'active');
	const registrationConfigDisabled = $derived(!isEditable || !editForm.show_on_registration);
</script>

<svelte:head>
	<title
		>{$LL.admin_custom_claims_detail_head_title({
			label: schema?.display_label ?? $LL.admin_custom_claims_schema_fallback()
		})}</title
	>
</svelte:head>

<div class="admin-page">
	<!-- Breadcrumb -->
	<nav class="breadcrumb mb-4">
		<a href="/admin/schema-settings" class="breadcrumb-link">{$LL.admin_custom_claims_title()}</a>
		<span class="breadcrumb-sep">/</span>
		<span class="breadcrumb-current"
			>{loading ? '...' : (schema?.display_label ?? schema?.field_key ?? schemaId)}</span
		>
	</nav>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_custom_claims_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadSchema}
				>{$LL.admin_custom_claims_retry()}</button
			>
		</div>
	{:else if schema}
		<!-- Page Header -->
		<div class="page-header">
			<div>
				<div class="flex items-center gap-3">
					<h1 class="page-title">{schema.display_label}</h1>
					<code class="text-sm font-mono text-gray-500">{schema.field_key}</code>
					{#if schema.is_pii}
						<span class="badge badge-warning">PII</span>
					{:else}
						<span class="badge badge-success">Non-PII</span>
					{/if}
					{#if isSystem}
						<span class="badge badge-neutral">{$LL.admin_custom_claims_system()}</span>
					{/if}
					{#if schema.is_system_used || hasBlockingUsage}
						<span class="badge badge-warning">{$LL.admin_custom_claims_used_by_system()}</span>
					{/if}
					{#if schema.operation_status !== 'active'}
						<span class="badge badge-warning">{operationStatusLabel(schema.operation_status)}</span>
					{/if}
				</div>
				<p class="page-description">
					{schema.description || $LL.admin_custom_claims_no_description()}
				</p>
				{#if schema.usage_bindings && schema.usage_bindings.length > 0}
					<div class="usage-bindings mt-2">
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
			</div>
			<div class="page-actions">
				<a href="/admin/schema-settings" class="btn btn-secondary">
					<i class="i-ph-arrow-left"></i>
					{$LL.admin_custom_claims_back_to_list()}
				</a>
			</div>
		</div>

		<!-- Operation error banner -->
		{#if schema.operation_status === 'error'}
			<div class="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
				<div class="flex items-center justify-between">
					<div class="flex items-start gap-3">
						<span class="i-ph-warning text-red-600 text-xl mt-0.5"></span>
						<div>
							<h3 class="font-semibold text-red-900">
								{$LL.admin_custom_claims_operation_failed()}
							</h3>
							{#if schema.operation_detail}
								<p class="text-sm text-red-800 mt-1">{schema.operation_detail}</p>
							{/if}
						</div>
					</div>
					<button class="btn btn-secondary btn-sm" onclick={retryOperation}>
						<i class="i-ph-arrow-clockwise"></i>
						{$LL.admin_custom_claims_retry()}
					</button>
				</div>
			</div>
		{/if}

		<!-- Save feedback -->
		{#if saveError}
			<div class="alert alert-error mb-4">{saveError}</div>
		{/if}
		{#if saveSuccess}
			<div class="alert alert-success mb-4">{$LL.admin_custom_claims_changes_saved()}</div>
		{/if}

		<div class="detail-layout">
			<!-- ===== Main settings ===== -->
			<div class="detail-main">
				<!-- Section: Identity & Classification -->
				<div class="panel mb-4">
					<h2 class="panel-title">{$LL.admin_custom_claims_identity_classification()}</h2>

					<div class="form-grid">
						<!-- field_key (read-only) -->
						<div class="form-group">
							<label class="form-label" for="field-key">{$LL.admin_custom_claims_field_key()}</label
							>
							<input
								id="field-key"
								type="text"
								class="form-input"
								value={schema.field_key}
								disabled
							/>
							<p class="form-hint">{$LL.admin_custom_claims_field_key_readonly_hint()}</p>
						</div>

						<!-- display_label -->
						<div class="form-group">
							<label class="form-label" for="display-label"
								>{$LL.admin_custom_claims_display_label()}</label
							>
							<input
								id="display-label"
								type="text"
								class="form-input"
								bind:value={editForm.display_label}
								disabled={!isEditable}
							/>
						</div>

						<!-- field_type -->
						<div class="form-group">
							<label class="form-label" for="field-type"
								>{$LL.admin_custom_claims_field_type()}</label
							>
							<select
								id="field-type"
								class="form-select"
								bind:value={editForm.field_type}
								disabled={!isEditable || isSystem}
							>
								<option value="string">{$LL.admin_custom_claims_field_type_string()}</option>
								<option value="number">{$LL.admin_custom_claims_field_type_number()}</option>
								<option value="boolean">{$LL.admin_custom_claims_field_type_boolean()}</option>
								<option value="date">{$LL.admin_custom_claims_field_type_date()}</option>
								<option value="enum">{$LL.admin_custom_claims_field_type_enum()}</option>
							</select>
						</div>

						<!-- is_pii (read-only after creation) -->
						<div class="form-group">
							<p class="form-label">{$LL.admin_custom_claims_pii_classification()}</p>
							<div class="flex items-center gap-2 mt-1">
								{#if schema.is_pii}
									<span class="badge badge-warning"
										>{$LL.admin_custom_claims_pii_storage_badge()}</span
									>
								{:else}
									<span class="badge badge-success"
										>{$LL.admin_custom_claims_non_pii_storage_badge()}</span
									>
								{/if}
							</div>
							<p class="form-hint text-amber-600">
								{$LL.admin_custom_claims_cannot_change_after_creation()}
							</p>
						</div>

						<!-- display_order -->
						<div class="form-group">
							<label class="form-label" for="display-order"
								>{$LL.admin_custom_claims_display_order()}</label
							>
							<input
								id="display-order"
								type="number"
								class="form-input"
								bind:value={editForm.display_order}
								disabled={!isEditable}
							/>
						</div>

						<!-- description -->
						<div class="form-group col-span-2">
							<label class="form-label" for="description"
								>{$LL.admin_custom_claims_description_label()}</label
							>
							<textarea
								id="description"
								class="form-input"
								rows="2"
								bind:value={editForm.description}
								disabled={!isEditable}
							></textarea>
						</div>

						<!-- toggles -->
						<div class="form-group">
							<label class="form-label">
								<input type="checkbox" bind:checked={editForm.is_required} disabled={!isEditable} />
								{$LL.admin_custom_claims_required_field()}
							</label>
						</div>

						<div class="form-group">
							<label class="form-label">
								<input type="checkbox" bind:checked={editForm.is_active} disabled={!isEditable} />
								{$LL.admin_custom_claims_active()}
							</label>
						</div>
					</div>
				</div>

				<!-- Section: Token & Endpoint Inclusion -->
				<div class="panel mb-4">
					<h2 class="panel-title">{$LL.admin_custom_claims_token_endpoint_inclusion()}</h2>
					<p class="text-sm text-gray-500 mb-4">
						{$LL.admin_custom_claims_token_endpoint_description()}
					</p>

					<div class="form-grid">
						<div class="form-group col-span-2">
							<div class="flex gap-6 flex-wrap">
								<label class="form-label">
									<input
										type="checkbox"
										bind:checked={editForm.include_in_id_token}
										disabled={!isEditable}
									/>
									ID Token
								</label>
								<label class="form-label">
									<input
										type="checkbox"
										bind:checked={editForm.include_in_userinfo}
										disabled={!isEditable}
									/>
									UserInfo
								</label>
								<label class="form-label flex-col items-start">
									<span class="flex items-center gap-1">
										<input
											type="checkbox"
											bind:checked={editForm.include_in_introspection}
											disabled={!isEditable}
										/>
										Introspection
									</span>
									<small style="color: var(--color-warning, #b08800); font-size: 0.75rem;"
										>{$LL.admin_custom_claims_introspection_disabled()}</small
									>
								</label>
							</div>
						</div>

						<div class="form-group">
							<label class="form-label" for="required-scopes"
								>{$LL.admin_custom_claims_required_scopes()}</label
							>
							<input
								id="required-scopes"
								type="text"
								class="form-input"
								placeholder={$LL.admin_custom_claims_required_scopes_placeholder()}
								bind:value={editForm.required_scopes_text}
								disabled={!isEditable}
							/>
							<p class="form-hint">{$LL.admin_custom_claims_required_scopes_hint()}</p>
						</div>

						<div class="form-group">
							<label class="form-label" for="scope-mode"
								>{$LL.admin_custom_claims_scope_mode()}</label
							>
							<select
								id="scope-mode"
								class="form-select"
								bind:value={editForm.scope_mode}
								disabled={!isEditable}
							>
								<option value="any">{$LL.admin_custom_claims_scope_mode_any()}</option>
								<option value="all">{$LL.admin_custom_claims_scope_mode_all()}</option>
							</select>
						</div>

						<div class="form-group col-span-2">
							<label class="form-label" for="claim-namespace"
								>{$LL.admin_custom_claims_claim_namespace()}</label
							>
							<input
								id="claim-namespace"
								type="text"
								class="form-input"
								placeholder={$LL.admin_custom_claims_claim_namespace_placeholder()}
								bind:value={editForm.claim_namespace}
								disabled={!isEditable}
							/>
						</div>
					</div>
				</div>

				<!-- Section: Validation Rules -->
				<div class="panel mb-4">
					<h2 class="panel-title">{$LL.admin_custom_claims_validation_rules_title()}</h2>
					<p class="text-sm text-gray-500 mb-3">
						{$LL.admin_custom_claims_validation_hint()}
					</p>
					<textarea
						class="form-input font-mono text-sm w-full"
						rows="5"
						placeholder={$LL.admin_custom_claims_validation_placeholder()}
						bind:value={editForm.validation_rules_json}
						disabled={!isEditable}
					></textarea>
				</div>

				<!-- Section: Advanced -->
				<div class="panel mb-4">
					<h2 class="panel-title">{$LL.admin_custom_claims_advanced()}</h2>
					<div class="flex gap-6 flex-wrap">
						<label class="form-label">
							<input type="checkbox" bind:checked={editForm.is_searchable} disabled={!isEditable} />
							{$LL.admin_custom_claims_searchable()}
						</label>
						<label class="form-label">
							<input type="checkbox" bind:checked={editForm.is_exportable} disabled={!isEditable} />
							{$LL.admin_custom_claims_exportable()}
						</label>
						<label class="form-label">
							<input type="checkbox" bind:checked={editForm.is_vc_claim} disabled={!isEditable} />
							{$LL.admin_custom_claims_vc_claim()}
						</label>
					</div>
				</div>

				<!-- Section: Registration Form -->
				<div class="panel mb-4">
					<h2 class="panel-title">{$LL.admin_custom_claims_registration_form()}</h2>
					<div class="flex gap-6 flex-wrap mb-4">
						<label class="form-label">
							<input
								type="checkbox"
								bind:checked={editForm.show_on_registration}
								disabled={!isEditable}
							/>
							{$LL.admin_custom_claims_show_on_signup()}
						</label>
						<label class="form-label">
							<input
								type="checkbox"
								bind:checked={editForm.registration_required}
								disabled={registrationConfigDisabled}
							/>
							{$LL.admin_custom_claims_required_on_signup()}
						</label>
					</div>
					<div
						class="registration-settings"
						class:is-disabled={registrationConfigDisabled}
						aria-disabled={registrationConfigDisabled}
					>
						{#if editForm.show_on_registration}
							<div class="flex gap-4 flex-wrap">
								<div style="min-width:120px;">
									<label class="form-label" for="reg-order"
										>{$LL.admin_custom_claims_registration_display_order()}</label
									>
									<input
										id="reg-order"
										type="number"
										bind:value={editForm.registration_order}
										disabled={!isEditable}
										min="0"
										class="form-input"
									/>
								</div>
								<div style="flex:1; min-width:200px;">
									<label class="form-label" for="reg-placeholder"
										>{$LL.admin_custom_claims_registration_placeholder()}</label
									>
									<input
										id="reg-placeholder"
										type="text"
										bind:value={editForm.registration_placeholder}
										disabled={!isEditable}
										placeholder={$LL.admin_custom_claims_registration_placeholder_example()}
										class="form-input"
									/>
								</div>
							</div>
						{:else}
							<p class="registration-disabled-hint">
								{$LL.admin_custom_claims_registration_disabled_hint()}
							</p>
						{/if}
					</div>
				</div>

				<!-- Save button -->
				{#if isEditable}
					<div class="flex justify-end">
						<button class="btn btn-primary" onclick={submitSave} disabled={saving}>
							{saving ? $LL.admin_custom_claims_saving() : $LL.admin_custom_claims_save_changes()}
						</button>
					</div>
				{/if}

				<!-- Danger Zone -->
				<div class="danger-panel mt-6">
					<h2 class="panel-title danger-title">{$LL.admin_custom_claims_danger_zone()}</h2>

					<div class="flex flex-col gap-3">
						<!-- Rename -->
						<div class="danger-zone-row">
							<div>
								<p class="danger-zone-row-title">
									{$LL.admin_custom_claims_rename_field_key()}
								</p>
								<p class="danger-zone-description">
									{$LL.admin_custom_claims_rename_description()}
								</p>
							</div>
							<button
								class="btn btn-secondary btn-sm"
								onclick={() => {
									renameNewKey = '';
									renameError = '';
									showRenameDialog = true;
								}}
								disabled={isSystem || !isEditable}
								title={isSystem ? $LL.admin_custom_claims_system_rename_disabled() : undefined}
							>
								<i class="i-ph-pencil-simple"></i>
								{$LL.admin_custom_claims_rename()}
							</button>
						</div>

						<!-- Delete -->
						<div class="danger-zone-row">
							<div>
								<p class="danger-zone-row-title">{$LL.admin_custom_claims_delete_schema()}</p>
								<p class="danger-zone-description">
									{$LL.admin_custom_claims_delete_description()}
									{#if userCount > 0}
										<span class="danger-zone-affected">
											{$LL.admin_custom_claims_user_data_loss({
												prefix: userCountApproximate ? '~' : '',
												count: userCount
											})}
										</span>
									{/if}
								</p>
							</div>
							<button
								class="btn btn-danger btn-sm"
								onclick={() => {
									deleteError = '';
									showDeleteDialog = true;
								}}
								disabled={isSystem ||
									hasBlockingUsage ||
									(schema.operation_status !== 'active' && schema.operation_status !== 'error')}
								title={isSystem
									? $LL.admin_custom_claims_system_delete_disabled()
									: hasBlockingUsage
										? $LL.admin_custom_claims_system_usage_delete_disabled()
										: undefined}
							>
								<i class="i-ph-trash"></i>
								{$LL.admin_custom_claims_delete()}
							</button>
						</div>
					</div>
				</div>
			</div>

			<!-- ===== Sidebar ===== -->
			<div class="detail-sidebar">
				<div class="panel">
					<h3 class="font-semibold text-sm mb-3">{$LL.admin_custom_claims_details()}</h3>
					<dl class="detail-dl">
						<dt>{$LL.admin_custom_claims_schema_version()}</dt>
						<dd>{schema.schema_version}</dd>

						<dt>{$LL.admin_custom_claims_storage()}</dt>
						<dd>
							{schema.is_pii
								? $LL.admin_custom_claims_pii_database()
								: $LL.admin_custom_claims_core_database()}
						</dd>

						<dt>{$LL.admin_custom_claims_users_with_data()}</dt>
						<dd>
							{#if userCountApproximate}~{/if}{userCount}
							{userCountApproximate ? $LL.admin_custom_claims_approx_short() : ''}
						</dd>

						<dt>{$LL.admin_custom_claims_created()}</dt>
						<dd>{formatAdminTimestamp(schema.created_at)}</dd>

						<dt>{$LL.admin_custom_claims_updated()}</dt>
						<dd>{formatAdminTimestamp(schema.updated_at)}</dd>

						{#if schema.created_by}
							<dt>{$LL.admin_custom_claims_created_by()}</dt>
							<dd><code class="text-xs">{schema.created_by}</code></dd>
						{/if}
					</dl>
				</div>
			</div>
		</div>
	{/if}
</div>

<!-- Rename Modal -->
<Modal
	open={showRenameDialog}
	onClose={() => {
		showRenameDialog = false;
		renameError = '';
		renameNewKey = '';
	}}
	title={$LL.admin_custom_claims_rename_title()}
	size="md"
>
	{#if renameError}
		<div class="alert alert-error alert-sm mb-4">{renameError}</div>
	{/if}

	<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
		<h4 class="font-semibold text-blue-900 text-sm mb-1">
			{$LL.admin_custom_claims_recommended_approach_lower()}
		</h4>
		<ol class="text-sm text-blue-800 list-decimal list-inside space-y-1">
			<li>{$LL.admin_custom_claims_rename_step_deactivate()}</li>
			<li>{$LL.admin_custom_claims_rename_step_create()}</li>
			<li>{$LL.admin_custom_claims_rename_step_migrate()}</li>
			<li>{$LL.admin_custom_claims_rename_step_delete()}</li>
		</ol>
	</div>

	<div class="alert alert-warning mb-4">
		<strong>{$LL.admin_custom_claims_warning_label()}</strong>
		{$LL.admin_custom_claims_rename_warning()}
	</div>

	<div class="bg-gray-50 rounded-lg p-3 mb-4">
		<p class="text-sm">
			<strong>{$LL.admin_custom_claims_current_key()}:</strong>
			<code>{schema?.field_key}</code>
		</p>
		{#if userCount > 0}
			<p class="text-amber-600 font-semibold text-sm mt-1">
				{$LL.admin_custom_claims_affected_users({
					prefix: userCountApproximate ? '~' : '',
					count: userCount,
					suffix: userCountApproximate ? $LL.admin_custom_claims_approx_short() : ''
				})}
			</p>
		{/if}
	</div>

	<div class="form-group">
		<label class="form-label" for="rename-new-key">{$LL.admin_custom_claims_new_field_key()}</label>
		<input
			id="rename-new-key"
			type="text"
			class="form-input"
			placeholder={$LL.admin_custom_claims_field_key_placeholder()}
			bind:value={renameNewKey}
		/>
		<p class="form-hint">{$LL.admin_custom_claims_field_key_short_hint()}</p>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showRenameDialog = false)}
			>{$LL.admin_custom_claims_cancel()}</button
		>
		<button class="btn btn-warning" onclick={confirmRename} disabled={renaming || !renameNewKey}>
			{renaming ? $LL.admin_custom_claims_renaming() : $LL.admin_custom_claims_rename_field_key()}
		</button>
	{/snippet}
</Modal>

<!-- Delete Modal -->
<Modal
	open={showDeleteDialog}
	onClose={() => {
		showDeleteDialog = false;
		deleteError = '';
	}}
	title={$LL.admin_custom_claims_delete_title()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error alert-sm mb-4">{deleteError}</div>
	{/if}

	{#if schema}
		<div class="alert alert-warning mb-4">
			<strong>{$LL.admin_custom_claims_warning_label()}</strong>
			{$LL.admin_custom_claims_delete_warning()}
		</div>

		<div class="bg-gray-50 rounded-lg p-3 mb-4">
			<p class="text-sm">
				<strong>{$LL.admin_custom_claims_field_key()}:</strong>
				<code>{schema.field_key}</code>
			</p>
			<p class="text-sm">
				<strong>{$LL.admin_custom_claims_label()}:</strong>
				{schema.display_label}
			</p>
			<p class="text-sm">
				<strong>{$LL.admin_custom_claims_storage()}:</strong>
				{schema.is_pii
					? $LL.admin_custom_claims_pii_database()
					: $LL.admin_custom_claims_core_database()}
			</p>
			{#if userCount > 0}
				<p class="text-red-600 font-semibold text-sm mt-2">
					{$LL.admin_custom_claims_affected_users({
						prefix: userCountApproximate ? '~' : '',
						count: userCount,
						suffix: userCountApproximate ? $LL.admin_custom_claims_approx_short() : ''
					})}
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

<style>
	.detail-layout {
		display: grid;
		grid-template-columns: 1fr 280px;
		gap: 1.5rem;
		align-items: start;
	}

	.detail-main {
		min-width: 0;
	}

	.detail-sidebar {
		position: sticky;
		top: 1rem;
	}

	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.breadcrumb-link {
		color: var(--color-primary, #3b82f6);
		text-decoration: none;
	}

	.breadcrumb-link:hover {
		text-decoration: underline;
	}

	.breadcrumb-sep {
		color: #9ca3af;
	}

	.breadcrumb-current {
		color: #374151;
	}

	.panel-title {
		font-size: 1rem;
		font-weight: 600;
		margin-bottom: 1rem;
	}

	/* Danger Zone */
	.danger-panel {
		background: var(--bg-card, #fff);
		border: 1px solid color-mix(in srgb, var(--danger, #dc2626) 30%, var(--border, #e5e7eb));
		border-radius: 8px;
		padding: 1.25rem;
	}

	.danger-title {
		color: var(--danger, #dc2626);
	}

	.danger-zone-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem;
		background: color-mix(in srgb, var(--danger, #dc2626) 5%, var(--bg-subtle, #f8fafc));
		border: 1px solid color-mix(in srgb, var(--danger, #dc2626) 20%, var(--border, #e5e7eb));
		border-radius: 6px;
	}

	.danger-zone-row-title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary, #111827);
		margin: 0 0 0.25rem 0;
	}

	.danger-zone-description {
		font-size: 0.75rem;
		color: var(--text-secondary, #6b7280);
		margin: 0;
	}

	.danger-zone-affected {
		color: var(--danger, #dc2626);
		font-weight: 500;
	}

	.usage-bindings {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.usage-binding {
		display: inline-flex;
		align-items: center;
		border-radius: 999px;
		padding: 0.0625rem 0.375rem;
		background: color-mix(in srgb, var(--info, #3b82f6) 10%, transparent);
		color: var(--text-secondary, #6b7280);
		font-size: 0.6875rem;
		font-weight: 600;
	}

	.usage-binding-blocked {
		background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent);
		color: var(--warning, #b45309);
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

	.registration-settings {
		border: 1px dashed color-mix(in srgb, var(--border, #e5e7eb) 85%, transparent);
		border-radius: 8px;
		padding: 0.875rem;
		transition:
			opacity 0.15s ease,
			border-color 0.15s ease;
	}

	.registration-settings.is-disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.registration-settings.is-disabled :global(input),
	.registration-settings.is-disabled :global(select),
	.registration-settings.is-disabled :global(textarea) {
		cursor: not-allowed;
	}

	.registration-disabled-hint {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-secondary, #6b7280);
	}

	.detail-dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.375rem 0.75rem;
		font-size: 0.8125rem;
	}

	.detail-dl dt {
		color: #6b7280;
		white-space: nowrap;
	}

	.detail-dl dd {
		color: #111827;
		word-break: break-all;
		margin: 0;
	}

	@media (max-width: 768px) {
		.detail-layout {
			grid-template-columns: 1fr;
		}

		.detail-sidebar {
			position: static;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}

		.col-span-2 {
			grid-column: span 1;
		}
	}
</style>

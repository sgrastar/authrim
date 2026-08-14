<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminCustomClaimsAPI,
		type Cardinality,
		type CustomClaimSchema,
		type FieldType,
		type ValidationRules,
		type OperationStatus,
		parseValidationRules
	} from '$lib/api/admin-custom-claims';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
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
		cardinality: 'single' as Cardinality,
		is_required: false,
		is_active: true,
		description: '',
		validation_rules_json: '',
		display_order: 0,
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
		editForm = {
			display_label: s.display_label,
			field_type: s.field_type,
			cardinality: s.cardinality ?? 'single',
			is_required: !!s.is_required,
			is_active: !!s.is_active,
			description: s.description || '',
			validation_rules_json: rules ? JSON.stringify(rules, null, 2) : '',
			display_order: s.display_order,
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

			const result = await adminCustomClaimsAPI.updateSchema(schema.id, {
				display_label: editForm.display_label,
				field_type: editForm.field_type,
				cardinality: editForm.cardinality,
				is_required: editForm.is_required,
				is_active: editForm.is_active,
				description: editForm.description || null,
				validation_rules: validationRules,
				display_order: editForm.display_order,
				is_searchable: editForm.is_searchable,
				is_exportable: editForm.is_exportable,
				is_vc_claim: editForm.is_vc_claim,
				show_on_registration: editForm.show_on_registration,
				registration_required: editForm.registration_required,
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
			goto('/admin/custom-claims');
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
			case 'reconfiguring':
				return $LL.admin_custom_claims_status_reconfiguring();
			case 'error':
				return $LL.admin_custom_claims_status_error();
			default:
				return status;
		}
	}

	function formatAdminTimestamp(ts: number): string {
		return new Date(ts * 1000).toLocaleString();
	}

	onMount(() => {
		loadSchema();
	});

	const isSystem = $derived(!!schema?.is_system);
	const isEditable = $derived(schema?.operation_status === 'active');
	const registrationConfigDisabled = $derived(!isEditable);
</script>

<svelte:head>
	<title
		>{$LL.admin_custom_claims_detail_head_title({
			label: schema?.display_label ?? $LL.admin_custom_claims_schema_fallback()
		})}</title
	>
</svelte:head>

{#snippet pageActions()}
	<a href="/admin/custom-claims" class="btn btn-secondary">
		<i class="i-ph-arrow-left"></i>
		{$LL.admin_custom_claims_back_to_list()}
	</a>
{/snippet}

{#snippet titleAccessory()}
	{#if schema}
		<code class="schema-key">{schema.field_key}</code>
		{#if schema.is_pii}
			<span class="badge badge-warning">PII</span>
		{:else}
			<span class="badge badge-success">Non-PII</span>
		{/if}
		{#if isSystem}
			<span class="badge badge-neutral">{$LL.admin_custom_claims_system()}</span>
		{/if}
		{#if schema.operation_status !== 'active'}
			<span class="badge badge-warning">{operationStatusLabel(schema.operation_status)}</span>
		{/if}
	{/if}
{/snippet}

<AdminPageShell>
	{#if loading}
		<AdminSection>
			<div class="loading-state">
				<i class="i-ph-circle-notch loading-spinner"></i>
				<p>{$LL.admin_custom_claims_loading()}</p>
			</div>
		</AdminSection>
	{:else if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadSchema}
				>{$LL.admin_custom_claims_retry()}</button
			>
		</div>
	{:else if schema}
		<AdminPageHeader
			title={schema.display_label}
			description={schema.description || $LL.admin_custom_claims_no_description()}
			{titleAccessory}
			actions={pageActions}
		/>

		<!-- Operation error banner -->
		{#if schema.operation_status === 'error'}
			<div class="operation-error-banner">
				<div class="operation-error-content">
					<div class="operation-error-message">
						<span class="i-ph-warning" aria-hidden="true"></span>
						<div>
							<h3>{$LL.admin_custom_claims_operation_failed()}</h3>
							{#if schema.operation_detail}
								<p>{schema.operation_detail}</p>
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
			<div class="alert alert-error">{saveError}</div>
		{/if}
		{#if saveSuccess}
			<div class="alert alert-success">{$LL.admin_custom_claims_changes_saved()}</div>
		{/if}

		<div class="detail-layout">
			<!-- ===== Main settings ===== -->
			<div class="detail-main">
				<!-- Section: Identity & Classification -->
				<AdminSection title={$LL.admin_custom_claims_identity_classification()}>
					<div class="form-grid">
						<!-- field_key (read-only) -->
						<div class="admin-field">
							<label class="admin-field__label" for="field-key"
								>{$LL.admin_custom_claims_field_key()}</label
							>
							<input
								id="field-key"
								type="text"
								class="admin-input"
								value={schema.field_key}
								disabled
							/>
							<p class="field-hint">{$LL.admin_custom_claims_field_key_readonly_hint()}</p>
						</div>

						<!-- display_label -->
						<div class="admin-field">
							<label class="admin-field__label" for="display-label"
								>{$LL.admin_custom_claims_display_label()}</label
							>
							<input
								id="display-label"
								type="text"
								class="admin-input"
								bind:value={editForm.display_label}
								disabled={!isEditable}
							/>
						</div>

						<!-- field_type -->
						<div class="admin-field">
							<label class="admin-field__label" for="field-type"
								>{$LL.admin_custom_claims_field_type()}</label
							>
							<select
								id="field-type"
								class="admin-select"
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

						<div class="admin-field">
							<label class="admin-field__label" for="cardinality"
								>{$LL.admin_custom_claims_cardinality()}</label
							>
							<select
								id="cardinality"
								class="admin-select"
								bind:value={editForm.cardinality}
								disabled={!isEditable || isSystem}
							>
								<option value="single">{$LL.admin_custom_claims_cardinality_single()}</option>
								<option value="multi">{$LL.admin_custom_claims_cardinality_multi()}</option>
							</select>
							<p class="field-hint">{$LL.admin_custom_claims_cardinality_hint()}</p>
						</div>

						<!-- is_pii (read-only after creation) -->
						<div class="admin-field">
							<p class="admin-field__label">{$LL.admin_custom_claims_pii_classification()}</p>
							<div class="inline-badges">
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
							<p class="field-hint field-hint--warning">
								{$LL.admin_custom_claims_cannot_change_after_creation()}
							</p>
						</div>

						<!-- display_order -->
						<div class="admin-field">
							<label class="admin-field__label" for="display-order"
								>{$LL.admin_custom_claims_display_order()}</label
							>
							<input
								id="display-order"
								type="number"
								class="admin-input"
								bind:value={editForm.display_order}
								disabled={!isEditable}
							/>
						</div>

						<!-- description -->
						<div class="admin-field col-span-2">
							<label class="admin-field__label" for="description"
								>{$LL.admin_custom_claims_description_label()}</label
							>
							<textarea
								id="description"
								class="admin-input"
								rows="2"
								bind:value={editForm.description}
								disabled={!isEditable}
							></textarea>
						</div>

						<!-- toggles -->
						<div class="admin-field">
							<label class="admin-field__label">
								<input type="checkbox" bind:checked={editForm.is_required} disabled={!isEditable} />
								{$LL.admin_custom_claims_required_field()}
							</label>
						</div>

						<div class="admin-field">
							<label class="admin-field__label">
								<input type="checkbox" bind:checked={editForm.is_active} disabled={!isEditable} />
								{$LL.admin_custom_claims_active()}
							</label>
						</div>
					</div>
				</AdminSection>

				<AdminSection title={$LL.admin_custom_claims_release_mapping_title()}>
					<p class="section-hint">
						{$LL.admin_custom_claims_release_mapping_hint()}
					</p>
				</AdminSection>

				<!-- Section: Validation Rules -->
				<AdminSection title={$LL.admin_custom_claims_validation_rules_title()}>
					<p class="section-hint">
						{$LL.admin_custom_claims_validation_hint()}
					</p>
					<textarea
						class="admin-input admin-input--mono"
						rows="5"
						placeholder={$LL.admin_custom_claims_validation_placeholder()}
						bind:value={editForm.validation_rules_json}
						disabled={!isEditable}
					></textarea>
				</AdminSection>

				<!-- Section: Advanced -->
				<AdminSection title={$LL.admin_custom_claims_advanced()}>
					<div class="check-list check-list--inline">
						<label class="admin-field__label">
							<input type="checkbox" bind:checked={editForm.is_searchable} disabled={!isEditable} />
							{$LL.admin_custom_claims_searchable()}
						</label>
						<label class="admin-field__label">
							<input type="checkbox" bind:checked={editForm.is_exportable} disabled={!isEditable} />
							{$LL.admin_custom_claims_exportable()}
						</label>
						<label class="admin-field__label">
							<input type="checkbox" bind:checked={editForm.is_vc_claim} disabled={!isEditable} />
							{$LL.admin_custom_claims_vc_claim()}
						</label>
					</div>
				</AdminSection>

				<!-- Section: Registration Form -->
				<AdminSection title={$LL.admin_custom_claims_registration_form()}>
					<div class="check-list check-list--inline">
						<label class="admin-field__label">
							<input
								type="checkbox"
								bind:checked={editForm.show_on_registration}
								disabled={!isEditable}
							/>
							{$LL.admin_custom_claims_show_on_signup()}
						</label>
						<label class="admin-field__label">
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
							<div class="registration-grid">
								<div class="registration-order-field">
									<label class="admin-field__label" for="reg-order"
										>{$LL.admin_custom_claims_registration_display_order()}</label
									>
									<input
										id="reg-order"
										type="number"
										bind:value={editForm.registration_order}
										disabled={!isEditable}
										min="0"
										class="admin-input"
									/>
								</div>
								<div class="registration-placeholder-field">
									<label class="admin-field__label" for="reg-placeholder"
										>{$LL.admin_custom_claims_registration_placeholder()}</label
									>
									<input
										id="reg-placeholder"
										type="text"
										bind:value={editForm.registration_placeholder}
										disabled={!isEditable}
										placeholder={$LL.admin_custom_claims_registration_placeholder_example()}
										class="admin-input"
									/>
								</div>
							</div>
						{:else}
							<p class="registration-disabled-hint">
								{$LL.admin_custom_claims_registration_disabled_hint()}
							</p>
						{/if}
					</div>
				</AdminSection>

				<!-- Save button -->
				{#if isEditable}
					<div class="save-actions">
						<button class="btn btn-primary" onclick={submitSave} disabled={saving}>
							{saving ? $LL.admin_custom_claims_saving() : $LL.admin_custom_claims_save_changes()}
						</button>
					</div>
				{/if}

				<!-- Danger Zone -->
				<AdminSection title={$LL.admin_custom_claims_danger_zone()}>
					<div class="danger-panel">
						<div class="danger-list">
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
										(schema.operation_status !== 'active' && schema.operation_status !== 'error')}
									title={isSystem ? $LL.admin_custom_claims_system_delete_disabled() : undefined}
								>
									<i class="i-ph-trash"></i>
									{$LL.admin_custom_claims_delete()}
								</button>
							</div>
						</div>
					</div>
				</AdminSection>
			</div>

			<!-- ===== Sidebar ===== -->
			<div class="detail-sidebar">
				<AdminSection title={$LL.admin_custom_claims_details()}>
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
							<dd><code class="admin-code admin-code--tiny">{schema.created_by}</code></dd>
						{/if}
					</dl>
				</AdminSection>
			</div>
		</div>
	{/if}
</AdminPageShell>

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
		<div class="alert alert-error alert-sm modal-alert">{renameError}</div>
	{/if}

	<div class="recommended-approach">
		<h4>
			{$LL.admin_custom_claims_recommended_approach_lower()}
		</h4>
		<ol>
			<li>{$LL.admin_custom_claims_rename_step_deactivate()}</li>
			<li>{$LL.admin_custom_claims_rename_step_create()}</li>
			<li>{$LL.admin_custom_claims_rename_step_migrate()}</li>
			<li>{$LL.admin_custom_claims_rename_step_delete()}</li>
		</ol>
	</div>

	<div class="alert alert-warning modal-alert">
		<strong>{$LL.admin_custom_claims_warning_label()}</strong>
		{$LL.admin_custom_claims_rename_warning()}
	</div>

	<div class="modal-summary">
		<p>
			<strong>{$LL.admin_custom_claims_current_key()}:</strong>
			<code>{schema?.field_key}</code>
		</p>
		{#if userCount > 0}
			<p class="modal-impact modal-impact--warning">
				{$LL.admin_custom_claims_affected_users({
					prefix: userCountApproximate ? '~' : '',
					count: userCount,
					suffix: userCountApproximate ? $LL.admin_custom_claims_approx_short() : ''
				})}
			</p>
		{/if}
	</div>

	<div class="admin-field">
		<label class="admin-field__label" for="rename-new-key"
			>{$LL.admin_custom_claims_new_field_key()}</label
		>
		<input
			id="rename-new-key"
			type="text"
			class="admin-input"
			placeholder={$LL.admin_custom_claims_field_key_placeholder()}
			bind:value={renameNewKey}
		/>
		<p class="field-hint">{$LL.admin_custom_claims_field_key_short_hint()}</p>
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
		<div class="alert alert-error alert-sm modal-alert">{deleteError}</div>
	{/if}

	{#if schema}
		<div class="alert alert-warning modal-alert">
			<strong>{$LL.admin_custom_claims_warning_label()}</strong>
			{$LL.admin_custom_claims_delete_warning()}
		</div>

		<div class="modal-summary">
			<p>
				<strong>{$LL.admin_custom_claims_field_key()}:</strong>
				<code>{schema.field_key}</code>
			</p>
			<p>
				<strong>{$LL.admin_custom_claims_label()}:</strong>
				{schema.display_label}
			</p>
			<p>
				<strong>{$LL.admin_custom_claims_storage()}:</strong>
				{schema.is_pii
					? $LL.admin_custom_claims_pii_database()
					: $LL.admin_custom_claims_core_database()}
			</p>
			{#if userCount > 0}
				<p class="modal-impact modal-impact--danger modal-impact--spaced">
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

	.schema-key {
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	.operation-error-banner {
		margin-bottom: 18px;
		padding: 14px 16px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		border-radius: var(--radius-card);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.operation-error-content,
	.operation-error-message,
	.inline-badges,
	.check-list {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.operation-error-content {
		justify-content: space-between;
	}

	.operation-error-message {
		align-items: flex-start;
	}

	.operation-error-message h3,
	.operation-error-message p,
	.section-hint {
		margin: 0;
	}

	.operation-error-message h3 {
		font-size: 0.92rem;
		font-weight: 700;
	}

	.operation-error-message p {
		margin-top: 4px;
		font-size: 0.84rem;
		line-height: 1.55;
	}

	.section-hint {
		margin-bottom: 14px;
		color: var(--color-text-muted);
		font-size: 0.85rem;
		line-height: 1.6;
	}

	.check-list {
		flex-wrap: wrap;
		gap: 14px 24px;
	}

	.save-actions {
		display: flex;
		justify-content: flex-end;
	}

	.admin-field {
		display: grid;
		gap: 6px;
	}

	.admin-field__label {
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 700;
	}

	.admin-input,
	.admin-select {
		width: 100%;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.admin-input:focus,
	.admin-select:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.admin-input:disabled,
	.admin-select:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}

	.admin-input--mono,
	textarea.admin-input {
		font-family: var(--font-mono);
		font-size: 0.82rem;
		line-height: 1.55;
		resize: vertical;
	}

	.field-hint {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		line-height: 1.45;
	}

	.field-hint--warning {
		color: var(--color-warning);
	}

	.modal-alert {
		margin-bottom: 1rem;
	}

	.admin-code {
		font-family: var(--font-mono);
		color: var(--color-text);
	}

	.admin-code--tiny {
		font-size: 0.72rem;
	}

	.recommended-approach,
	.modal-summary {
		margin-bottom: 1rem;
		padding: 0.75rem;
		border-radius: var(--radius-card);
	}

	.recommended-approach {
		border: 1px solid color-mix(in srgb, var(--color-info) 28%, var(--color-border));
		background: color-mix(in srgb, var(--color-info) 10%, var(--color-surface));
	}

	.recommended-approach h4 {
		margin: 0 0 0.25rem;
		color: var(--color-info-700);
		font-size: 0.875rem;
		font-weight: 700;
	}

	.recommended-approach ol {
		margin: 0;
		padding-left: 1.25rem;
		color: var(--color-info-700);
		font-size: 0.875rem;
		line-height: 1.55;
	}

	.modal-summary {
		background: var(--color-surface-muted);
	}

	.modal-summary p {
		margin: 0;
		color: var(--color-text);
		font-size: 0.875rem;
		line-height: 1.55;
	}

	.modal-summary p + p {
		margin-top: 0.25rem;
	}

	.modal-impact {
		font-weight: 700;
	}

	.modal-impact--spaced {
		margin-top: 0.5rem;
	}

	.modal-impact--warning {
		color: var(--color-warning);
	}

	.modal-impact--danger {
		color: var(--color-danger);
	}

	/* Danger Zone */
	.danger-panel {
		background: var(
			--danger-zone-bg,
			color-mix(in srgb, var(--color-danger) 5%, var(--color-surface))
		);
		border: var(
			--danger-zone-border,
			1px solid color-mix(in srgb, var(--color-danger) 30%, var(--color-border))
		);
		border-radius: var(--danger-zone-radius, var(--radius-panel));
		padding: var(--danger-zone-padding, 1.25rem);
	}

	.danger-list {
		display: grid;
		gap: 12px;
	}

	.danger-zone-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem;
		background: var(--danger-zone-row-bg, var(--color-surface));
		border: var(
			--danger-zone-row-border,
			1px solid color-mix(in srgb, var(--color-danger) 20%, var(--color-border))
		);
		border-radius: var(--danger-zone-row-radius, var(--radius-control));
	}

	.danger-zone-row-title {
		font-size: var(--danger-zone-title-size, 0.875rem);
		font-weight: var(--danger-zone-title-weight, 500);
		color: var(--color-text);
		margin: 0 0 0.25rem 0;
	}

	.danger-zone-description {
		font-size: var(--danger-zone-description-size, 0.75rem);
		color: var(--color-text-muted);
		margin: 0;
	}

	.danger-zone-affected {
		color: var(--color-danger);
		font-weight: 500;
	}

	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.col-span-2 {
		grid-column: span 2;
	}

	.registration-settings {
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-card);
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
		color: var(--color-text-muted);
	}

	.registration-grid {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.registration-order-field {
		min-width: 120px;
	}

	.registration-placeholder-field {
		flex: 1;
		min-width: 200px;
	}

	.detail-dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.375rem 0.75rem;
		font-size: 0.8125rem;
	}

	.detail-dl dt {
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.detail-dl dd {
		color: var(--color-text);
		word-break: break-all;
		margin: 0;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.72rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.badge-neutral {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.badge-success {
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
	}

	.badge-warning {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
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

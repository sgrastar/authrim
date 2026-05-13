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
		getOperationStatusInfo,
		parseValidationRules,
		parseRequiredScopes,
		formatTimestamp
	} from '$lib/api/admin-custom-claims';
	import { Modal } from '$lib/components';

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
			console.error('Failed to load schema:', err);
			error = err instanceof Error ? err.message : 'Failed to load schema';
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
					saveError = 'Invalid JSON in validation rules';
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
				registration_required:
					editForm.show_on_registration && editForm.registration_required,
				registration_order: editForm.registration_order,
				registration_placeholder: editForm.registration_placeholder || null
			});

			schema = result.schema;
			saveSuccess = true;
			setTimeout(() => (saveSuccess = false), 3000);
		} catch (err) {
			console.error('Failed to save schema:', err);
			saveError = err instanceof Error ? err.message : 'Failed to save schema';
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
			console.error('Failed to delete schema:', err);
			deleteError = err instanceof Error ? err.message : 'Failed to delete schema';
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
			console.error('Failed to rename schema:', err);
			renameError = err instanceof Error ? err.message : 'Failed to rename schema';
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
			console.error('Failed to retry:', err);
			saveError = err instanceof Error ? err.message : 'Failed to retry operation';
		}
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
	const isEditable = $derived(schema?.operation_status === 'active');
	const registrationConfigDisabled = $derived(!isEditable || !editForm.show_on_registration);
	const statusInfo = $derived(schema ? getOperationStatusInfo(schema.operation_status) : null);
</script>

<svelte:head>
	<title
		>{schema?.display_label ?? 'Schema'} — Schema Settings — Admin Dashboard — Authrim</title
	>
</svelte:head>

<div class="admin-page">
	<!-- Breadcrumb -->
	<nav class="breadcrumb mb-4">
		<a href="/admin/custom-claims" class="breadcrumb-link">Schema Settings</a>
		<span class="breadcrumb-sep">/</span>
		<span class="breadcrumb-current"
			>{loading ? '...' : (schema?.display_label ?? schema?.field_key ?? schemaId)}</span
		>
	</nav>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadSchema}>Retry</button>
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
						<span class="badge badge-neutral">System</span>
					{/if}
					{#if statusInfo && schema.operation_status !== 'active'}
						<span class="badge badge-warning">{statusInfo.label}</span>
					{/if}
				</div>
				<p class="page-description">
					{schema.description || 'No description.'}
				</p>
			</div>
			<div class="page-actions">
				<a href="/admin/custom-claims" class="btn btn-secondary">
					<i class="i-ph-arrow-left"></i>
					Back to list
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
							<h3 class="font-semibold text-red-900">Operation Failed</h3>
							{#if schema.operation_detail}
								<p class="text-sm text-red-800 mt-1">{schema.operation_detail}</p>
							{/if}
						</div>
					</div>
					<button class="btn btn-secondary btn-sm" onclick={retryOperation}>
						<i class="i-ph-arrow-clockwise"></i>
						Retry
					</button>
				</div>
			</div>
		{/if}

		<!-- Save feedback -->
		{#if saveError}
			<div class="alert alert-error mb-4">{saveError}</div>
		{/if}
		{#if saveSuccess}
			<div class="alert alert-success mb-4">Changes saved successfully.</div>
		{/if}

		<div class="detail-layout">
			<!-- ===== Main settings ===== -->
			<div class="detail-main">
				<!-- Section: Identity & Classification -->
				<div class="panel mb-4">
					<h2 class="panel-title">Identity & Classification</h2>

					<div class="form-grid">
						<!-- field_key (read-only) -->
						<div class="form-group">
							<label class="form-label" for="field-key">Field Key</label>
							<input
								id="field-key"
								type="text"
								class="form-input"
								value={schema.field_key}
								disabled
							/>
							<p class="form-hint">To change the key, use the Rename action in Danger Zone.</p>
						</div>

						<!-- display_label -->
						<div class="form-group">
							<label class="form-label" for="display-label">Display Label</label>
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
							<label class="form-label" for="field-type">Field Type</label>
							<select
								id="field-type"
								class="form-select"
								bind:value={editForm.field_type}
								disabled={!isEditable || isSystem}
							>
								<option value="string">String</option>
								<option value="number">Number</option>
								<option value="boolean">Boolean</option>
								<option value="date">Date</option>
								<option value="enum">Enum</option>
							</select>
						</div>

						<!-- is_pii (read-only after creation) -->
						<div class="form-group">
							<p class="form-label">PII Classification</p>
							<div class="flex items-center gap-2 mt-1">
								{#if schema.is_pii}
									<span class="badge badge-warning">PII — stored in encrypted PII database</span>
								{:else}
									<span class="badge badge-success">Non-PII — stored in core database</span>
								{/if}
							</div>
							<p class="form-hint text-amber-600">Cannot be changed after creation.</p>
						</div>

						<!-- display_order -->
						<div class="form-group">
							<label class="form-label" for="display-order">Display Order</label>
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
							<label class="form-label" for="description">Description</label>
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
								Required field
							</label>
						</div>

						<div class="form-group">
							<label class="form-label">
								<input type="checkbox" bind:checked={editForm.is_active} disabled={!isEditable} />
								Active
							</label>
						</div>
					</div>
				</div>

				<!-- Section: Token & Endpoint Inclusion -->
				<div class="panel mb-4">
					<h2 class="panel-title">Token & Endpoint Inclusion</h2>
					<p class="text-sm text-gray-500 mb-4">
						Controls which tokens and endpoints include this claim by default.
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
										>Custom claim embedding in Introspection responses is currently disabled.</small
									>
								</label>
							</div>
						</div>

						<div class="form-group">
							<label class="form-label" for="required-scopes"
								>Required Scopes (comma-separated)</label
							>
							<input
								id="required-scopes"
								type="text"
								class="form-input"
								placeholder="e.g. profile, employee"
								bind:value={editForm.required_scopes_text}
								disabled={!isEditable}
							/>
							<p class="form-hint">Leave empty to always include when token flags are set.</p>
						</div>

						<div class="form-group">
							<label class="form-label" for="scope-mode">Scope Mode</label>
							<select
								id="scope-mode"
								class="form-select"
								bind:value={editForm.scope_mode}
								disabled={!isEditable}
							>
								<option value="any">Any (one scope suffices)</option>
								<option value="all">All (all scopes required)</option>
							</select>
						</div>

						<div class="form-group col-span-2">
							<label class="form-label" for="claim-namespace">Claim Namespace (optional)</label>
							<input
								id="claim-namespace"
								type="text"
								class="form-input"
								placeholder="e.g. https://example.com/claims/"
								bind:value={editForm.claim_namespace}
								disabled={!isEditable}
							/>
						</div>
					</div>
				</div>

				<!-- Section: Validation Rules -->
				<div class="panel mb-4">
					<h2 class="panel-title">Validation Rules</h2>
					<p class="text-sm text-gray-500 mb-3">
						JSON object. String: <code>min_length</code>, <code>max_length</code>,
						<code>pattern</code>. Number: <code>min</code>, <code>max</code>. Enum:
						<code>enum_values</code> (array). Date: <code>min_date</code>, <code>max_date</code> (ISO
						8601).
					</p>
					<textarea
						class="form-input font-mono text-sm w-full"
						rows="5"
						placeholder={'e.g. {"min_length": 1, "max_length": 100}'}
						bind:value={editForm.validation_rules_json}
						disabled={!isEditable}
					></textarea>
				</div>

				<!-- Section: Advanced -->
				<div class="panel mb-4">
					<h2 class="panel-title">Advanced</h2>
					<div class="flex gap-6 flex-wrap">
						<label class="form-label">
							<input type="checkbox" bind:checked={editForm.is_searchable} disabled={!isEditable} />
							Searchable
						</label>
						<label class="form-label">
							<input type="checkbox" bind:checked={editForm.is_exportable} disabled={!isEditable} />
							Exportable
						</label>
						<label class="form-label">
							<input type="checkbox" bind:checked={editForm.is_vc_claim} disabled={!isEditable} />
							Verifiable Credential claim
						</label>
					</div>
				</div>

				<!-- Section: Registration Form -->
				<div class="panel mb-4">
					<h2 class="panel-title">Registration Form</h2>
					<div class="flex gap-6 flex-wrap mb-4">
						<label class="form-label">
							<input
								type="checkbox"
								bind:checked={editForm.show_on_registration}
								disabled={!isEditable}
							/>
							Show on signup form
						</label>
						<label class="form-label">
							<input
								type="checkbox"
								bind:checked={editForm.registration_required}
								disabled={registrationConfigDisabled}
							/>
							Required on signup
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
									<label class="form-label" for="reg-order">Display order</label>
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
									<label class="form-label" for="reg-placeholder">Placeholder text</label>
									<input
										id="reg-placeholder"
										type="text"
										bind:value={editForm.registration_placeholder}
										disabled={!isEditable}
										placeholder="e.g. Enter your department"
										class="form-input"
									/>
								</div>
							</div>
						{:else}
							<p class="registration-disabled-hint">
								Enable "Show on signup form" to edit required, order, and placeholder settings.
							</p>
						{/if}
					</div>
				</div>

				<!-- Save button -->
				{#if isEditable}
					<div class="flex justify-end">
						<button class="btn btn-primary" onclick={submitSave} disabled={saving}>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}

				<!-- Danger Zone -->
				<div class="danger-panel mt-6">
					<h2 class="panel-title danger-title">Danger Zone</h2>

					<div class="flex flex-col gap-3">
						<!-- Rename -->
						<div class="danger-zone-row">
							<div>
								<p class="danger-zone-row-title">Rename Field Key</p>
								<p class="danger-zone-description">
									Changes the claim name in API responses and tokens. May break RP integrations.
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
								title={isSystem ? 'System claims cannot be renamed' : undefined}
							>
								<i class="i-ph-pencil-simple"></i>
								Rename
							</button>
						</div>

						<!-- Delete -->
						<div class="danger-zone-row">
							<div>
								<p class="danger-zone-row-title">Delete Schema</p>
								<p class="danger-zone-description">
									Permanently deletes this schema and all associated user data.
									{#if userCount > 0}
										<span class="danger-zone-affected">
											{userCountApproximate ? '~' : ''}{userCount} user(s) will lose this data.
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
								title={isSystem ? 'System claims cannot be deleted' : undefined}
							>
								<i class="i-ph-trash"></i>
								Delete
							</button>
						</div>
					</div>
				</div>
			</div>

			<!-- ===== Sidebar ===== -->
			<div class="detail-sidebar">
				<div class="panel">
					<h3 class="font-semibold text-sm mb-3">Details</h3>
					<dl class="detail-dl">
						<dt>Schema Version</dt>
						<dd>{schema.schema_version}</dd>

						<dt>Storage</dt>
						<dd>{schema.is_pii ? 'PII Database' : 'Core Database'}</dd>

						<dt>Users with data</dt>
						<dd>
							{#if userCountApproximate}~{/if}{userCount}
							{userCountApproximate ? '(approx.)' : ''}
						</dd>

						<dt>Created</dt>
						<dd>{formatTimestamp(schema.created_at)}</dd>

						<dt>Updated</dt>
						<dd>{formatTimestamp(schema.updated_at)}</dd>

						{#if schema.created_by}
							<dt>Created by</dt>
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
	title="Rename Field Key"
	size="md"
>
	{#if renameError}
		<div class="alert alert-error alert-sm mb-4">{renameError}</div>
	{/if}

	<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
		<h4 class="font-semibold text-blue-900 text-sm mb-1">Recommended approach</h4>
		<ol class="text-sm text-blue-800 list-decimal list-inside space-y-1">
			<li>Deactivate this schema (set inactive)</li>
			<li>Create a new schema with the desired field_key</li>
			<li>Migrate user data in the background</li>
			<li>Delete the old schema</li>
		</ol>
	</div>

	<div class="alert alert-warning mb-4">
		<strong>Warning:</strong> Renaming changes the claim name in API responses and tokens. This may break
		integrations with Relying Parties (RP) expecting the old claim name.
	</div>

	<div class="bg-gray-50 rounded-lg p-3 mb-4">
		<p class="text-sm">
			<strong>Current key:</strong>
			<code>{schema?.field_key}</code>
		</p>
		{#if userCount > 0}
			<p class="text-amber-600 font-semibold text-sm mt-1">
				Affected users: {userCountApproximate ? '~' : ''}{userCount}
				{userCountApproximate ? '(approx.)' : ''}
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

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showRenameDialog = false)}>Cancel</button>
		<button class="btn btn-warning" onclick={confirmRename} disabled={renaming || !renameNewKey}>
			{renaming ? 'Renaming...' : 'Rename Field Key'}
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
	title="Delete Custom Claim Schema"
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error alert-sm mb-4">{deleteError}</div>
	{/if}

	{#if schema}
		<div class="alert alert-warning mb-4">
			<strong>Warning:</strong> This will permanently delete the schema and all associated user data.
			This action cannot be undone.
		</div>

		<div class="bg-gray-50 rounded-lg p-3 mb-4">
			<p class="text-sm"><strong>Field Key:</strong> <code>{schema.field_key}</code></p>
			<p class="text-sm"><strong>Label:</strong> {schema.display_label}</p>
			<p class="text-sm">
				<strong>Storage:</strong>
				{schema.is_pii ? 'PII Database' : 'Core Database'}
			</p>
			{#if userCount > 0}
				<p class="text-red-600 font-semibold text-sm mt-2">
					Affected users: {userCountApproximate ? '~' : ''}{userCount}
					{userCountApproximate ? '(approx.)' : ''}
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

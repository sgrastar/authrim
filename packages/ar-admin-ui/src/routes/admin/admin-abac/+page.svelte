<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminAbacAPI, type AdminAttribute } from '$lib/api/admin-admin-abac';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminToolbar
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	import { Modal } from '$lib/components';

	// State
	let attributes: AdminAttribute[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Filters
	let includeSystem = $state(true);
	let searchQuery = $state('');

	// Filtered attributes
	const filteredAttributes = $derived(() => {
		if (!searchQuery) return attributes;
		const query = searchQuery.toLowerCase();
		return attributes.filter(
			(a) =>
				a.name.toLowerCase().includes(query) ||
				a.display_name?.toLowerCase().includes(query) ||
				a.description?.toLowerCase().includes(query)
		);
	});

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let createForm = $state({
		name: '',
		display_name: '',
		description: '',
		attribute_type: 'string' as 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array',
		allowed_values: '',
		min_value: '',
		max_value: '',
		regex_pattern: '',
		is_required: false,
		is_multi_valued: false
	});

	// Edit dialog state
	let showEditDialog = $state(false);
	let editingAttribute: AdminAttribute | null = $state(null);
	let saving = $state(false);
	let saveError = $state('');
	let editForm = $state({
		display_name: '',
		description: '',
		allowed_values: '',
		min_value: '',
		max_value: '',
		regex_pattern: '',
		is_required: false,
		is_multi_valued: false
	});

	async function loadAttributes() {
		loading = true;
		error = '';

		try {
			const response = await adminAdminAbacAPI.listAttributes({
				include_system: includeSystem
			});
			attributes = response.items;
		} catch {
			error = $LL.admin_admin_abac_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadAttributes();
	});

	function toggleIncludeSystem() {
		includeSystem = !includeSystem;
		loadAttributes();
	}

	function openCreateDialog() {
		createForm = {
			name: '',
			display_name: '',
			description: '',
			attribute_type: 'string',
			allowed_values: '',
			min_value: '',
			max_value: '',
			regex_pattern: '',
			is_required: false,
			is_multi_valued: false
		};
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function handleCreate() {
		if (!createForm.name.trim()) {
			createError = $LL.admin_admin_abac_attribute_name_required();
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminAdminAbacAPI.createAttribute({
				name: createForm.name.trim(),
				display_name: createForm.display_name.trim() || undefined,
				description: createForm.description.trim() || undefined,
				attribute_type: createForm.attribute_type,
				allowed_values:
					createForm.attribute_type === 'enum' && createForm.allowed_values
						? createForm.allowed_values.split(',').map((v) => v.trim())
						: undefined,
				min_value: createForm.min_value ? parseInt(createForm.min_value) : undefined,
				max_value: createForm.max_value ? parseInt(createForm.max_value) : undefined,
				regex_pattern: createForm.regex_pattern.trim() || undefined,
				is_required: createForm.is_required,
				is_multi_valued: createForm.is_multi_valued
			});
			closeCreateDialog();
			loadAttributes();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_admin_abac_create_failed();
		} finally {
			creating = false;
		}
	}

	function openEditDialog(attr: AdminAttribute) {
		editingAttribute = attr;
		editForm = {
			display_name: attr.display_name || '',
			description: attr.description || '',
			allowed_values: attr.allowed_values?.join(', ') || '',
			min_value: attr.min_value?.toString() || '',
			max_value: attr.max_value?.toString() || '',
			regex_pattern: attr.regex_pattern || '',
			is_required: attr.is_required,
			is_multi_valued: attr.is_multi_valued
		};
		saveError = '';
		showEditDialog = true;
	}

	function closeEditDialog() {
		showEditDialog = false;
		editingAttribute = null;
	}

	async function handleSave() {
		if (!editingAttribute) return;

		saving = true;
		saveError = '';

		try {
			await adminAdminAbacAPI.updateAttribute(editingAttribute.id, {
				display_name: editForm.display_name.trim() || undefined,
				description: editForm.description.trim() || undefined,
				allowed_values:
					editingAttribute.attribute_type === 'enum' && editForm.allowed_values
						? editForm.allowed_values.split(',').map((v) => v.trim())
						: undefined,
				min_value: editForm.min_value ? parseInt(editForm.min_value) : undefined,
				max_value: editForm.max_value ? parseInt(editForm.max_value) : undefined,
				regex_pattern: editForm.regex_pattern.trim() || undefined,
				is_required: editForm.is_required,
				is_multi_valued: editForm.is_multi_valued
			});
			closeEditDialog();
			loadAttributes();
		} catch (err) {
			saveError = err instanceof Error ? err.message : $LL.admin_admin_abac_save_failed();
		} finally {
			saving = false;
		}
	}

	async function handleDelete(attr: AdminAttribute) {
		if (attr.is_system) {
			alert($LL.admin_admin_abac_system_delete_blocked());
			return;
		}

		if (!confirm($LL.admin_admin_abac_delete_confirm({ attribute: attr.name }))) return;

		try {
			await adminAdminAbacAPI.deleteAttribute(attr.id);
			loadAttributes();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admin_abac_delete_failed());
		}
	}

	function formatAttributeType(type: AdminAttribute['attribute_type']): string {
		switch (type) {
			case 'string':
				return $LL.admin_admin_abac_type_string();
			case 'enum':
				return $LL.admin_admin_abac_type_enum();
			case 'number':
				return $LL.admin_admin_abac_type_number();
			case 'boolean':
				return $LL.admin_admin_abac_type_boolean();
			case 'date':
				return $LL.admin_admin_abac_type_date();
			case 'array':
				return $LL.admin_admin_abac_type_array();
			default:
				return type;
		}
	}

	function getAttributeTypeBadgeClass(type: string): string {
		switch (type) {
			case 'string':
				return 'badge badge-gray';
			case 'enum':
				return 'badge badge-blue';
			case 'number':
				return 'badge badge-green';
			case 'boolean':
				return 'badge badge-purple';
			case 'date':
				return 'badge badge-orange';
			case 'array':
				return 'badge badge-pink';
			default:
				return 'badge';
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_admin_abac_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_abac_title()}
		description={$LL.admin_admin_abac_description()}
	>
		{#snippet actions()}
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				{$LL.admin_admin_abac_create_attribute()}
			</button>
		{/snippet}
	</AdminPageHeader>

	<!-- Filters -->
	<AdminToolbar>
		<div class="admin-field admin-field--search">
			<label class="admin-field__label" for="admin-abac-search"
				>{$LL.admin_admin_abac_search_placeholder()}</label
			>
			<div class="search-box">
				<i class="i-ph-magnifying-glass"></i>
				<input
					id="admin-abac-search"
					type="text"
					class="admin-input search-input"
					placeholder={$LL.admin_admin_abac_search_placeholder()}
					bind:value={searchQuery}
				/>
			</div>
		</div>
		<label class="checkbox-label">
			<input type="checkbox" checked={includeSystem} onchange={toggleIncludeSystem} />
			<span>{$LL.admin_admin_abac_include_system()}</span>
		</label>
	</AdminToolbar>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>{$LL.admin_admin_abac_loading()}</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadAttributes}>
				{$LL.admin_admin_abac_retry()}
			</button>
		</div>
	{:else if filteredAttributes().length === 0}
		<AdminSection>
			<div class="empty-state">
				<i class="i-ph-file-dashed empty-icon"></i>
				<p>{$LL.admin_admin_abac_empty()}</p>
				{#if searchQuery}
					<button class="btn btn-secondary" onclick={() => (searchQuery = '')}>
						{$LL.admin_admin_abac_clear_search()}
					</button>
				{/if}
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<div class="attributes-grid">
				{#each filteredAttributes() as attr (attr.id)}
					<div class="attribute-card">
						<div class="attribute-header">
							<div class="attribute-title">
								<h3>{attr.display_name || attr.name}</h3>
								<span class="attribute-name">{attr.name}</span>
							</div>
							<div class="attribute-badges">
								<span class={getAttributeTypeBadgeClass(attr.attribute_type)}>
									{formatAttributeType(attr.attribute_type)}
								</span>
								{#if attr.is_system}
									<span class="badge badge-yellow">{$LL.admin_admin_abac_system()}</span>
								{/if}
							</div>
						</div>
						{#if attr.description}
							<p class="attribute-description">{attr.description}</p>
						{/if}
						<div class="attribute-details">
							{#if attr.attribute_type === 'enum' && attr.allowed_values}
								<div class="detail-item">
									<span class="detail-label">{$LL.admin_admin_abac_allowed_values()}</span>
									<span class="detail-value">{attr.allowed_values.join(', ')}</span>
								</div>
							{/if}
							{#if attr.attribute_type === 'number' && (attr.min_value !== null || attr.max_value !== null)}
								<div class="detail-item">
									<span class="detail-label">{$LL.admin_admin_abac_range()}</span>
									<span class="detail-value">{attr.min_value ?? '∞'} - {attr.max_value ?? '∞'}</span
									>
								</div>
							{/if}
							{#if attr.is_required}
								<div class="detail-item">
									<span class="badge badge-red">{$LL.admin_admin_abac_required()}</span>
								</div>
							{/if}
							{#if attr.is_multi_valued}
								<div class="detail-item">
									<span class="badge badge-blue">{$LL.admin_admin_abac_multi_valued()}</span>
								</div>
							{/if}
						</div>
						<div class="attribute-actions">
							{#if !attr.is_system}
								<button class="btn btn-sm btn-secondary" onclick={() => openEditDialog(attr)}>
									{$LL.admin_admin_abac_edit()}
								</button>
								<button class="btn btn-sm btn-danger" onclick={() => handleDelete(attr)}>
									{$LL.admin_admin_abac_delete()}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_admin_abac_create_title()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}
	<div class="form-group">
		<label for="name">
			{$LL.admin_admin_abac_attribute_name()} <span class="required">*</span>
		</label>
		<input
			type="text"
			id="name"
			class="input"
			bind:value={createForm.name}
			placeholder={$LL.admin_admin_abac_name_placeholder()}
		/>
	</div>
	<div class="form-group">
		<label for="displayName">{$LL.admin_admin_abac_display_name()}</label>
		<input
			type="text"
			id="displayName"
			class="input"
			bind:value={createForm.display_name}
			placeholder={$LL.admin_admin_abac_display_name_placeholder()}
		/>
	</div>
	<div class="form-group">
		<label for="description">{$LL.admin_admin_abac_description_label()}</label>
		<textarea
			id="description"
			class="input"
			bind:value={createForm.description}
			placeholder={$LL.admin_admin_abac_description_placeholder()}
			rows="2"
		></textarea>
	</div>
	<div class="form-group">
		<label for="type">{$LL.admin_admin_abac_attribute_type()}</label>
		<select id="type" class="input" bind:value={createForm.attribute_type}>
			<option value="string">{$LL.admin_admin_abac_type_string()}</option>
			<option value="enum">{$LL.admin_admin_abac_type_enum()}</option>
			<option value="number">{$LL.admin_admin_abac_type_number()}</option>
			<option value="boolean">{$LL.admin_admin_abac_type_boolean()}</option>
			<option value="date">{$LL.admin_admin_abac_type_date()}</option>
			<option value="array">{$LL.admin_admin_abac_type_array()}</option>
		</select>
	</div>
	{#if createForm.attribute_type === 'enum'}
		<div class="form-group">
			<label for="allowedValues">{$LL.admin_admin_abac_allowed_values_label()}</label>
			<input
				type="text"
				id="allowedValues"
				class="input"
				bind:value={createForm.allowed_values}
				placeholder={$LL.admin_admin_abac_allowed_values_placeholder()}
			/>
		</div>
	{/if}
	{#if createForm.attribute_type === 'number'}
		<div class="form-row">
			<div class="form-group">
				<label for="minValue">{$LL.admin_admin_abac_min_value()}</label>
				<input type="number" id="minValue" class="input" bind:value={createForm.min_value} />
			</div>
			<div class="form-group">
				<label for="maxValue">{$LL.admin_admin_abac_max_value()}</label>
				<input type="number" id="maxValue" class="input" bind:value={createForm.max_value} />
			</div>
		</div>
	{/if}
	{#if createForm.attribute_type === 'string'}
		<div class="form-group">
			<label for="regexPattern">{$LL.admin_admin_abac_regex_pattern()}</label>
			<input
				type="text"
				id="regexPattern"
				class="input"
				bind:value={createForm.regex_pattern}
				placeholder={$LL.admin_admin_abac_regex_placeholder()}
			/>
		</div>
	{/if}
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={createForm.is_required} />
			<span>{$LL.admin_admin_abac_required_for_all()}</span>
		</label>
	</div>
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={createForm.is_multi_valued} />
			<span>{$LL.admin_admin_abac_allow_multiple()}</span>
		</label>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_admin_abac_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
			{creating ? $LL.admin_admin_abac_creating() : $LL.admin_admin_abac_create()}
		</button>
	{/snippet}
</Modal>

<!-- Edit Dialog -->
<Modal
	open={showEditDialog && !!editingAttribute}
	onClose={closeEditDialog}
	title={$LL.admin_admin_abac_edit_title({ attribute: editingAttribute?.name || '' })}
	size="lg"
>
	{#if saveError}
		<div class="alert alert-error">{saveError}</div>
	{/if}
	<div class="form-group">
		<label for="editDisplayName">{$LL.admin_admin_abac_display_name()}</label>
		<input
			type="text"
			id="editDisplayName"
			class="input"
			bind:value={editForm.display_name}
			placeholder={$LL.admin_admin_abac_display_name_placeholder()}
		/>
	</div>
	<div class="form-group">
		<label for="editDescription">{$LL.admin_admin_abac_description_label()}</label>
		<textarea
			id="editDescription"
			class="input"
			bind:value={editForm.description}
			placeholder={$LL.admin_admin_abac_description_placeholder()}
			rows="2"
		></textarea>
	</div>
	{#if editingAttribute && editingAttribute.attribute_type === 'enum'}
		<div class="form-group">
			<label for="editAllowedValues">{$LL.admin_admin_abac_allowed_values_label()}</label>
			<input
				type="text"
				id="editAllowedValues"
				class="input"
				bind:value={editForm.allowed_values}
				placeholder={$LL.admin_admin_abac_allowed_values_placeholder()}
			/>
		</div>
	{/if}
	{#if editingAttribute && editingAttribute.attribute_type === 'number'}
		<div class="form-row">
			<div class="form-group">
				<label for="editMinValue">{$LL.admin_admin_abac_min_value()}</label>
				<input type="number" id="editMinValue" class="input" bind:value={editForm.min_value} />
			</div>
			<div class="form-group">
				<label for="editMaxValue">{$LL.admin_admin_abac_max_value()}</label>
				<input type="number" id="editMaxValue" class="input" bind:value={editForm.max_value} />
			</div>
		</div>
	{/if}
	{#if editingAttribute && editingAttribute.attribute_type === 'string'}
		<div class="form-group">
			<label for="editRegexPattern">{$LL.admin_admin_abac_regex_pattern()}</label>
			<input
				type="text"
				id="editRegexPattern"
				class="input"
				bind:value={editForm.regex_pattern}
				placeholder={$LL.admin_admin_abac_regex_placeholder()}
			/>
		</div>
	{/if}
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={editForm.is_required} />
			<span>{$LL.admin_admin_abac_required_for_all()}</span>
		</label>
	</div>
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={editForm.is_multi_valued} />
			<span>{$LL.admin_admin_abac_allow_multiple()}</span>
		</label>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeEditDialog} disabled={saving}>
			{$LL.admin_admin_abac_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
			{saving ? $LL.admin_admin_abac_saving() : $LL.admin_admin_abac_save()}
		</button>
	{/snippet}
</Modal>

<style>
	.search-box {
		position: relative;
	}

	.search-box :global(i) {
		position: absolute;
		left: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		width: 18px;
		height: 18px;
		color: var(--color-text-subtle);
	}

	.search-input {
		padding-left: 2.5rem;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--color-text);
	}

	/* Attributes Grid */
	.attributes-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
		gap: 1rem;
	}

	.attribute-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 1.25rem;
		transition: all var(--transition-fast);
		box-shadow: var(--card-shadow, var(--shadow-sm));
	}

	.attribute-card:hover {
		border-color: var(--color-accent);
		box-shadow: var(--shadow-md);
	}

	.attribute-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 0.75rem;
	}

	.attribute-title h3 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.attribute-name {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.attribute-badges {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
	}

	.attribute-description {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin-bottom: 0.75rem;
	}

	.attribute-details {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}

	.detail-item {
		display: flex;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.detail-label {
		color: var(--color-text-muted);
	}

	.detail-value {
		color: var(--color-text);
		font-weight: 500;
	}

	.attribute-actions {
		display: flex;
		gap: 0.5rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}

	/* Badge Styles */
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.5rem;
		font-size: 0.75rem;
		font-weight: 500;
		border-radius: var(--radius-control);
	}

	.badge-gray {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.badge-blue {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.badge-green {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.badge-purple {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.badge-orange {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.badge-pink {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.badge-yellow {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.badge-red {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	/* Empty State */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--color-text-muted);
	}

	.empty-icon {
		width: 64px;
		height: 64px;
		margin-bottom: 1rem;
		color: var(--color-text-subtle);
	}

	/* Error State */
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--color-text-muted);
		gap: 1rem;
	}

	.error-text {
		color: var(--color-danger);
	}

	/* Form Styles */
	.form-group {
		margin-bottom: 1rem;
	}

	.form-group:last-child {
		margin-bottom: 0;
	}

	.form-group label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		margin-bottom: 0.5rem;
	}

	.required {
		color: var(--color-danger);
	}

	.input,
	textarea.input,
	select.input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font-size: 0.875rem;
		font-family: inherit;
	}

	.input:focus,
	textarea.input:focus,
	select.input:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
		color: var(--color-danger);
		padding: 0.75rem 1rem;
		border-radius: var(--radius-control);
		margin-bottom: 1rem;
	}
</style>

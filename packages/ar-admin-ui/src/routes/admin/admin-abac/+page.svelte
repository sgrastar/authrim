<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminAbacAPI, type AdminAttribute } from '$lib/api/admin-admin-abac';
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
		} catch (err) {
			console.error('Failed to load attributes:', err);
			error = err instanceof Error ? err.message : 'Failed to load attributes';
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
			createError = 'Attribute name is required';
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
			createError = err instanceof Error ? err.message : 'Failed to create attribute';
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
			saveError = err instanceof Error ? err.message : 'Failed to save attribute';
		} finally {
			saving = false;
		}
	}

	async function handleDelete(attr: AdminAttribute) {
		if (attr.is_system) {
			alert('System attributes cannot be deleted');
			return;
		}

		if (!confirm(`Are you sure you want to delete the attribute "${attr.name}"?`)) return;

		try {
			await adminAdminAbacAPI.deleteAttribute(attr.id);
			loadAttributes();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to delete attribute');
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
	<title>Admin ABAC - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Admin Attribute-Based Access Control</h1>
			<p class="page-description">
				Manage attribute definitions for admin operators. Attributes can be assigned to admin users
				for fine-grained access control.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				Create Attribute
			</button>
		</div>
	</div>

	<!-- Filters -->
	<div class="filters-bar">
		<div class="search-box">
			<i class="i-ph-magnifying-glass"></i>
			<input
				type="text"
				class="search-input"
				placeholder="Search attributes..."
				bind:value={searchQuery}
			/>
		</div>
		<label class="checkbox-label">
			<input type="checkbox" checked={includeSystem} onchange={toggleIncludeSystem} />
			<span>Include system attributes</span>
		</label>
	</div>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>Loading attributes...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadAttributes}>Retry</button>
		</div>
	{:else if filteredAttributes().length === 0}
		<div class="empty-state">
			<i class="i-ph-file-dashed empty-icon"></i>
			<p>No attributes found</p>
			{#if searchQuery}
				<button class="btn btn-secondary" onclick={() => (searchQuery = '')}>Clear Search</button>
			{/if}
		</div>
	{:else}
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
								{attr.attribute_type}
							</span>
							{#if attr.is_system}
								<span class="badge badge-yellow">System</span>
							{/if}
						</div>
					</div>
					{#if attr.description}
						<p class="attribute-description">{attr.description}</p>
					{/if}
					<div class="attribute-details">
						{#if attr.attribute_type === 'enum' && attr.allowed_values}
							<div class="detail-item">
								<span class="detail-label">Allowed values:</span>
								<span class="detail-value">{attr.allowed_values.join(', ')}</span>
							</div>
						{/if}
						{#if attr.attribute_type === 'number' && (attr.min_value !== null || attr.max_value !== null)}
							<div class="detail-item">
								<span class="detail-label">Range:</span>
								<span class="detail-value">{attr.min_value ?? '∞'} - {attr.max_value ?? '∞'}</span>
							</div>
						{/if}
						{#if attr.is_required}
							<div class="detail-item">
								<span class="badge badge-red">Required</span>
							</div>
						{/if}
						{#if attr.is_multi_valued}
							<div class="detail-item">
								<span class="badge badge-blue">Multi-valued</span>
							</div>
						{/if}
					</div>
					<div class="attribute-actions">
						{#if !attr.is_system}
							<button class="btn btn-sm btn-secondary" onclick={() => openEditDialog(attr)}>
								Edit
							</button>
							<button class="btn btn-sm btn-danger" onclick={() => handleDelete(attr)}>
								Delete
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title="Create Attribute Definition"
	size="lg"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}
	<div class="form-group">
		<label for="name">
			Attribute Name <span class="required">*</span>
		</label>
		<input
			type="text"
			id="name"
			class="input"
			bind:value={createForm.name}
			placeholder="e.g., admin_department"
		/>
	</div>
	<div class="form-group">
		<label for="displayName">Display Name</label>
		<input
			type="text"
			id="displayName"
			class="input"
			bind:value={createForm.display_name}
			placeholder="e.g., Department"
		/>
	</div>
	<div class="form-group">
		<label for="description">Description</label>
		<textarea
			id="description"
			class="input"
			bind:value={createForm.description}
			placeholder="Description of this attribute..."
			rows="2"
		></textarea>
	</div>
	<div class="form-group">
		<label for="type">Attribute Type</label>
		<select id="type" class="input" bind:value={createForm.attribute_type}>
			<option value="string">String</option>
			<option value="enum">Enum (Select from values)</option>
			<option value="number">Number</option>
			<option value="boolean">Boolean</option>
			<option value="date">Date</option>
			<option value="array">Array</option>
		</select>
	</div>
	{#if createForm.attribute_type === 'enum'}
		<div class="form-group">
			<label for="allowedValues">Allowed Values (comma-separated)</label>
			<input
				type="text"
				id="allowedValues"
				class="input"
				bind:value={createForm.allowed_values}
				placeholder="e.g., engineering, security, operations"
			/>
		</div>
	{/if}
	{#if createForm.attribute_type === 'number'}
		<div class="form-row">
			<div class="form-group">
				<label for="minValue">Min Value</label>
				<input type="number" id="minValue" class="input" bind:value={createForm.min_value} />
			</div>
			<div class="form-group">
				<label for="maxValue">Max Value</label>
				<input type="number" id="maxValue" class="input" bind:value={createForm.max_value} />
			</div>
		</div>
	{/if}
	{#if createForm.attribute_type === 'string'}
		<div class="form-group">
			<label for="regexPattern">Regex Pattern (optional)</label>
			<input
				type="text"
				id="regexPattern"
				class="input"
				bind:value={createForm.regex_pattern}
				placeholder="e.g., ^[A-Z]{2}-[0-9]{3}$"
			/>
		</div>
	{/if}
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={createForm.is_required} />
			<span>Required for all admin users</span>
		</label>
	</div>
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={createForm.is_multi_valued} />
			<span>Allow multiple values</span>
		</label>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			Cancel
		</button>
		<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
			{creating ? 'Creating...' : 'Create'}
		</button>
	{/snippet}
</Modal>

<!-- Edit Dialog -->
<Modal
	open={showEditDialog && !!editingAttribute}
	onClose={closeEditDialog}
	title="Edit Attribute: {editingAttribute?.name || ''}"
	size="lg"
>
	{#if saveError}
		<div class="alert alert-error">{saveError}</div>
	{/if}
	<div class="form-group">
		<label for="editDisplayName">Display Name</label>
		<input
			type="text"
			id="editDisplayName"
			class="input"
			bind:value={editForm.display_name}
			placeholder="e.g., Department"
		/>
	</div>
	<div class="form-group">
		<label for="editDescription">Description</label>
		<textarea
			id="editDescription"
			class="input"
			bind:value={editForm.description}
			placeholder="Description of this attribute..."
			rows="2"
		></textarea>
	</div>
	{#if editingAttribute && editingAttribute.attribute_type === 'enum'}
		<div class="form-group">
			<label for="editAllowedValues">Allowed Values (comma-separated)</label>
			<input
				type="text"
				id="editAllowedValues"
				class="input"
				bind:value={editForm.allowed_values}
				placeholder="e.g., engineering, security, operations"
			/>
		</div>
	{/if}
	{#if editingAttribute && editingAttribute.attribute_type === 'number'}
		<div class="form-row">
			<div class="form-group">
				<label for="editMinValue">Min Value</label>
				<input type="number" id="editMinValue" class="input" bind:value={editForm.min_value} />
			</div>
			<div class="form-group">
				<label for="editMaxValue">Max Value</label>
				<input type="number" id="editMaxValue" class="input" bind:value={editForm.max_value} />
			</div>
		</div>
	{/if}
	{#if editingAttribute && editingAttribute.attribute_type === 'string'}
		<div class="form-group">
			<label for="editRegexPattern">Regex Pattern (optional)</label>
			<input
				type="text"
				id="editRegexPattern"
				class="input"
				bind:value={editForm.regex_pattern}
				placeholder="e.g., ^[A-Z]{2}-[0-9]{3}$"
			/>
		</div>
	{/if}
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={editForm.is_required} />
			<span>Required for all admin users</span>
		</label>
	</div>
	<div class="form-group">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={editForm.is_multi_valued} />
			<span>Allow multiple values</span>
		</label>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeEditDialog} disabled={saving}>Cancel</button>
		<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
			{saving ? 'Saving...' : 'Save'}
		</button>
	{/snippet}
</Modal>

<style>
	/* Filters Bar */
	.filters-bar {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-bottom: 1.5rem;
	}

	.search-box {
		flex: 1;
		position: relative;
		max-width: 400px;
	}

	.search-box :global(i) {
		position: absolute;
		left: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		width: 18px;
		height: 18px;
		color: var(--text-tertiary);
	}

	.search-input {
		width: 100%;
		padding: 0.5rem 0.75rem 0.5rem 2.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	/* Attributes Grid */
	.attributes-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
		gap: 1rem;
	}

	.attribute-card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.25rem;
		transition: all var(--transition-fast);
	}

	.attribute-card:hover {
		border-color: var(--border-hover);
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
		color: var(--text-primary);
	}

	.attribute-name {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.attribute-badges {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
	}

	.attribute-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin-bottom: 0.75rem;
	}

	.attribute-details {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	.detail-item {
		display: flex;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.detail-label {
		color: var(--text-secondary);
	}

	.detail-value {
		color: var(--text-primary);
		font-weight: 500;
	}

	.attribute-actions {
		display: flex;
		gap: 0.5rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	/* Badge Styles */
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.5rem;
		font-size: 0.75rem;
		font-weight: 500;
		border-radius: var(--radius-sm);
	}

	.badge-gray {
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}

	.badge-blue {
		background: rgba(59, 130, 246, 0.15);
		color: #3b82f6;
	}

	.badge-green {
		background: rgba(34, 197, 94, 0.15);
		color: #22c55e;
	}

	.badge-purple {
		background: rgba(139, 92, 246, 0.15);
		color: #8b5cf6;
	}

	.badge-orange {
		background: rgba(249, 115, 22, 0.15);
		color: #f97316;
	}

	.badge-pink {
		background: rgba(236, 72, 153, 0.15);
		color: #ec4899;
	}

	.badge-yellow {
		background: rgba(234, 179, 8, 0.15);
		color: #eab308;
	}

	.badge-red {
		background: rgba(239, 68, 68, 0.15);
		color: #ef4444;
	}

	/* Empty State */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--text-secondary);
	}

	.empty-icon {
		width: 64px;
		height: 64px;
		margin-bottom: 1rem;
		color: var(--text-tertiary);
	}

	/* Error State */
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--text-secondary);
		gap: 1rem;
	}

	.error-text {
		color: var(--danger);
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
		color: var(--text-primary);
		margin-bottom: 0.5rem;
	}

	.required {
		color: var(--danger);
	}

	.input,
	textarea.input,
	select.input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: inherit;
	}

	.input:focus,
	textarea.input:focus,
	select.input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-subtle);
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.alert-error {
		background: var(--danger-subtle);
		color: var(--danger);
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		margin-bottom: 1rem;
	}
</style>

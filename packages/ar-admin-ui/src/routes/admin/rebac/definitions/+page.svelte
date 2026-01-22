<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		adminReBACAPI,
		type RelationDefinition,
		formatRelationExpression,
		getExpressionTypeLabel
	} from '$lib/api/admin-rebac';

	// State
	let definitions: RelationDefinition[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let pagination = $state({
		page: 1,
		limit: 20,
		total: 0,
		total_pages: 0
	});

	// Filters
	let filterObjectType = $state('');
	let filterSearch = $state('');
	let filterActive: 'all' | 'active' | 'inactive' = $state('all');

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let createForm = $state({
		object_type: '',
		relation_name: '',
		definition_type: 'direct' as 'direct' | 'union',
		direct_relation: '',
		description: '',
		priority: 0
	});

	// Delete dialog state
	let showDeleteDialog = $state(false);
	let definitionToDelete: RelationDefinition | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	$effect(() => {
		const urlObjectType = $page.url.searchParams.get('object_type');
		if (urlObjectType) {
			filterObjectType = urlObjectType;
		}
	});

	async function loadDefinitions() {
		loading = true;
		error = '';

		try {
			const response = await adminReBACAPI.listDefinitions({
				page: pagination.page,
				limit: pagination.limit,
				object_type: filterObjectType || undefined,
				search: filterSearch || undefined,
				is_active: filterActive === 'all' ? undefined : filterActive === 'active'
			});

			definitions = response.definitions;
			pagination = response.pagination;
		} catch (err) {
			console.error('Failed to load relation definitions:', err);
			error = err instanceof Error ? err.message : 'Failed to load relation definitions';
		} finally {
			loading = false;
		}
	}

	function applyFilters() {
		pagination.page = 1;
		loadDefinitions();
	}

	function clearFilters() {
		filterObjectType = '';
		filterSearch = '';
		filterActive = 'all';
		pagination.page = 1;
		loadDefinitions();
	}

	function goToPage(newPage: number) {
		if (newPage < 1 || newPage > pagination.total_pages) return;
		pagination.page = newPage;
		loadDefinitions();
	}

	function openCreateDialog() {
		createForm = {
			object_type: filterObjectType || '',
			relation_name: '',
			definition_type: 'direct',
			direct_relation: '',
			description: '',
			priority: 0
		};
		createError = '';
		showCreateDialog = true;
	}

	async function submitCreate() {
		if (!createForm.object_type || !createForm.relation_name) {
			createError = 'Object type and relation name are required';
			return;
		}

		creating = true;
		createError = '';

		try {
			let definition;
			if (createForm.definition_type === 'direct') {
				definition = {
					type: 'direct' as const,
					relation: createForm.direct_relation || createForm.relation_name
				};
			} else {
				// Simple union with direct relation
				definition = {
					type: 'union' as const,
					children: [
						{
							type: 'direct' as const,
							relation: createForm.relation_name
						}
					]
				};
			}

			await adminReBACAPI.createDefinition({
				object_type: createForm.object_type,
				relation_name: createForm.relation_name,
				definition,
				description: createForm.description || undefined,
				priority: createForm.priority
			});

			showCreateDialog = false;
			loadDefinitions();
		} catch (err) {
			console.error('Failed to create relation definition:', err);
			createError = err instanceof Error ? err.message : 'Failed to create relation definition';
		} finally {
			creating = false;
		}
	}

	function openDeleteDialog(def: RelationDefinition, event: Event) {
		event.stopPropagation();
		if (def.tenant_id === 'default') {
			return;
		}
		definitionToDelete = def;
		deleteError = '';
		showDeleteDialog = true;
	}

	async function confirmDelete() {
		if (!definitionToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminReBACAPI.deleteDefinition(definitionToDelete.id);
			showDeleteDialog = false;
			definitionToDelete = null;
			loadDefinitions();
		} catch (err) {
			console.error('Failed to delete relation definition:', err);
			deleteError = err instanceof Error ? err.message : 'Failed to delete relation definition';
		} finally {
			deleting = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	onMount(() => {
		loadDefinitions();
	});
</script>

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<nav class="breadcrumb">
				<a href="/admin/rebac">ReBAC</a>
				<span>/</span>
				<span>Relation Definitions</span>
			</nav>
			<h1 class="page-title">Relation Definitions</h1>
			<p class="modal-description">
				Configure how relations are computed using Zanzibar-style expressions.
			</p>
		</div>
		<button class="btn btn-primary" onclick={openCreateDialog}>+ Create Definition</button>
	</div>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadDefinitions}>Retry</button>
		</div>
	{/if}

	<!-- Filters -->
	<div class="filter-bar">
		<input
			type="text"
			placeholder="Search..."
			bind:value={filterSearch}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder="Object type"
			bind:value={filterObjectType}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<select bind:value={filterActive} onchange={applyFilters}>
			<option value="all">All Status</option>
			<option value="active">Active</option>
			<option value="inactive">Inactive</option>
		</select>
		<button class="btn-filter" onclick={applyFilters}>Apply</button>
		<button class="btn-clear" onclick={clearFilters}>Clear</button>
	</div>

	<!-- Definitions Table -->
	{#if loading}
		<div class="loading-state">Loading...</div>
	{:else if definitions.length === 0}
		<div class="empty-state">
			<p>No relation definitions found.</p>
			<button class="btn btn-primary" onclick={openCreateDialog}>Create Definition</button>
		</div>
	{:else}
		<div class="table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Object Type</th>
						<th>Relation</th>
						<th>Expression</th>
						<th>Priority</th>
						<th>Status</th>
						<th>Source</th>
						<th>Updated</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each definitions as def (def.id)}
						<tr>
							<td>
								<span class="object-type">{def.object_type}</span>
							</td>
							<td>
								<span class="relation-name mono">{def.relation_name}</span>
							</td>
							<td>
								<div class="expression">
									<span class="expr-type">{getExpressionTypeLabel(def.definition.type)}</span>
									<span class="expr-preview">{formatRelationExpression(def.definition)}</span>
								</div>
							</td>
							<td>{def.priority}</td>
							<td>
								<span
									class="status-badge"
									class:status-active={def.is_active}
									class:status-inactive={!def.is_active}
								>
									{def.is_active ? 'Active' : 'Inactive'}
								</span>
							</td>
							<td>
								<span class="source-badge" class:default={def.tenant_id === 'default'}>
									{def.tenant_id === 'default' ? 'Default' : 'Custom'}
								</span>
							</td>
							<td>{formatDate(def.updated_at)}</td>
							<td>
								<div class="table-actions">
									<a href="/admin/rebac/definitions/{def.id}" class="btn btn-ghost btn-sm">View</a>
									{#if def.tenant_id !== 'default'}
										<button
											class="btn btn-ghost btn-sm text-danger"
											onclick={(e) => openDeleteDialog(def, e)}
										>
											Delete
										</button>
									{/if}
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
					disabled={pagination.page === 1}
					onclick={() => goToPage(pagination.page - 1)}
				>
					Previous
				</button>
				<span class="pagination-info">
					Page {pagination.page} of {pagination.total_pages}
					<span class="text-muted">({pagination.total} total)</span>
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
	<div class="modal-overlay" onclick={() => (showCreateDialog = false)} role="presentation">
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
			<div class="modal-header">
				<h2 class="modal-title">Create Relation Definition</h2>
			</div>
			<div class="modal-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-group">
					<label for="object-type" class="form-label">Object Type</label>
					<input
						id="object-type"
						type="text"
						class="form-input"
						bind:value={createForm.object_type}
						placeholder="document, folder, project..."
					/>
				</div>

				<div class="form-group">
					<label for="relation-name" class="form-label">Relation Name</label>
					<input
						id="relation-name"
						type="text"
						class="form-input"
						bind:value={createForm.relation_name}
						placeholder="viewer, editor, owner..."
					/>
				</div>

				<div class="form-group">
					<label for="def-type" class="form-label">Definition Type</label>
					<select id="def-type" class="form-select" bind:value={createForm.definition_type}>
						<option value="direct">Direct Relation</option>
						<option value="union">Union (OR)</option>
					</select>
				</div>

				{#if createForm.definition_type === 'direct'}
					<div class="form-group">
						<label for="direct-rel" class="form-label">Direct Relation</label>
						<input
							id="direct-rel"
							type="text"
							class="form-input"
							bind:value={createForm.direct_relation}
							placeholder="Leave empty to use relation name"
						/>
						<span class="form-hint">The actual relation to check in the database</span>
					</div>
				{/if}

				<div class="form-group">
					<label for="description" class="form-label">Description</label>
					<textarea
						id="description"
						class="form-input"
						bind:value={createForm.description}
						placeholder="Optional description..."
						rows="2"
					></textarea>
				</div>

				<div class="form-group">
					<label for="priority" class="form-label">Priority</label>
					<input
						id="priority"
						type="number"
						class="form-input"
						bind:value={createForm.priority}
						min="0"
						max="1000"
					/>
					<span class="form-hint">Higher priority definitions are evaluated first</span>
				</div>
			</div>
			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showCreateDialog = false)}>Cancel</button>
				<button class="btn btn-primary" onclick={submitCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete Dialog -->
{#if showDeleteDialog && definitionToDelete}
	<div class="modal-overlay" onclick={() => (showDeleteDialog = false)} role="presentation">
		<div
			class="modal-content modal-sm"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title">Delete Relation Definition</h2>
			</div>
			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p>
					Are you sure you want to delete the relation definition
					<strong>{definitionToDelete.object_type}#{definitionToDelete.relation_name}</strong>?
				</p>
				<p class="text-danger">This action cannot be undone.</p>
			</div>
			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}>Cancel</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

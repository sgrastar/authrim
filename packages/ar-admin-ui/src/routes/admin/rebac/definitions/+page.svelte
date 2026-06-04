<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminReBACAPI,
		type RelationDefinition,
		formatRelationExpression,
		type RelationExpressionType
	} from '$lib/api/admin-rebac';
	import { Modal } from '$lib/components';
	import { getLocale, LL } from '$i18n/i18n-svelte';

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
	let loadedTenantId = $state('');

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
			error = err instanceof Error ? err.message : $LL.admin_rebac_definitions_load_failed();
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
			createError = $LL.admin_rebac_definitions_object_relation_required();
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
			createError =
				err instanceof Error ? err.message : $LL.admin_rebac_definitions_create_failed();
		} finally {
			creating = false;
		}
	}

	function openDeleteDialog(def: RelationDefinition, event: Event) {
		event.stopPropagation();
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
			deleteError =
				err instanceof Error ? err.message : $LL.admin_rebac_definitions_delete_failed();
		} finally {
			deleting = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatExpressionTypeLabel(type: RelationExpressionType): string {
		switch (type) {
			case 'direct':
				return $LL.admin_rebac_expr_direct();
			case 'union':
				return $LL.admin_rebac_expr_union();
			case 'intersection':
				return $LL.admin_rebac_expr_intersection();
			case 'exclusion':
				return $LL.admin_rebac_expr_exclusion();
			case 'tuple_to_userset':
				return $LL.admin_rebac_expr_inherited();
			default:
				return type;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		definitions = [];
		error = '';
		pagination.page = 1;
		loadDefinitions();
	});
</script>

<svelte:head>
	<title>{$LL.admin_rebac_definitions_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<nav class="breadcrumb">
				<a href="/admin/rebac">ReBAC</a>
				<span>/</span>
				<span>{$LL.admin_rebac_relation_definitions()}</span>
			</nav>
			<h1 class="page-title">{$LL.admin_rebac_relation_definitions()}</h1>
			<p class="modal-description">
				{$LL.admin_rebac_definitions_description()}
			</p>
		</div>
		<button class="btn btn-primary" onclick={openCreateDialog}
			>+ {$LL.admin_rebac_create_definition()}</button
		>
	</div>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadDefinitions}
				>{$LL.admin_rebac_retry()}</button
			>
		</div>
	{/if}

	<!-- Filters -->
	<div class="filter-bar">
		<input
			type="text"
			placeholder={$LL.admin_rebac_definitions_search_placeholder()}
			bind:value={filterSearch}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder={$LL.admin_rebac_definitions_object_type()}
			bind:value={filterObjectType}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<select bind:value={filterActive} onchange={applyFilters}>
			<option value="all">{$LL.admin_rebac_definitions_all_status()}</option>
			<option value="active">{$LL.admin_rebac_definitions_active()}</option>
			<option value="inactive">{$LL.admin_rebac_definitions_inactive()}</option>
		</select>
		<button class="btn-filter" onclick={applyFilters}>{$LL.admin_rebac_tuples_apply()}</button>
		<button class="btn-clear" onclick={clearFilters}>{$LL.admin_rebac_tuples_clear()}</button>
	</div>

	<!-- Definitions Table -->
	{#if loading}
		<div class="loading-state">{$LL.admin_rebac_loading()}</div>
	{:else if definitions.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_rebac_definitions_empty()}</p>
			<button class="btn btn-primary" onclick={openCreateDialog}
				>{$LL.admin_rebac_create_definition()}</button
			>
		</div>
	{:else}
		<div class="table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_rebac_definitions_object_type()}</th>
						<th>{$LL.admin_rebac_relation()}</th>
						<th>{$LL.admin_rebac_definitions_expression()}</th>
						<th>{$LL.admin_rebac_definitions_priority()}</th>
						<th>{$LL.admin_rebac_definitions_status()}</th>
						<th>{$LL.admin_rebac_definitions_source()}</th>
						<th>{$LL.admin_rebac_definitions_updated()}</th>
						<th>{$LL.admin_rebac_tuples_actions()}</th>
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
									<span class="expr-type">{formatExpressionTypeLabel(def.definition.type)}</span>
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
									{def.is_active
										? $LL.admin_rebac_definitions_active()
										: $LL.admin_rebac_definitions_inactive()}
								</span>
							</td>
							<td>
								<span class="source-badge"> {$LL.admin_rebac_definitions_tenant()} </span>
							</td>
							<td>{formatDate(def.updated_at)}</td>
							<td>
								<div class="table-actions">
									<a href="/admin/rebac/definitions/{def.id}" class="btn btn-ghost btn-sm"
										>{$LL.admin_rebac_definitions_view()}</a
									>
									<button
										class="btn btn-ghost btn-sm text-danger"
										onclick={(e) => openDeleteDialog(def, e)}
									>
										{$LL.admin_rebac_tuples_delete()}
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
					disabled={pagination.page === 1}
					onclick={() => goToPage(pagination.page - 1)}
				>
					{$LL.admin_rebac_tuples_previous()}
				</button>
				<span class="pagination-info">
					{$LL.admin_rebac_tuples_page_of({
						page: pagination.page,
						totalPages: pagination.total_pages
					})}
					<span class="text-muted"
						>{$LL.admin_rebac_tuples_total_count({ count: pagination.total })}</span
					>
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page === pagination.total_pages}
					onclick={() => goToPage(pagination.page + 1)}
				>
					{$LL.admin_rebac_tuples_next()}
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={() => (showCreateDialog = false)}
	title={$LL.admin_rebac_definitions_create_title()}
	size="md"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="form-group">
		<label for="object-type" class="form-label">{$LL.admin_rebac_definitions_object_type()}</label>
		<input
			id="object-type"
			type="text"
			class="form-input"
			bind:value={createForm.object_type}
			placeholder="document, folder, project..."
		/>
	</div>

	<div class="form-group">
		<label for="relation-name" class="form-label"
			>{$LL.admin_rebac_definitions_relation_name()}</label
		>
		<input
			id="relation-name"
			type="text"
			class="form-input"
			bind:value={createForm.relation_name}
			placeholder="viewer, editor, owner..."
		/>
	</div>

	<div class="form-group">
		<label for="def-type" class="form-label">{$LL.admin_rebac_definitions_definition_type()}</label>
		<select id="def-type" class="form-select" bind:value={createForm.definition_type}>
			<option value="direct">{$LL.admin_rebac_definitions_direct_relation()}</option>
			<option value="union">{$LL.admin_rebac_expr_union()}</option>
		</select>
	</div>

	{#if createForm.definition_type === 'direct'}
		<div class="form-group">
			<label for="direct-rel" class="form-label"
				>{$LL.admin_rebac_definitions_direct_relation()}</label
			>
			<input
				id="direct-rel"
				type="text"
				class="form-input"
				bind:value={createForm.direct_relation}
				placeholder={$LL.admin_rebac_definitions_direct_placeholder()}
			/>
			<span class="form-hint">{$LL.admin_rebac_definitions_direct_hint()}</span>
		</div>
	{/if}

	<div class="form-group">
		<label for="description" class="form-label"
			>{$LL.admin_rebac_definitions_description_label()}</label
		>
		<textarea
			id="description"
			class="form-input"
			bind:value={createForm.description}
			placeholder={$LL.admin_rebac_definitions_description_placeholder()}
			rows="2"
		></textarea>
	</div>

	<div class="form-group">
		<label for="priority" class="form-label">{$LL.admin_rebac_definitions_priority()}</label>
		<input
			id="priority"
			type="number"
			class="form-input"
			bind:value={createForm.priority}
			min="0"
			max="1000"
		/>
		<span class="form-hint">{$LL.admin_rebac_definitions_priority_hint()}</span>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showCreateDialog = false)}
			>{$LL.admin_rebac_tuples_cancel()}</button
		>
		<button class="btn btn-primary" onclick={submitCreate} disabled={creating}>
			{creating ? $LL.admin_rebac_tuples_creating() : $LL.admin_rebac_tuples_create()}
		</button>
	{/snippet}
</Modal>

<!-- Delete Dialog -->
<Modal
	open={showDeleteDialog && !!definitionToDelete}
	onClose={() => (showDeleteDialog = false)}
	title={$LL.admin_rebac_definitions_delete_title()}
	size="sm"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	<p>
		{$LL.admin_rebac_definitions_delete_confirm_prefix()}
		<strong>{definitionToDelete?.object_type}#{definitionToDelete?.relation_name}</strong
		>{$LL.admin_rebac_definitions_delete_confirm_suffix()}
	</p>
	<p class="text-danger">{$LL.admin_rebac_tuples_cannot_be_undone()}</p>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}
			>{$LL.admin_rebac_tuples_cancel()}</button
		>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_rebac_tuples_deleting() : $LL.admin_rebac_tuples_delete()}
		</button>
	{/snippet}
</Modal>

<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminRebacAPI } from '$lib/api/admin-admin-rebac';
	import type {
		AdminRebacDefinition,
		AdminRebacDefinitionCreateInput,
		AdminRebacDefinitionUpdateInput
	} from '$lib/api/admin-admin-rebac';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminToolbar
	} from '$lib/components/admin';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let definitions: AdminRebacDefinition[] = [];
	let loading = true;
	let error = '';
	let searchQuery = '';

	let showCreateDialog = false;
	let createForm: AdminRebacDefinitionCreateInput = {
		relation_name: '',
		display_name: '',
		description: '',
		priority: 0
	};
	let createLoading = false;
	let createError = '';

	let showEditDialog = false;
	let editingDefinition: AdminRebacDefinition | null = null;
	let editForm: AdminRebacDefinitionUpdateInput = {};
	let editLoading = false;
	let editError = '';

	let showDeleteDialog = false;
	let deletingDefinition: AdminRebacDefinition | null = null;
	let deleteLoading = false;
	let deleteError = '';

	async function loadDefinitions() {
		loading = true;
		error = '';
		try {
			const response = await adminAdminRebacAPI.listDefinitions({ include_system: true });
			definitions = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_rebac_load_definitions_failed();
		} finally {
			loading = false;
		}
	}

	function openCreateDialog() {
		createForm = {
			relation_name: '',
			display_name: '',
			description: '',
			priority: 0
		};
		createError = '';
		showCreateDialog = true;
	}

	async function handleCreate() {
		if (!createForm.relation_name) return;
		createLoading = true;
		createError = '';
		try {
			await adminAdminRebacAPI.createDefinition(createForm);
			showCreateDialog = false;
			await loadDefinitions();
		} catch (err) {
			createError =
				err instanceof Error ? err.message : $LL.admin_admin_rebac_create_definition_failed();
		} finally {
			createLoading = false;
		}
	}

	function openEditDialog(definition: AdminRebacDefinition) {
		editingDefinition = definition;
		editForm = {
			display_name: definition.display_name || '',
			description: definition.description || '',
			priority: definition.priority
		};
		editError = '';
		showEditDialog = true;
	}

	async function handleEdit() {
		if (!editingDefinition) return;

		editLoading = true;
		editError = '';
		try {
			await adminAdminRebacAPI.updateDefinition(editingDefinition.id, editForm);
			showEditDialog = false;
			await loadDefinitions();
		} catch (err) {
			editError =
				err instanceof Error ? err.message : $LL.admin_admin_rebac_update_definition_failed();
		} finally {
			editLoading = false;
		}
	}

	function openDeleteDialog(definition: AdminRebacDefinition) {
		deletingDefinition = definition;
		deleteError = '';
		showDeleteDialog = true;
	}

	async function handleDelete() {
		if (!deletingDefinition) return;

		deleteLoading = true;
		deleteError = '';
		try {
			await adminAdminRebacAPI.deleteDefinition(deletingDefinition.id);
			showDeleteDialog = false;
			await loadDefinitions();
		} catch (err) {
			deleteError =
				err instanceof Error ? err.message : $LL.admin_admin_rebac_delete_definition_failed();
		} finally {
			deleteLoading = false;
		}
	}

	onMount(() => {
		loadDefinitions();
	});

	$: filteredDefinitions = definitions.filter(
		(definition) =>
			definition.relation_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			definition.display_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
			definition.description?.toLowerCase().includes(searchQuery.toLowerCase())
	);
</script>

<svelte:head>
	<title>{$LL.admin_admin_rebac_definitions_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_rebac_definitions_title()}
		description={$LL.admin_admin_rebac_definitions_description()}
	>
		{#snippet actions()}
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<span class="i-ph-plus"></span>
				{$LL.admin_admin_rebac_create_definition()}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<AdminToolbar>
		<div class="admin-field admin-field--search">
			<label class="admin-field__label" for="rebac-definition-search">
				{$LL.admin_admin_rebac_search_definitions_placeholder()}
			</label>
			<div class="search-box">
				<span class="i-ph-magnifying-glass"></span>
				<input
					id="rebac-definition-search"
					class="admin-input search-input"
					type="text"
					bind:value={searchQuery}
					placeholder={$LL.admin_admin_rebac_search_definitions_placeholder()}
				/>
			</div>
		</div>
	</AdminToolbar>

	{#if loading}
		<AdminSection>
			<div class="loading-state">{$LL.admin_admin_rebac_loading_definitions()}</div>
		</AdminSection>
	{:else if filteredDefinitions.length === 0}
		<AdminSection>
			<div class="empty-state">
				<span class="i-ph-arrows-split empty-state__icon"></span>
				<h2>{$LL.admin_admin_rebac_no_definitions_found()}</h2>
				<p>
					{searchQuery
						? $LL.admin_admin_rebac_try_adjusting_search()
						: $LL.admin_admin_rebac_create_definition_empty()}
				</p>
				{#if !searchQuery}
					<button class="btn btn-primary" onclick={openCreateDialog}>
						{$LL.admin_admin_rebac_create_definition()}
					</button>
				{/if}
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<div class="definition-list">
				{#each filteredDefinitions as definition (definition.id)}
					<article class="definition-card">
						<div class="definition-card__main">
							<div class="definition-card__heading">
								<h2>{definition.relation_name}</h2>
								{#if definition.is_system}
									<span class="mini-badge">{$LL.admin_admin_rebac_system()}</span>
								{/if}
							</div>
							{#if definition.display_name}
								<p class="definition-card__name">{definition.display_name}</p>
							{/if}
							{#if definition.description}
								<p class="definition-card__description">{definition.description}</p>
							{/if}
							<div class="definition-card__meta">
								<span>{$LL.admin_admin_rebac_priority({ priority: definition.priority })}</span>
								<span>{$LL.admin_admin_rebac_tenant({ tenant: definition.tenant_id })}</span>
							</div>
						</div>
						<div class="definition-card__actions">
							{#if !definition.is_system}
								<button
									class="icon-action"
									onclick={() => openEditDialog(definition)}
									title={$LL.admin_admin_rebac_edit()}
									aria-label={$LL.admin_admin_rebac_edit()}
								>
									<span class="i-ph-pencil"></span>
								</button>
								<button
									class="icon-action icon-action--danger"
									onclick={() => openDeleteDialog(definition)}
									title={$LL.admin_admin_rebac_delete()}
									aria-label={$LL.admin_admin_rebac_delete()}
								>
									<span class="i-ph-trash"></span>
								</button>
							{:else}
								<span class="system-note">{$LL.admin_admin_rebac_system_protected()}</span>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<Modal
	open={showCreateDialog}
	onClose={() => (showCreateDialog = false)}
	title={$LL.admin_admin_rebac_create_relationship_definition()}
	size="md"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}
	<div class="modal-form">
		<label class="form-field" for="relation_name">
			<span>{$LL.admin_admin_rebac_relation_name()} <b>*</b></span>
			<input
				id="relation_name"
				class="form-control form-control--mono"
				type="text"
				bind:value={createForm.relation_name}
				placeholder="admin_supervises"
			/>
			<small>{$LL.admin_admin_rebac_relation_name_help()}</small>
		</label>
		<label class="form-field" for="display_name">
			<span>{$LL.admin_admin_rebac_display_name()}</span>
			<input
				id="display_name"
				class="form-control"
				type="text"
				bind:value={createForm.display_name}
				placeholder={$LL.admin_admin_rebac_display_name_placeholder()}
			/>
		</label>
		<label class="form-field" for="description">
			<span>{$LL.admin_admin_rebac_description_label()}</span>
			<textarea
				id="description"
				class="form-control"
				bind:value={createForm.description}
				placeholder={$LL.admin_admin_rebac_description_placeholder()}
				rows="3"
			></textarea>
		</label>
		<label class="form-field" for="priority">
			<span>{$LL.admin_admin_rebac_priority_label()}</span>
			<input
				id="priority"
				class="form-control"
				type="number"
				bind:value={createForm.priority}
				placeholder="0"
			/>
			<small>{$LL.admin_admin_rebac_priority_help()}</small>
		</label>
	</div>

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => (showCreateDialog = false)}
			disabled={createLoading}
		>
			{$LL.admin_admin_rebac_cancel()}
		</button>
		<button
			class="btn btn-primary"
			onclick={handleCreate}
			disabled={createLoading || !createForm.relation_name}
		>
			{createLoading ? $LL.admin_admin_rebac_creating() : $LL.admin_admin_rebac_create()}
		</button>
	{/snippet}
</Modal>

<Modal
	open={showEditDialog && !!editingDefinition}
	onClose={() => (showEditDialog = false)}
	title={$LL.admin_admin_rebac_edit_relationship_definition()}
	size="md"
>
	{#if editError}
		<div class="alert alert-error">{editError}</div>
	{/if}
	{#if editingDefinition}
		<div class="modal-form">
			<div class="form-field">
				<span>{$LL.admin_admin_rebac_relation_name()}</span>
				<div class="readonly-value">{editingDefinition.relation_name}</div>
				<small>{$LL.admin_admin_rebac_relation_name_readonly_help()}</small>
			</div>
			<label class="form-field" for="edit_display_name">
				<span>{$LL.admin_admin_rebac_display_name()}</span>
				<input
					id="edit_display_name"
					class="form-control"
					type="text"
					bind:value={editForm.display_name}
					placeholder={$LL.admin_admin_rebac_display_name_placeholder()}
				/>
			</label>
			<label class="form-field" for="edit_description">
				<span>{$LL.admin_admin_rebac_description_label()}</span>
				<textarea
					id="edit_description"
					class="form-control"
					bind:value={editForm.description}
					placeholder={$LL.admin_admin_rebac_description_placeholder()}
					rows="3"
				></textarea>
			</label>
			<label class="form-field" for="edit_priority">
				<span>{$LL.admin_admin_rebac_priority_label()}</span>
				<input
					id="edit_priority"
					class="form-control"
					type="number"
					bind:value={editForm.priority}
					placeholder="0"
				/>
			</label>
		</div>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => (showEditDialog = false)}
			disabled={editLoading}
		>
			{$LL.admin_admin_rebac_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleEdit} disabled={editLoading}>
			{editLoading ? $LL.admin_admin_rebac_saving() : $LL.admin_admin_rebac_save()}
		</button>
	{/snippet}
</Modal>

<Modal
	open={showDeleteDialog && !!deletingDefinition}
	onClose={() => (showDeleteDialog = false)}
	title={$LL.admin_admin_rebac_delete_relationship_definition()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}
	{#if deletingDefinition}
		<p class="confirm-copy">
			{$LL.admin_admin_rebac_delete_definition_confirm({
				name: deletingDefinition.relation_name
			})}
		</p>
		<p class="danger-copy">{$LL.admin_admin_rebac_delete_definition_warning()}</p>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => (showDeleteDialog = false)}
			disabled={deleteLoading}
		>
			{$LL.admin_admin_rebac_cancel()}
		</button>
		<button class="btn btn-danger" onclick={handleDelete} disabled={deleteLoading}>
			{deleteLoading ? $LL.admin_admin_rebac_deleting() : $LL.admin_admin_rebac_delete()}
		</button>
	{/snippet}
</Modal>

<style>
	.search-box {
		position: relative;
	}

	.search-box :global(.i-ph-magnifying-glass) {
		position: absolute;
		left: 0.75rem;
		top: 50%;
		width: 18px;
		height: 18px;
		color: var(--color-text-subtle);
		transform: translateY(-50%);
	}

	.search-input {
		padding-left: 2.5rem;
	}

	.alert {
		padding: 12px 14px;
		border-radius: var(--radius-control);
		margin-bottom: 1rem;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
		color: var(--color-danger);
	}

	.loading-state,
	.empty-state {
		display: grid;
		place-items: center;
		gap: 12px;
		min-height: 220px;
		padding: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		color: var(--color-text-muted);
		text-align: center;
	}

	.empty-state h2,
	.empty-state p {
		margin: 0;
	}

	.empty-state h2 {
		color: var(--color-text);
		font-size: 1.1rem;
	}

	.empty-state__icon {
		color: var(--color-text-subtle);
		font-size: 3rem;
	}

	.definition-list {
		display: grid;
		gap: 14px;
	}

	.definition-card {
		display: flex;
		justify-content: space-between;
		gap: 18px;
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-sm));
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.definition-card:hover {
		border-color: var(--color-accent);
		box-shadow: var(--shadow-md);
	}

	.definition-card__main {
		min-width: 0;
	}

	.definition-card__heading {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.definition-card__heading h2 {
		margin: 0;
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 1rem;
	}

	.definition-card__name {
		margin: 0 0 5px;
		color: var(--color-text);
	}

	.definition-card__description {
		margin: 0 0 12px;
		color: var(--color-text-muted);
		font-size: 0.88rem;
		line-height: 1.65;
	}

	.definition-card__meta {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
		color: var(--color-text-subtle);
		font-size: 0.78rem;
	}

	.definition-card__actions {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		flex: 0 0 auto;
	}

	.icon-action {
		display: grid;
		width: 34px;
		height: 34px;
		place-items: center;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.icon-action:hover {
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.icon-action--danger:hover {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.mini-badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.system-note {
		color: var(--color-text-subtle);
		font-size: 0.76rem;
		font-style: italic;
	}

	.modal-form {
		display: grid;
		gap: 16px;
	}

	.form-field {
		display: grid;
		gap: 6px;
		color: var(--color-text);
		font-size: 0.88rem;
	}

	.form-field b,
	.danger-copy {
		color: var(--color-danger);
	}

	.form-field small {
		color: var(--color-text-subtle);
		font-size: 0.76rem;
	}

	.form-control,
	.readonly-value {
		width: 100%;
		padding: 9px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
	}

	.form-control--mono,
	.readonly-value {
		font-family: var(--font-mono);
		font-size: 0.86rem;
	}

	.readonly-value {
		background: var(--color-surface-muted);
	}

	.form-control:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.confirm-copy,
	.danger-copy {
		margin: 0 0 12px;
		line-height: 1.7;
	}

	.confirm-copy {
		color: var(--color-text-muted);
	}

	@media (max-width: 720px) {
		.definition-card {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>

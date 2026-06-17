<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminRebacAPI } from '$lib/api/admin-admin-rebac';
	import type {
		AdminRelationship,
		AdminRelationshipCreateInput,
		AdminRebacDefinition
	} from '$lib/api/admin-admin-rebac';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminToolbar
	} from '$lib/components/admin';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let relationships: AdminRelationship[] = [];
	let definitions: AdminRebacDefinition[] = [];
	let loading = true;
	let error = '';
	let searchQuery = '';
	let filterType = '';

	let showCreateDialog = false;
	let createForm: AdminRelationshipCreateInput = {
		relationship_type: '',
		from_id: '',
		to_id: '',
		from_type: 'admin_user',
		to_type: 'admin_user',
		permission_level: undefined,
		is_transitive: false,
		is_bidirectional: false
	};
	let createLoading = false;
	let createError = '';

	let showDeleteDialog = false;
	let deletingRelationship: AdminRelationship | null = null;
	let deleteLoading = false;
	let deleteError = '';

	async function loadData() {
		loading = true;
		error = '';
		try {
			const [relsResponse, defsResponse] = await Promise.all([
				adminAdminRebacAPI.listRelationships({ limit: 1000 }),
				adminAdminRebacAPI.listDefinitions({ include_system: true })
			]);
			relationships = relsResponse.items;
			definitions = defsResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_rebac_load_failed();
		} finally {
			loading = false;
		}
	}

	function openCreateDialog() {
		createForm = {
			relationship_type: definitions.length > 0 ? definitions[0].relation_name : '',
			from_id: '',
			to_id: '',
			from_type: 'admin_user',
			to_type: 'admin_user',
			permission_level: undefined,
			is_transitive: false,
			is_bidirectional: false
		};
		createError = '';
		showCreateDialog = true;
	}

	async function handleCreate() {
		if (!createForm.relationship_type || !createForm.from_id || !createForm.to_id) return;
		createLoading = true;
		createError = '';
		try {
			await adminAdminRebacAPI.createRelationship(createForm);
			showCreateDialog = false;
			await loadData();
		} catch (err) {
			createError =
				err instanceof Error ? err.message : $LL.admin_admin_rebac_create_relationship_failed();
		} finally {
			createLoading = false;
		}
	}

	function openDeleteDialog(relationship: AdminRelationship) {
		deletingRelationship = relationship;
		deleteError = '';
		showDeleteDialog = true;
	}

	async function handleDelete() {
		if (!deletingRelationship) return;

		deleteLoading = true;
		deleteError = '';
		try {
			await adminAdminRebacAPI.deleteRelationship(deletingRelationship.id);
			showDeleteDialog = false;
			await loadData();
		} catch (err) {
			deleteError =
				err instanceof Error ? err.message : $LL.admin_admin_rebac_delete_relationship_failed();
		} finally {
			deleteLoading = false;
		}
	}

	onMount(() => {
		loadData();
	});

	$: filteredRelationships = relationships.filter((relationship) => {
		const matchesSearch =
			!searchQuery ||
			relationship.from_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
			relationship.to_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
			relationship.relationship_type.toLowerCase().includes(searchQuery.toLowerCase());

		const matchesType = !filterType || relationship.relationship_type === filterType;

		return matchesSearch && matchesType;
	});
</script>

<svelte:head>
	<title>{$LL.admin_admin_rebac_tuples_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_rebac_tuples_title()}
		description={$LL.admin_admin_rebac_tuples_description()}
	>
		{#snippet actions()}
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<span class="i-ph-plus"></span>
				{$LL.admin_admin_rebac_create_relationship()}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<AdminToolbar>
		<div class="admin-field admin-field--search">
			<label class="admin-field__label" for="rebac-relationship-search">
				{$LL.admin_admin_rebac_search_relationships_placeholder()}
			</label>
			<div class="search-box">
				<span class="i-ph-magnifying-glass"></span>
				<input
					id="rebac-relationship-search"
					class="admin-input search-input"
					type="text"
					bind:value={searchQuery}
					placeholder={$LL.admin_admin_rebac_search_relationships_placeholder()}
				/>
			</div>
		</div>
		<div class="admin-field admin-field--compact">
			<label class="admin-field__label" for="rebac-relationship-type">
				{$LL.admin_admin_rebac_relationship_type()}
			</label>
			<select id="rebac-relationship-type" class="admin-select" bind:value={filterType}>
				<option value="">{$LL.admin_admin_rebac_all_types()}</option>
				{#each definitions as definition (definition.id)}
					<option value={definition.relation_name}>{definition.relation_name}</option>
				{/each}
			</select>
		</div>
	</AdminToolbar>

	{#if loading}
		<AdminSection>
			<div class="loading-state">{$LL.admin_admin_rebac_loading_relationships()}</div>
		</AdminSection>
	{:else if filteredRelationships.length === 0}
		<AdminSection>
			<div class="empty-state">
				<span class="i-ph-link empty-state__icon"></span>
				<h2>{$LL.admin_admin_rebac_no_relationships_found()}</h2>
				<p>
					{searchQuery || filterType
						? $LL.admin_admin_rebac_try_adjusting_filters()
						: $LL.admin_admin_rebac_create_relationship_empty()}
				</p>
				{#if !searchQuery && !filterType}
					<button class="btn btn-primary" onclick={openCreateDialog}>
						{$LL.admin_admin_rebac_create_relationship()}
					</button>
				{/if}
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_admin_rebac_from()}</th>
						<th>{$LL.admin_admin_rebac_relationship()}</th>
						<th>{$LL.admin_admin_rebac_to()}</th>
						<th>{$LL.admin_admin_rebac_details()}</th>
						<th class="text-right">{$LL.admin_admin_rebac_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredRelationships as relationship (relationship.id)}
						<tr>
							<td>
								<div class="identity-cell identity-cell--from">
									<span>{relationship.from_id}</span>
									{#if relationship.from_type}
										<small>{relationship.from_type}</small>
									{/if}
								</div>
							</td>
							<td>
								<span class="relation-name">{relationship.relationship_type}</span>
							</td>
							<td>
								<div class="identity-cell identity-cell--to">
									<span>{relationship.to_id}</span>
									{#if relationship.to_type}
										<small>{relationship.to_type}</small>
									{/if}
								</div>
							</td>
							<td>
								<div class="badge-list">
									{#if relationship.permission_level}
										<span class="mini-badge mini-badge--accent">
											{relationship.permission_level}
										</span>
									{/if}
									{#if relationship.is_transitive}
										<span class="mini-badge">{$LL.admin_admin_rebac_transitive()}</span>
									{/if}
									{#if relationship.is_bidirectional}
										<span class="mini-badge">{$LL.admin_admin_rebac_bidirectional()}</span>
									{/if}
									{#if relationship.expires_at}
										<span class="mini-badge">{$LL.admin_admin_rebac_expires()}</span>
									{/if}
								</div>
							</td>
							<td class="text-right">
								<button
									class="icon-action icon-action--danger"
									onclick={() => openDeleteDialog(relationship)}
									title={$LL.admin_admin_rebac_delete()}
									aria-label={$LL.admin_admin_rebac_delete()}
								>
									<span class="i-ph-trash"></span>
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
			<p class="result-count">
				{$LL.admin_admin_rebac_relationships_showing({
					shown: filteredRelationships.length,
					total: relationships.length
				})}
			</p>
		</AdminSection>
	{/if}
</AdminPageShell>

<Modal
	open={showCreateDialog}
	onClose={() => (showCreateDialog = false)}
	title={$LL.admin_admin_rebac_create_relationship()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}
	<div class="modal-form">
		<label class="form-field" for="relationship_type">
			<span>{$LL.admin_admin_rebac_relationship_type()} <b>*</b></span>
			<select id="relationship_type" class="form-control" bind:value={createForm.relationship_type}>
				{#each definitions as definition (definition.id)}
					<option value={definition.relation_name}>
						{definition.relation_name}
						{#if definition.display_name}
							- {definition.display_name}
						{/if}
					</option>
				{/each}
			</select>
		</label>

		<div class="form-grid">
			<label class="form-field" for="from_id">
				<span>{$LL.admin_admin_rebac_from_subject()} <b>*</b></span>
				<input
					id="from_id"
					class="form-control form-control--mono"
					type="text"
					bind:value={createForm.from_id}
					placeholder="admin_user_id"
				/>
			</label>
			<label class="form-field" for="to_id">
				<span>{$LL.admin_admin_rebac_to_object()} <b>*</b></span>
				<input
					id="to_id"
					class="form-control form-control--mono"
					type="text"
					bind:value={createForm.to_id}
					placeholder="admin_user_id"
				/>
			</label>
		</div>

		<div class="form-grid">
			<label class="form-field" for="from_type">
				<span>{$LL.admin_admin_rebac_from_type()}</span>
				<input
					id="from_type"
					class="form-control"
					type="text"
					bind:value={createForm.from_type}
					placeholder="admin_user"
				/>
			</label>
			<label class="form-field" for="to_type">
				<span>{$LL.admin_admin_rebac_to_type()}</span>
				<input
					id="to_type"
					class="form-control"
					type="text"
					bind:value={createForm.to_type}
					placeholder="admin_user"
				/>
			</label>
		</div>

		<label class="form-field" for="permission_level">
			<span>{$LL.admin_admin_rebac_permission_level()}</span>
			<select id="permission_level" class="form-control" bind:value={createForm.permission_level}>
				<option value={undefined}>{$LL.admin_admin_rebac_permission_none()}</option>
				<option value="full">{$LL.admin_admin_rebac_permission_full()}</option>
				<option value="limited">{$LL.admin_admin_rebac_permission_limited()}</option>
				<option value="read_only">{$LL.admin_admin_rebac_permission_read_only()}</option>
			</select>
		</label>

		<div class="check-list">
			<label>
				<input type="checkbox" bind:checked={createForm.is_transitive} />
				<span>{$LL.admin_admin_rebac_transitive_help()}</span>
			</label>
			<label>
				<input type="checkbox" bind:checked={createForm.is_bidirectional} />
				<span>{$LL.admin_admin_rebac_bidirectional_help()}</span>
			</label>
		</div>
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
			disabled={createLoading ||
				!createForm.relationship_type ||
				!createForm.from_id ||
				!createForm.to_id}
		>
			{createLoading ? $LL.admin_admin_rebac_creating() : $LL.admin_admin_rebac_create()}
		</button>
	{/snippet}
</Modal>

<Modal
	open={showDeleteDialog && !!deletingRelationship}
	onClose={() => (showDeleteDialog = false)}
	title={$LL.admin_admin_rebac_delete_relationship()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}
	{#if deletingRelationship}
		<p class="confirm-copy">{$LL.admin_admin_rebac_delete_relationship_confirm()}</p>
		<div class="relationship-preview">
			<span class="relationship-preview__from">{deletingRelationship.from_id}</span>
			<span class="relationship-preview__type">{deletingRelationship.relationship_type}</span>
			<span class="relationship-preview__to">{deletingRelationship.to_id}</span>
		</div>
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

	.identity-cell {
		display: grid;
		gap: 3px;
		min-width: 180px;
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	.identity-cell--from {
		color: var(--color-accent);
	}

	.identity-cell--to {
		color: color-mix(in srgb, var(--color-accent) 76%, var(--color-text));
	}

	.identity-cell small {
		color: var(--color-text-subtle);
		font-family: var(--font-body);
		font-size: 0.72rem;
	}

	.relation-name {
		color: var(--color-text);
		font-weight: 650;
	}

	.badge-list {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
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

	.mini-badge--accent {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
	}

	.icon-action {
		display: inline-grid;
		width: 34px;
		height: 34px;
		place-items: center;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.icon-action--danger:hover {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.result-count {
		margin: 14px 0 0;
		color: var(--color-text-muted);
		font-size: 0.84rem;
	}

	.modal-form {
		display: grid;
		gap: 16px;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.form-field {
		display: grid;
		gap: 6px;
		color: var(--color-text);
		font-size: 0.88rem;
	}

	.form-field b {
		color: var(--color-danger);
	}

	.form-control {
		width: 100%;
		padding: 9px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
	}

	.form-control--mono {
		font-family: var(--font-mono);
		font-size: 0.86rem;
	}

	.form-control:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.check-list {
		display: grid;
		gap: 10px;
	}

	.check-list label {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--color-text-muted);
		font-size: 0.86rem;
	}

	.confirm-copy {
		margin: 0 0 12px;
		color: var(--color-text-muted);
		line-height: 1.7;
	}

	.relationship-preview {
		display: grid;
		gap: 5px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
		font-family: var(--font-mono);
		font-size: 0.84rem;
	}

	.relationship-preview__from {
		color: var(--color-accent);
	}

	.relationship-preview__type {
		color: var(--color-text-muted);
	}

	.relationship-preview__to {
		color: color-mix(in srgb, var(--color-accent) 76%, var(--color-text));
	}

	@media (max-width: 720px) {
		.form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { adminReBACAPI, type RelationshipTuple, formatTupleString } from '$lib/api/admin-rebac';
	import { Modal, ToggleSwitch } from '$lib/components';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminPagination,
		AdminSection,
		AdminToolbar
	} from '$lib/components/admin';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	// State
	let tuples: RelationshipTuple[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let pagination = $state({
		page: 1,
		limit: 20,
		total: 0,
		total_pages: 0
	});

	// Filters
	let filterFromId = $state('');
	let filterToType = $state('');
	let filterToId = $state('');
	let filterRelationType = $state('');

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let createForm = $state({
		relationship_type: '',
		from_type: 'subject',
		from_id: '',
		to_type: '',
		to_id: '',
		permission_level: 'full',
		has_expiry: false,
		expires_at: ''
	});

	// Delete dialog state
	let showDeleteDialog = $state(false);
	let tupleToDelete: RelationshipTuple | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');
	let loadedTenantId = $state('');

	async function loadTuples() {
		loading = true;
		error = '';

		try {
			const response = await adminReBACAPI.listTuples({
				page: pagination.page,
				limit: pagination.limit,
				from_id: filterFromId || undefined,
				to_type: filterToType || undefined,
				to_id: filterToId || undefined,
				relationship_type: filterRelationType || undefined
			});

			tuples = response.tuples;
			pagination = response.pagination;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_rebac_tuples_load_failed();
		} finally {
			loading = false;
		}
	}

	function applyFilters() {
		pagination.page = 1;
		loadTuples();
	}

	function clearFilters() {
		filterFromId = '';
		filterToType = '';
		filterToId = '';
		filterRelationType = '';
		pagination.page = 1;
		loadTuples();
	}

	function goToPage(newPage: number) {
		if (newPage < 1 || newPage > pagination.total_pages) return;
		pagination.page = newPage;
		loadTuples();
	}

	function openCreateDialog() {
		createForm = {
			relationship_type: '',
			from_type: 'subject',
			from_id: '',
			to_type: '',
			to_id: '',
			permission_level: 'full',
			has_expiry: false,
			expires_at: ''
		};
		createError = '';
		showCreateDialog = true;
	}

	async function submitCreate() {
		if (
			!createForm.relationship_type ||
			!createForm.from_id ||
			!createForm.to_type ||
			!createForm.to_id
		) {
			createError = $LL.admin_rebac_tuples_required_fields();
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminReBACAPI.createTuple({
				relationship_type: createForm.relationship_type,
				from_type: createForm.from_type,
				from_id: createForm.from_id,
				to_type: createForm.to_type,
				to_id: createForm.to_id,
				permission_level: createForm.permission_level,
				expires_at:
					createForm.has_expiry && createForm.expires_at
						? new Date(createForm.expires_at).getTime()
						: undefined
			});

			showCreateDialog = false;
			loadTuples();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_rebac_tuples_create_failed();
		} finally {
			creating = false;
		}
	}

	function openDeleteDialog(tuple: RelationshipTuple, event: Event) {
		event.stopPropagation();
		tupleToDelete = tuple;
		deleteError = '';
		showDeleteDialog = true;
	}

	async function confirmDelete() {
		if (!tupleToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminReBACAPI.deleteTuple(tupleToDelete.id);
			showDeleteDialog = false;
			tupleToDelete = null;
			loadTuples();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_rebac_tuples_delete_failed();
		} finally {
			deleting = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function isExpired(tuple: RelationshipTuple): boolean {
		if (!tuple.expires_at) return false;
		return tuple.expires_at < Date.now();
	}

	function paginationInfo(): string {
		return `${$LL.admin_rebac_tuples_page_of({
			page: pagination.page,
			totalPages: pagination.total_pages
		})} ${$LL.admin_rebac_tuples_total_count({ count: pagination.total })}`;
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		tuples = [];
		error = '';
		pagination.page = 1;
		loadTuples();
	});
</script>

<svelte:head>
	<title>{$LL.admin_rebac_tuples_head_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<button class="btn btn-primary" onclick={openCreateDialog}>
		{$LL.admin_rebac_tuples_create_tuple()}
	</button>
{/snippet}

{#snippet retryAction()}
	<button class="btn btn-secondary btn-sm" onclick={loadTuples}>
		{$LL.admin_rebac_retry()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_rebac_relationship_tuples()}
		description={$LL.admin_rebac_tuples_description()}
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			{@render retryAction()}
		</div>
	{/if}

	<AdminSection>
		<AdminToolbar>
			<div class="admin-field admin-field--compact">
				<label class="admin-field__label" for="tuple-from-id">
					{$LL.admin_rebac_tuples_from_id_placeholder()}
				</label>
				<input
					id="tuple-from-id"
					class="admin-input"
					type="text"
					placeholder={$LL.admin_rebac_tuples_from_id_placeholder()}
					bind:value={filterFromId}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="admin-field admin-field--compact">
				<label class="admin-field__label" for="tuple-to-type">
					{$LL.admin_rebac_tuples_to_type_placeholder()}
				</label>
				<input
					id="tuple-to-type"
					class="admin-input"
					type="text"
					placeholder={$LL.admin_rebac_tuples_to_type_placeholder()}
					bind:value={filterToType}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="admin-field admin-field--compact">
				<label class="admin-field__label" for="tuple-to-id">
					{$LL.admin_rebac_tuples_to_id_placeholder()}
				</label>
				<input
					id="tuple-to-id"
					class="admin-input"
					type="text"
					placeholder={$LL.admin_rebac_tuples_to_id_placeholder()}
					bind:value={filterToId}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="admin-field admin-field--compact">
				<label class="admin-field__label" for="tuple-relation-type">
					{$LL.admin_rebac_tuples_relation_type_placeholder()}
				</label>
				<input
					id="tuple-relation-type"
					class="admin-input"
					type="text"
					placeholder={$LL.admin_rebac_tuples_relation_type_placeholder()}
					bind:value={filterRelationType}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="admin-field admin-field--compact">
				<button class="btn btn-secondary" onclick={applyFilters}>
					{$LL.admin_rebac_tuples_apply()}
				</button>
			</div>
			<div class="admin-field admin-field--compact">
				<button class="btn btn-secondary" onclick={clearFilters}>
					{$LL.admin_rebac_tuples_clear()}
				</button>
			</div>
		</AdminToolbar>
	</AdminSection>

	<!-- Tuples Table -->
	<AdminSection title={$LL.admin_rebac_relationship_tuples()}>
		{#if loading}
			<div class="loading-state">{$LL.admin_rebac_loading()}</div>
		{:else if tuples.length === 0}
			<div class="empty-state">
				<p>{$LL.admin_rebac_tuples_empty()}</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>
					{$LL.admin_rebac_tuples_create_tuple()}
				</button>
			</div>
		{:else}
			<AdminDataTable width="xwide">
				<thead>
					<tr>
						<th>{$LL.admin_rebac_tuples_subject()}</th>
						<th>{$LL.admin_rebac_relation()}</th>
						<th>{$LL.admin_rebac_object()}</th>
						<th>{$LL.admin_rebac_tuples_permission()}</th>
						<th>{$LL.admin_rebac_tuples_expires()}</th>
						<th>{$LL.admin_rebac_tuples_created()}</th>
						<th class="text-right">{$LL.admin_rebac_tuples_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each tuples as tuple (tuple.id)}
						<tr class:expired={isExpired(tuple)}>
							<td>
								<span class="entity">
									<span class="entity-type">{tuple.from_type}</span>
									<span class="entity-id">{tuple.from_id}</span>
								</span>
							</td>
							<td>
								<span class="relation-badge">{tuple.relationship_type}</span>
							</td>
							<td>
								<span class="entity">
									<span class="entity-type">{tuple.to_type}</span>
									<span class="entity-id">{tuple.to_id}</span>
								</span>
							</td>
							<td>
								<span class="permission-badge">{tuple.permission_level}</span>
							</td>
							<td>
								{#if tuple.expires_at}
									<span class="expires" class:expired={isExpired(tuple)}>
										{formatDate(tuple.expires_at)}
									</span>
								{:else}
									<span class="no-expiry">{$LL.admin_rebac_tuples_never()}</span>
								{/if}
							</td>
							<td>{formatDate(tuple.created_at)}</td>
							<td class="text-right">
								<div class="action-buttons">
									<button class="btn btn-danger btn-sm" onclick={(e) => openDeleteDialog(tuple, e)}>
										{$LL.admin_rebac_tuples_delete()}
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>

			{#if pagination.total_pages > 1}
				<AdminPagination
					label={$LL.admin_rebac_relationship_tuples()}
					info={paginationInfo()}
					previousLabel={$LL.admin_rebac_tuples_previous()}
					nextLabel={$LL.admin_rebac_tuples_next()}
					hasPrevious={pagination.page > 1}
					hasNext={pagination.page < pagination.total_pages}
					onPrevious={() => goToPage(pagination.page - 1)}
					onNext={() => goToPage(pagination.page + 1)}
				/>
			{/if}
		{/if}
	</AdminSection>
</AdminPageShell>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={() => (showCreateDialog = false)}
	title={$LL.admin_rebac_tuples_create_title()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="form-section">
		<h3>{$LL.admin_rebac_tuples_subject_from()}</h3>
		<div class="dialog-grid">
			<div class="admin-field dialog-field">
				<label for="from-type" class="admin-field__label">{$LL.admin_rebac_tuples_type()}</label>
				<select id="from-type" class="admin-input" bind:value={createForm.from_type}>
					<option value="subject">subject</option>
					<option value="group">group</option>
					<option value="org">org</option>
				</select>
			</div>
			<div class="admin-field dialog-field">
				<label for="from-id" class="admin-field__label">{$LL.admin_rebac_tuples_id()}</label>
				<input
					id="from-id"
					type="text"
					class="admin-input"
					bind:value={createForm.from_id}
					placeholder="user_123"
				/>
			</div>
		</div>
	</div>

	<div class="form-section">
		<h3>{$LL.admin_rebac_relation()}</h3>
		<div class="admin-field dialog-field">
			<label for="relation-type" class="admin-field__label">
				{$LL.admin_rebac_tuples_relationship_type()}
			</label>
			<input
				id="relation-type"
				type="text"
				class="admin-input"
				bind:value={createForm.relationship_type}
				placeholder="viewer, editor, owner..."
			/>
		</div>
	</div>

	<div class="form-section">
		<h3>{$LL.admin_rebac_tuples_object_to()}</h3>
		<div class="dialog-grid">
			<div class="admin-field dialog-field">
				<label for="to-type" class="admin-field__label">{$LL.admin_rebac_tuples_type()}</label>
				<input
					id="to-type"
					type="text"
					class="admin-input"
					bind:value={createForm.to_type}
					placeholder="document"
				/>
			</div>
			<div class="admin-field dialog-field">
				<label for="to-id" class="admin-field__label">{$LL.admin_rebac_tuples_id()}</label>
				<input
					id="to-id"
					type="text"
					class="admin-input"
					bind:value={createForm.to_id}
					placeholder="doc_456"
				/>
			</div>
		</div>
	</div>

	<div class="form-section">
		<h3>{$LL.admin_rebac_tuples_options()}</h3>
		<div class="admin-field dialog-field">
			<label for="permission-level" class="admin-field__label">
				{$LL.admin_rebac_tuples_permission_level()}
			</label>
			<select id="permission-level" class="admin-input" bind:value={createForm.permission_level}>
				<option value="full">{$LL.admin_rebac_tuples_permission_full()}</option>
				<option value="limited">{$LL.admin_rebac_tuples_permission_limited()}</option>
				<option value="read_only">{$LL.admin_rebac_tuples_permission_read_only()}</option>
			</select>
		</div>

		<div class="admin-field dialog-field">
			<ToggleSwitch
				bind:checked={createForm.has_expiry}
				label={$LL.admin_rebac_tuples_set_expiration()}
				description={$LL.admin_rebac_tuples_set_expiration_description()}
			/>
		</div>

		{#if createForm.has_expiry}
			<div class="admin-field dialog-field">
				<label for="expires-at" class="admin-field__label">
					{$LL.admin_rebac_tuples_expires_at()}
				</label>
				<input
					id="expires-at"
					type="datetime-local"
					class="admin-input"
					bind:value={createForm.expires_at}
				/>
			</div>
		{/if}
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
	open={showDeleteDialog && !!tupleToDelete}
	onClose={() => (showDeleteDialog = false)}
	title={$LL.admin_rebac_tuples_delete_title()}
	size="sm"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	<p>{$LL.admin_rebac_tuples_delete_confirm()}</p>
	{#if tupleToDelete}
		<div class="tuple-preview">
			{formatTupleString(tupleToDelete)}
		</div>
	{/if}
	<p class="danger-copy">{$LL.admin_rebac_tuples_cannot_be_undone()}</p>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}
			>{$LL.admin_rebac_tuples_cancel()}</button
		>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_rebac_tuples_deleting() : $LL.admin_rebac_tuples_delete()}
		</button>
	{/snippet}
</Modal>

<style>
	.entity {
		display: grid;
		gap: 0.18rem;
	}

	.entity-type,
	.entity-id,
	.relation-badge,
	.permission-badge {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		border-radius: var(--radius-sm);
		background: var(--color-surface-subtle);
		color: var(--color-text);
		padding: 0.16rem 0.45rem;
		font-size: 0.78rem;
	}

	.entity-id {
		color: var(--color-text-muted);
		font-family: var(--font-mono);
	}

	.relation-badge {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
		font-weight: 700;
	}

	.permission-badge {
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
	}

	.expires.expired {
		color: var(--color-danger);
		font-weight: 700;
	}

	.no-expiry {
		color: var(--color-text-muted);
	}

	:global(.admin-data-table) tbody tr.expired {
		background: color-mix(in srgb, var(--color-danger) 5%, transparent);
	}

	.form-section {
		margin-bottom: 1.25rem;
	}

	.form-section h3 {
		margin: 0 0 0.75rem;
		color: var(--color-text);
		font-size: 0.95rem;
		font-weight: 700;
	}

	.dialog-field {
		margin-bottom: 1rem;
	}

	.dialog-field :global(.admin-input) {
		width: 100%;
	}

	.tuple-preview {
		margin-block: 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-subtle);
		color: var(--color-text);
		font-family: var(--font-mono);
		padding: 0.75rem;
		overflow-wrap: anywhere;
	}

	.danger-copy {
		color: var(--color-danger);
		font-weight: 700;
	}
</style>

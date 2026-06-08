<script lang="ts">
	import { onMount } from 'svelte';
	import { adminReBACAPI, type RelationshipTuple, formatTupleString } from '$lib/api/admin-rebac';
	import { Modal, ToggleSwitch } from '$lib/components';
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

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<nav class="breadcrumb">
				<a href="/admin/rebac">ReBAC</a>
				<span>/</span>
				<span>{$LL.admin_rebac_relationship_tuples()}</span>
			</nav>
			<h1 class="page-title">{$LL.admin_rebac_relationship_tuples()}</h1>
			<p class="modal-description">
				{$LL.admin_rebac_tuples_description()}
			</p>
		</div>
		<button class="btn btn-primary" onclick={openCreateDialog}
			>+ {$LL.admin_rebac_tuples_create_tuple()}</button
		>
	</div>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadTuples}
				>{$LL.admin_rebac_retry()}</button
			>
		</div>
	{/if}

	<!-- Filters -->
	<div class="filter-bar">
		<input
			type="text"
			placeholder={$LL.admin_rebac_tuples_from_id_placeholder()}
			bind:value={filterFromId}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder={$LL.admin_rebac_tuples_to_type_placeholder()}
			bind:value={filterToType}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder={$LL.admin_rebac_tuples_to_id_placeholder()}
			bind:value={filterToId}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder={$LL.admin_rebac_tuples_relation_type_placeholder()}
			bind:value={filterRelationType}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<button class="btn-filter" onclick={applyFilters}>{$LL.admin_rebac_tuples_apply()}</button>
		<button class="btn-clear" onclick={clearFilters}>{$LL.admin_rebac_tuples_clear()}</button>
	</div>

	<!-- Tuples Table -->
	{#if loading}
		<div class="loading-state">{$LL.admin_rebac_loading()}</div>
	{:else if tuples.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_rebac_tuples_empty()}</p>
			<button class="btn btn-primary" onclick={openCreateDialog}
				>{$LL.admin_rebac_tuples_create_tuple()}</button
			>
		</div>
	{:else}
		<div class="table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_rebac_tuples_subject()}</th>
						<th>{$LL.admin_rebac_relation()}</th>
						<th>{$LL.admin_rebac_object()}</th>
						<th>{$LL.admin_rebac_tuples_permission()}</th>
						<th>{$LL.admin_rebac_tuples_expires()}</th>
						<th>{$LL.admin_rebac_tuples_created()}</th>
						<th>{$LL.admin_rebac_tuples_actions()}</th>
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
							<td>
								<div class="table-actions">
									<button
										class="btn btn-ghost btn-sm text-danger"
										onclick={(e) => openDeleteDialog(tuple, e)}
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
	title={$LL.admin_rebac_tuples_create_title()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="form-section">
		<h3>{$LL.admin_rebac_tuples_subject_from()}</h3>
		<div class="form-row">
			<div class="form-group">
				<label for="from-type" class="form-label">{$LL.admin_rebac_tuples_type()}</label>
				<select id="from-type" class="form-select" bind:value={createForm.from_type}>
					<option value="subject">subject</option>
					<option value="group">group</option>
					<option value="org">org</option>
				</select>
			</div>
			<div class="form-group flex-1">
				<label for="from-id" class="form-label">{$LL.admin_rebac_tuples_id()}</label>
				<input
					id="from-id"
					type="text"
					class="form-input"
					bind:value={createForm.from_id}
					placeholder="user_123"
				/>
			</div>
		</div>
	</div>

	<div class="form-section">
		<h3>{$LL.admin_rebac_relation()}</h3>
		<div class="form-group">
			<label for="relation-type" class="form-label"
				>{$LL.admin_rebac_tuples_relationship_type()}</label
			>
			<input
				id="relation-type"
				type="text"
				class="form-input"
				bind:value={createForm.relationship_type}
				placeholder="viewer, editor, owner..."
			/>
		</div>
	</div>

	<div class="form-section">
		<h3>{$LL.admin_rebac_tuples_object_to()}</h3>
		<div class="form-row">
			<div class="form-group">
				<label for="to-type" class="form-label">{$LL.admin_rebac_tuples_type()}</label>
				<input
					id="to-type"
					type="text"
					class="form-input"
					bind:value={createForm.to_type}
					placeholder="document"
				/>
			</div>
			<div class="form-group flex-1">
				<label for="to-id" class="form-label">{$LL.admin_rebac_tuples_id()}</label>
				<input
					id="to-id"
					type="text"
					class="form-input"
					bind:value={createForm.to_id}
					placeholder="doc_456"
				/>
			</div>
		</div>
	</div>

	<div class="form-section">
		<h3>{$LL.admin_rebac_tuples_options()}</h3>
		<div class="form-group">
			<label for="permission-level" class="form-label"
				>{$LL.admin_rebac_tuples_permission_level()}</label
			>
			<select id="permission-level" class="form-select" bind:value={createForm.permission_level}>
				<option value="full">{$LL.admin_rebac_tuples_permission_full()}</option>
				<option value="limited">{$LL.admin_rebac_tuples_permission_limited()}</option>
				<option value="read_only">{$LL.admin_rebac_tuples_permission_read_only()}</option>
			</select>
		</div>

		<div class="form-group">
			<ToggleSwitch
				bind:checked={createForm.has_expiry}
				label={$LL.admin_rebac_tuples_set_expiration()}
				description={$LL.admin_rebac_tuples_set_expiration_description()}
			/>
		</div>

		{#if createForm.has_expiry}
			<div class="form-group">
				<label for="expires-at" class="form-label">{$LL.admin_rebac_tuples_expires_at()}</label>
				<input
					id="expires-at"
					type="datetime-local"
					class="form-input"
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

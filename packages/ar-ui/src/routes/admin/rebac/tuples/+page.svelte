<script lang="ts">
	import { onMount } from 'svelte';
	import { adminReBACAPI, type RelationshipTuple, formatTupleString } from '$lib/api/admin-rebac';
	import { ToggleSwitch } from '$lib/components';

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
			console.error('Failed to load relationship tuples:', err);
			error = err instanceof Error ? err.message : 'Failed to load relationship tuples';
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
			createError = 'All required fields must be filled';
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
			console.error('Failed to create relationship tuple:', err);
			createError = err instanceof Error ? err.message : 'Failed to create relationship tuple';
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
			console.error('Failed to delete relationship tuple:', err);
			deleteError = err instanceof Error ? err.message : 'Failed to delete relationship tuple';
		} finally {
			deleting = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
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

	onMount(() => {
		loadTuples();
	});
</script>

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<nav class="breadcrumb">
				<a href="/admin/rebac">ReBAC</a>
				<span>/</span>
				<span>Relationship Tuples</span>
			</nav>
			<h1 class="page-title">Relationship Tuples</h1>
			<p class="modal-description">
				Manage user-relation-object assignments (Zanzibar notation: object#relation@user).
			</p>
		</div>
		<button class="btn btn-primary" onclick={openCreateDialog}>+ Create Tuple</button>
	</div>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadTuples}>Retry</button>
		</div>
	{/if}

	<!-- Filters -->
	<div class="filter-bar">
		<input
			type="text"
			placeholder="From ID (user)"
			bind:value={filterFromId}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder="To Type (object type)"
			bind:value={filterToType}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder="To ID (object ID)"
			bind:value={filterToId}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<input
			type="text"
			placeholder="Relation Type"
			bind:value={filterRelationType}
			onkeydown={(e) => e.key === 'Enter' && applyFilters()}
		/>
		<button class="btn-filter" onclick={applyFilters}>Apply</button>
		<button class="btn-clear" onclick={clearFilters}>Clear</button>
	</div>

	<!-- Tuples Table -->
	{#if loading}
		<div class="loading-state">Loading...</div>
	{:else if tuples.length === 0}
		<div class="empty-state">
			<p>No relationship tuples found.</p>
			<button class="btn btn-primary" onclick={openCreateDialog}>Create Tuple</button>
		</div>
	{:else}
		<div class="table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Subject</th>
						<th>Relation</th>
						<th>Object</th>
						<th>Permission</th>
						<th>Expires</th>
						<th>Created</th>
						<th>Actions</th>
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
									<span class="no-expiry">Never</span>
								{/if}
							</td>
							<td>{formatDate(tuple.created_at)}</td>
							<td>
								<div class="table-actions">
									<button
										class="btn btn-ghost btn-sm text-danger"
										onclick={(e) => openDeleteDialog(tuple, e)}
									>
										Delete
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
		<div
			class="modal-content modal-lg"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title">Create Relationship Tuple</h2>
			</div>
			<div class="modal-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-section">
					<h3>Subject (From)</h3>
					<div class="form-row">
						<div class="form-group">
							<label for="from-type" class="form-label">Type</label>
							<select id="from-type" class="form-select" bind:value={createForm.from_type}>
								<option value="subject">subject</option>
								<option value="group">group</option>
								<option value="org">org</option>
							</select>
						</div>
						<div class="form-group flex-1">
							<label for="from-id" class="form-label">ID</label>
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
					<h3>Relation</h3>
					<div class="form-group">
						<label for="relation-type" class="form-label">Relationship Type</label>
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
					<h3>Object (To)</h3>
					<div class="form-row">
						<div class="form-group">
							<label for="to-type" class="form-label">Type</label>
							<input
								id="to-type"
								type="text"
								class="form-input"
								bind:value={createForm.to_type}
								placeholder="document"
							/>
						</div>
						<div class="form-group flex-1">
							<label for="to-id" class="form-label">ID</label>
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
					<h3>Options</h3>
					<div class="form-group">
						<label for="permission-level" class="form-label">Permission Level</label>
						<select
							id="permission-level"
							class="form-select"
							bind:value={createForm.permission_level}
						>
							<option value="full">Full</option>
							<option value="limited">Limited</option>
							<option value="read_only">Read Only</option>
						</select>
					</div>

					<div class="form-group">
						<ToggleSwitch
							bind:checked={createForm.has_expiry}
							label="Set expiration"
							description="Set an expiration date for this relationship"
						/>
					</div>

					{#if createForm.has_expiry}
						<div class="form-group">
							<label for="expires-at" class="form-label">Expires At</label>
							<input
								id="expires-at"
								type="datetime-local"
								class="form-input"
								bind:value={createForm.expires_at}
							/>
						</div>
					{/if}
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
{#if showDeleteDialog && tupleToDelete}
	<div class="modal-overlay" onclick={() => (showDeleteDialog = false)} role="presentation">
		<div
			class="modal-content modal-sm"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title">Delete Relationship Tuple</h2>
			</div>
			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p>Are you sure you want to delete this relationship tuple?</p>
				<div class="tuple-preview">
					{formatTupleString(tupleToDelete)}
				</div>
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

<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminRebacAPI } from '$lib/api/admin-admin-rebac';
	import type {
		AdminRelationship,
		AdminRelationshipCreateInput,
		AdminRebacDefinition
	} from '$lib/api/admin-admin-rebac';

	let relationships: AdminRelationship[] = [];
	let definitions: AdminRebacDefinition[] = [];
	let loading = true;
	let error = '';
	let searchQuery = '';
	let filterType = '';

	// Create dialog state
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

	// Delete confirmation state
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
			error = err instanceof Error ? err.message : 'Failed to load data';
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
		createLoading = true;
		createError = '';
		try {
			await adminAdminRebacAPI.createRelationship(createForm);
			showCreateDialog = false;
			await loadData();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create relationship';
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
			deleteError = err instanceof Error ? err.message : 'Failed to delete relationship';
		} finally {
			deleteLoading = false;
		}
	}

	function closeOnBackdropKeydown(event: KeyboardEvent, close: () => void) {
		if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			close();
		}
	}

	onMount(() => {
		loadData();
	});

	$: filteredRelationships = relationships.filter((r) => {
		const matchesSearch =
			!searchQuery ||
			r.from_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
			r.to_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
			r.relationship_type.toLowerCase().includes(searchQuery.toLowerCase());

		const matchesType = !filterType || r.relationship_type === filterType;

		return matchesSearch && matchesType;
	});
</script>

<div class="container mx-auto px-4 py-8">
	<!-- Breadcrumb -->
	<nav class="mb-4 text-sm">
		<a href="/admin/admin-rebac" class="text-blue-600 hover:text-blue-700">Admin ReBAC</a>
		<span class="mx-2 text-gray-400">/</span>
		<span class="text-gray-600">Tuples</span>
	</nav>

	<!-- Header -->
	<div class="flex items-center justify-between mb-6">
		<div>
			<h1 class="text-3xl font-bold mb-2">Relationship Tuples</h1>
			<p class="text-gray-600">Manage relationship instances between Admin users</p>
		</div>
		<button
			on:click={openCreateDialog}
			class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center"
		>
			<span class="i-ph-plus mr-2"></span>
			Create Relationship
		</button>
	</div>

	<!-- Error Message -->
	{#if error}
		<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
			{error}
		</div>
	{/if}

	<!-- Filter Bar -->
	<div class="mb-6 flex gap-4">
		<div class="flex-1 relative">
			<span class="absolute left-3 top-3 i-ph-magnifying-glass text-gray-400"></span>
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search by user ID or relationship type..."
				class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
			/>
		</div>
		<select
			bind:value={filterType}
			class="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
		>
			<option value="">All Types</option>
			{#each definitions as definition (definition.id)}
				<option value={definition.relation_name}>{definition.relation_name}</option>
			{/each}
		</select>
	</div>

	<!-- Loading State -->
	{#if loading}
		<div class="flex justify-center py-12">
			<div class="text-gray-500">Loading relationships...</div>
		</div>
	{:else if filteredRelationships.length === 0}
		<div class="bg-white border border-gray-200 rounded-lg p-12 text-center">
			<div class="text-gray-400 text-5xl mb-4 i-ph-link"></div>
			<h3 class="text-xl font-semibold mb-2">No relationships found</h3>
			<p class="text-gray-600 mb-4">
				{searchQuery || filterType
					? 'Try adjusting your filters'
					: 'Get started by creating a relationship'}
			</p>
			{#if !searchQuery && !filterType}
				<button
					on:click={openCreateDialog}
					class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
				>
					Create Relationship
				</button>
			{/if}
		</div>
	{:else}
		<!-- Relationships Table -->
		<div class="bg-white border border-gray-200 rounded-lg overflow-hidden">
			<table class="min-w-full divide-y divide-gray-200">
				<thead class="bg-gray-50">
					<tr>
						<th
							class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
						>
							From
						</th>
						<th
							class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
						>
							Relationship
						</th>
						<th
							class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
						>
							To
						</th>
						<th
							class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
						>
							Details
						</th>
						<th
							class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
						>
							Actions
						</th>
					</tr>
				</thead>
				<tbody class="bg-white divide-y divide-gray-200">
					{#each filteredRelationships as relationship (relationship.id)}
						<tr class="hover:bg-gray-50">
							<td class="px-6 py-4 whitespace-nowrap">
								<div class="text-sm font-mono text-blue-600">{relationship.from_id}</div>
								{#if relationship.from_type}
									<div class="text-xs text-gray-500">{relationship.from_type}</div>
								{/if}
							</td>
							<td class="px-6 py-4 whitespace-nowrap">
								<div class="text-sm font-medium text-gray-900">
									{relationship.relationship_type}
								</div>
							</td>
							<td class="px-6 py-4 whitespace-nowrap">
								<div class="text-sm font-mono text-purple-600">{relationship.to_id}</div>
								{#if relationship.to_type}
									<div class="text-xs text-gray-500">{relationship.to_type}</div>
								{/if}
							</td>
							<td class="px-6 py-4">
								<div class="flex flex-wrap gap-1">
									{#if relationship.permission_level}
										<span class="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded-full">
											{relationship.permission_level}
										</span>
									{/if}
									{#if relationship.is_transitive}
										<span class="px-2 py-1 text-xs bg-purple-50 text-purple-700 rounded-full">
											Transitive
										</span>
									{/if}
									{#if relationship.is_bidirectional}
										<span class="px-2 py-1 text-xs bg-green-50 text-green-700 rounded-full">
											Bidirectional
										</span>
									{/if}
									{#if relationship.expires_at}
										<span class="px-2 py-1 text-xs bg-orange-50 text-orange-700 rounded-full">
											Expires
										</span>
									{/if}
								</div>
							</td>
							<td class="px-6 py-4 whitespace-nowrap text-right">
								<button
									on:click={() => openDeleteDialog(relationship)}
									class="text-red-600 hover:text-red-700 transition-colors"
									title="Delete"
								>
									<span class="i-ph-trash text-lg"></span>
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Results Count -->
		<div class="mt-4 text-sm text-gray-600">
			Showing {filteredRelationships.length} of {relationships.length} relationships
		</div>
	{/if}
</div>

<!-- Create Dialog -->
{#if showCreateDialog}
	<div
		class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		aria-label="Close create relationship dialog"
		on:click|self={() => (showCreateDialog = false)}
		on:keydown={(event) => closeOnBackdropKeydown(event, () => (showCreateDialog = false))}
	>
		<div
			class="bg-white rounded-lg max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto"
			role="dialog"
			aria-modal="true"
		>
			<h2 class="text-xl font-semibold mb-4">Create Relationship</h2>

			{#if createError}
				<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
					{createError}
				</div>
			{/if}

			<form on:submit|preventDefault={handleCreate}>
				<div class="space-y-4">
					<div>
						<label for="relationship_type" class="block text-sm font-medium text-gray-700 mb-1">
							Relationship Type <span class="text-red-500">*</span>
						</label>
						<select
							id="relationship_type"
							bind:value={createForm.relationship_type}
							required
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						>
							{#each definitions as definition (definition.id)}
								<option value={definition.relation_name}>
									{definition.relation_name}
									{#if definition.display_name}
										- {definition.display_name}
									{/if}
								</option>
							{/each}
						</select>
					</div>

					<div class="grid grid-cols-2 gap-4">
						<div>
							<label for="from_id" class="block text-sm font-medium text-gray-700 mb-1">
								From (Subject) <span class="text-red-500">*</span>
							</label>
							<input
								id="from_id"
								type="text"
								bind:value={createForm.from_id}
								required
								placeholder="admin_user_id"
								class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
							/>
						</div>

						<div>
							<label for="to_id" class="block text-sm font-medium text-gray-700 mb-1">
								To (Object) <span class="text-red-500">*</span>
							</label>
							<input
								id="to_id"
								type="text"
								bind:value={createForm.to_id}
								required
								placeholder="admin_user_id"
								class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
							/>
						</div>
					</div>

					<div class="grid grid-cols-2 gap-4">
						<div>
							<label for="from_type" class="block text-sm font-medium text-gray-700 mb-1">
								From Type
							</label>
							<input
								id="from_type"
								type="text"
								bind:value={createForm.from_type}
								placeholder="admin_user"
								class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
							/>
						</div>

						<div>
							<label for="to_type" class="block text-sm font-medium text-gray-700 mb-1">
								To Type
							</label>
							<input
								id="to_type"
								type="text"
								bind:value={createForm.to_type}
								placeholder="admin_user"
								class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
							/>
						</div>
					</div>

					<div>
						<label for="permission_level" class="block text-sm font-medium text-gray-700 mb-1">
							Permission Level
						</label>
						<select
							id="permission_level"
							bind:value={createForm.permission_level}
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						>
							<option value={undefined}>None</option>
							<option value="full">Full</option>
							<option value="limited">Limited</option>
							<option value="read_only">Read Only</option>
						</select>
					</div>

					<div class="space-y-2">
						<label class="flex items-center">
							<input
								type="checkbox"
								bind:checked={createForm.is_transitive}
								class="mr-2 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
							/>
							<span class="text-sm text-gray-700">Transitive (inherited through chains)</span>
						</label>

						<label class="flex items-center">
							<input
								type="checkbox"
								bind:checked={createForm.is_bidirectional}
								class="mr-2 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
							/>
							<span class="text-sm text-gray-700">Bidirectional (works both ways)</span>
						</label>
					</div>
				</div>

				<div class="mt-6 flex justify-end space-x-3">
					<button
						type="button"
						on:click={() => (showCreateDialog = false)}
						disabled={createLoading}
						class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={createLoading ||
							!createForm.relationship_type ||
							!createForm.from_id ||
							!createForm.to_id}
						class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
					>
						{createLoading ? 'Creating...' : 'Create'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && deletingRelationship}
	<div
		class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		aria-label="Close delete relationship dialog"
		on:click|self={() => (showDeleteDialog = false)}
		on:keydown={(event) => closeOnBackdropKeydown(event, () => (showDeleteDialog = false))}
	>
		<div class="bg-white rounded-lg max-w-md w-full p-6" role="dialog" aria-modal="true">
			<h2 class="text-xl font-semibold mb-4">Delete Relationship</h2>

			{#if deleteError}
				<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
					{deleteError}
				</div>
			{/if}

			<p class="text-gray-700 mb-4">Are you sure you want to delete this relationship?</p>
			<div class="bg-gray-50 p-4 rounded-lg mb-4 font-mono text-sm">
				<div class="text-blue-600">{deletingRelationship.from_id}</div>
				<div class="text-gray-500 my-1">{deletingRelationship.relationship_type}</div>
				<div class="text-purple-600">{deletingRelationship.to_id}</div>
			</div>

			<div class="flex justify-end space-x-3">
				<button
					on:click={() => (showDeleteDialog = false)}
					disabled={deleteLoading}
					class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					on:click={handleDelete}
					disabled={deleteLoading}
					class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
				>
					{deleteLoading ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

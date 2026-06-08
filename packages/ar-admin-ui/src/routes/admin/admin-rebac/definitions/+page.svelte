<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminRebacAPI } from '$lib/api/admin-admin-rebac';
	import type {
		AdminRebacDefinition,
		AdminRebacDefinitionCreateInput,
		AdminRebacDefinitionUpdateInput
	} from '$lib/api/admin-admin-rebac';
	import { LL } from '$i18n/i18n-svelte';

	let definitions: AdminRebacDefinition[] = [];
	let loading = true;
	let error = '';
	let searchQuery = '';

	// Create dialog state
	let showCreateDialog = false;
	let createForm: AdminRebacDefinitionCreateInput = {
		relation_name: '',
		display_name: '',
		description: '',
		priority: 0
	};
	let createLoading = false;
	let createError = '';

	// Edit dialog state
	let showEditDialog = false;
	let editingDefinition: AdminRebacDefinition | null = null;
	let editForm: AdminRebacDefinitionUpdateInput = {};
	let editLoading = false;
	let editError = '';

	// Delete confirmation state
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

	function closeOnBackdropKeydown(event: KeyboardEvent, close: () => void) {
		if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			close();
		}
	}

	onMount(() => {
		loadDefinitions();
	});

	$: filteredDefinitions = definitions.filter(
		(d) =>
			d.relation_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			d.display_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
			d.description?.toLowerCase().includes(searchQuery.toLowerCase())
	);
</script>

<svelte:head>
	<title>{$LL.admin_admin_rebac_definitions_head_title()}</title>
</svelte:head>

<div class="container mx-auto px-4 py-8">
	<!-- Breadcrumb -->
	<nav class="mb-4 text-sm">
		<a href="/admin/admin-rebac" class="text-blue-600 hover:text-blue-700">
			{$LL.admin_admin_rebac_title()}
		</a>
		<span class="mx-2 text-gray-400">/</span>
		<span class="text-gray-600">{$LL.admin_admin_rebac_definitions_breadcrumb()}</span>
	</nav>

	<!-- Header -->
	<div class="flex items-center justify-between mb-6">
		<div>
			<h1 class="text-3xl font-bold mb-2">{$LL.admin_admin_rebac_definitions_title()}</h1>
			<p class="text-gray-600">{$LL.admin_admin_rebac_definitions_description()}</p>
		</div>
		<button
			on:click={openCreateDialog}
			class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center"
		>
			<span class="i-ph-plus mr-2"></span>
			{$LL.admin_admin_rebac_create_definition()}
		</button>
	</div>

	<!-- Error Message -->
	{#if error}
		<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
			{error}
		</div>
	{/if}

	<!-- Search Bar -->
	<div class="mb-6">
		<div class="relative">
			<span class="absolute left-3 top-3 i-ph-magnifying-glass text-gray-400"></span>
			<input
				type="text"
				bind:value={searchQuery}
				placeholder={$LL.admin_admin_rebac_search_definitions_placeholder()}
				class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
			/>
		</div>
	</div>

	<!-- Loading State -->
	{#if loading}
		<div class="flex justify-center py-12">
			<div class="text-gray-500">{$LL.admin_admin_rebac_loading_definitions()}</div>
		</div>
	{:else if filteredDefinitions.length === 0}
		<div class="bg-white border border-gray-200 rounded-lg p-12 text-center">
			<div class="text-gray-400 text-5xl mb-4 i-ph-arrows-split"></div>
			<h3 class="text-xl font-semibold mb-2">
				{$LL.admin_admin_rebac_no_definitions_found()}
			</h3>
			<p class="text-gray-600 mb-4">
				{searchQuery
					? $LL.admin_admin_rebac_try_adjusting_search()
					: $LL.admin_admin_rebac_create_definition_empty()}
			</p>
			{#if !searchQuery}
				<button
					on:click={openCreateDialog}
					class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
				>
					{$LL.admin_admin_rebac_create_definition()}
				</button>
			{/if}
		</div>
	{:else}
		<!-- Definitions Grid -->
		<div class="grid grid-cols-1 gap-4">
			{#each filteredDefinitions as definition (definition.id)}
				<div
					class="bg-white border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
				>
					<div class="flex items-start justify-between">
						<div class="flex-1">
							<div class="flex items-center space-x-3 mb-2">
								<h3 class="text-lg font-semibold font-mono">{definition.relation_name}</h3>
								{#if definition.is_system}
									<span
										class="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded-full font-medium"
									>
										{$LL.admin_admin_rebac_system()}
									</span>
								{/if}
							</div>
							{#if definition.display_name}
								<p class="text-gray-900 mb-1">{definition.display_name}</p>
							{/if}
							{#if definition.description}
								<p class="text-gray-600 text-sm mb-3">{definition.description}</p>
							{/if}
							<div class="flex items-center space-x-4 text-sm text-gray-500">
								<span>{$LL.admin_admin_rebac_priority({ priority: definition.priority })}</span>
								<span>{$LL.admin_admin_rebac_tenant({ tenant: definition.tenant_id })}</span>
							</div>
						</div>
						<div class="flex items-center space-x-2 ml-4">
							{#if !definition.is_system}
								<button
									on:click={() => openEditDialog(definition)}
									class="p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors"
									title={$LL.admin_admin_rebac_edit()}
								>
									<span class="i-ph-pencil text-lg"></span>
								</button>
								<button
									on:click={() => openDeleteDialog(definition)}
									class="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
									title={$LL.admin_admin_rebac_delete()}
								>
									<span class="i-ph-trash text-lg"></span>
								</button>
							{:else}
								<span class="text-xs text-gray-500 italic">
									{$LL.admin_admin_rebac_system_protected()}
								</span>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Create Dialog -->
{#if showCreateDialog}
	<div
		class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		aria-label={$LL.admin_admin_rebac_close_create_definition_dialog()}
		on:click|self={() => (showCreateDialog = false)}
		on:keydown={(event) => closeOnBackdropKeydown(event, () => (showCreateDialog = false))}
	>
		<div class="bg-white rounded-lg max-w-md w-full p-6" role="dialog" aria-modal="true">
			<h2 class="text-xl font-semibold mb-4">
				{$LL.admin_admin_rebac_create_relationship_definition()}
			</h2>

			{#if createError}
				<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
					{createError}
				</div>
			{/if}

			<form on:submit|preventDefault={handleCreate}>
				<div class="space-y-4">
					<div>
						<label for="relation_name" class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_relation_name()} <span class="text-red-500">*</span>
						</label>
						<input
							id="relation_name"
							type="text"
							bind:value={createForm.relation_name}
							required
							placeholder="admin_supervises"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
						/>
						<p class="text-xs text-gray-500 mt-1">
							{$LL.admin_admin_rebac_relation_name_help()}
						</p>
					</div>

					<div>
						<label for="display_name" class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_display_name()}
						</label>
						<input
							id="display_name"
							type="text"
							bind:value={createForm.display_name}
							placeholder={$LL.admin_admin_rebac_display_name_placeholder()}
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
					</div>

					<div>
						<label for="description" class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_description_label()}
						</label>
						<textarea
							id="description"
							bind:value={createForm.description}
							placeholder={$LL.admin_admin_rebac_description_placeholder()}
							rows="3"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						></textarea>
					</div>

					<div>
						<label for="priority" class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_priority_label()}
						</label>
						<input
							id="priority"
							type="number"
							bind:value={createForm.priority}
							placeholder="0"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
						<p class="text-xs text-gray-500 mt-1">
							{$LL.admin_admin_rebac_priority_help()}
						</p>
					</div>
				</div>

				<div class="mt-6 flex justify-end space-x-3">
					<button
						type="button"
						on:click={() => (showCreateDialog = false)}
						disabled={createLoading}
						class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
					>
						{$LL.admin_admin_rebac_cancel()}
					</button>
					<button
						type="submit"
						disabled={createLoading || !createForm.relation_name}
						class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
					>
						{createLoading ? $LL.admin_admin_rebac_creating() : $LL.admin_admin_rebac_create()}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Edit Dialog -->
{#if showEditDialog && editingDefinition}
	<div
		class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		aria-label={$LL.admin_admin_rebac_close_edit_definition_dialog()}
		on:click|self={() => (showEditDialog = false)}
		on:keydown={(event) => closeOnBackdropKeydown(event, () => (showEditDialog = false))}
	>
		<div class="bg-white rounded-lg max-w-md w-full p-6" role="dialog" aria-modal="true">
			<h2 class="text-xl font-semibold mb-4">
				{$LL.admin_admin_rebac_edit_relationship_definition()}
			</h2>

			{#if editError}
				<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
					{editError}
				</div>
			{/if}

			<form on:submit|preventDefault={handleEdit}>
				<div class="space-y-4">
					<div>
						<p class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_relation_name()}
						</p>
						<div class="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg font-mono text-sm">
							{editingDefinition.relation_name}
						</div>
						<p class="text-xs text-gray-500 mt-1">
							{$LL.admin_admin_rebac_relation_name_readonly_help()}
						</p>
					</div>

					<div>
						<label for="edit_display_name" class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_display_name()}
						</label>
						<input
							id="edit_display_name"
							type="text"
							bind:value={editForm.display_name}
							placeholder={$LL.admin_admin_rebac_display_name_placeholder()}
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
					</div>

					<div>
						<label for="edit_description" class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_description_label()}
						</label>
						<textarea
							id="edit_description"
							bind:value={editForm.description}
							placeholder={$LL.admin_admin_rebac_description_placeholder()}
							rows="3"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						></textarea>
					</div>

					<div>
						<label for="edit_priority" class="block text-sm font-medium text-gray-700 mb-1">
							{$LL.admin_admin_rebac_priority_label()}
						</label>
						<input
							id="edit_priority"
							type="number"
							bind:value={editForm.priority}
							placeholder="0"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
					</div>
				</div>

				<div class="mt-6 flex justify-end space-x-3">
					<button
						type="button"
						on:click={() => (showEditDialog = false)}
						disabled={editLoading}
						class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
					>
						{$LL.admin_admin_rebac_cancel()}
					</button>
					<button
						type="submit"
						disabled={editLoading}
						class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
					>
						{editLoading ? $LL.admin_admin_rebac_saving() : $LL.admin_admin_rebac_save()}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && deletingDefinition}
	<div
		class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		aria-label={$LL.admin_admin_rebac_close_delete_definition_dialog()}
		on:click|self={() => (showDeleteDialog = false)}
		on:keydown={(event) => closeOnBackdropKeydown(event, () => (showDeleteDialog = false))}
	>
		<div class="bg-white rounded-lg max-w-md w-full p-6" role="dialog" aria-modal="true">
			<h2 class="text-xl font-semibold mb-4">
				{$LL.admin_admin_rebac_delete_relationship_definition()}
			</h2>

			{#if deleteError}
				<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
					{deleteError}
				</div>
			{/if}

			<p class="text-gray-700 mb-4">
				{$LL.admin_admin_rebac_delete_definition_confirm({
					name: deletingDefinition.relation_name
				})}
			</p>
			<p class="text-sm text-red-600 mb-4">
				{$LL.admin_admin_rebac_delete_definition_warning()}
			</p>

			<div class="flex justify-end space-x-3">
				<button
					on:click={() => (showDeleteDialog = false)}
					disabled={deleteLoading}
					class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
				>
					{$LL.admin_admin_rebac_cancel()}
				</button>
				<button
					on:click={handleDelete}
					disabled={deleteLoading}
					class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
				>
					{deleteLoading ? $LL.admin_admin_rebac_deleting() : $LL.admin_admin_rebac_delete()}
				</button>
			</div>
		</div>
	</div>
{/if}

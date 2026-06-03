<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminPoliciesAPI } from '$lib/api/admin-admin-policies';
	import type {
		AdminPolicy,
		AdminPolicyCreateInput,
		AdminPolicyUpdateInput,
		PolicySimulationInput,
		PolicySimulationResult
	} from '$lib/api/admin-admin-policies';

	let policies: AdminPolicy[] = [];
	let loading = true;
	let error = '';
	let searchQuery = '';
	let filterActive: 'all' | 'active' | 'inactive' = 'all';

	// Create dialog state
	let showCreateDialog = false;
	let createForm: AdminPolicyCreateInput = {
		name: '',
		display_name: '',
		description: '',
		effect: 'allow',
		priority: 0,
		resource_pattern: '',
		actions: ['*'],
		conditions: { condition_type: 'all' }
	};
	let createLoading = false;
	let createError = '';

	// Edit dialog state (unused, kept for future implementation)
	let _showEditDialog = false;
	let editingPolicy: AdminPolicy | null = null;
	let editForm: AdminPolicyUpdateInput = {};
	let _editLoading = false;
	let _editError = '';

	// Delete confirmation state (unused, kept for future implementation)
	let _showDeleteDialog = false;
	let deletingPolicy: AdminPolicy | null = null;
	let _deleteLoading = false;
	let _deleteError = '';

	// Simulation dialog state
	let showSimulationDialog = false;
	let simulationForm: PolicySimulationInput = {
		resource: '',
		action: '',
		admin_user_context: {
			roles: [],
			attributes: {},
			relationships: []
		}
	};
	let simulationResult: PolicySimulationResult | null = null;
	let simulationLoading = false;
	let simulationError = '';

	async function loadPolicies() {
		loading = true;
		error = '';
		try {
			const response = await adminAdminPoliciesAPI.listPolicies({
				active_only: filterActive === 'active'
			});
			policies = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load policies';
		} finally {
			loading = false;
		}
	}

	function openCreateDialog() {
		createForm = {
			name: '',
			display_name: '',
			description: '',
			effect: 'allow',
			priority: 0,
			resource_pattern: '',
			actions: ['*'],
			conditions: { condition_type: 'all' }
		};
		createError = '';
		showCreateDialog = true;
	}

	async function handleCreate() {
		createLoading = true;
		createError = '';
		try {
			await adminAdminPoliciesAPI.createPolicy(createForm);
			showCreateDialog = false;
			await loadPolicies();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create policy';
		} finally {
			createLoading = false;
		}
	}

	function openEditDialog(policy: AdminPolicy) {
		editingPolicy = policy;
		editForm = {
			display_name: policy.display_name || '',
			description: policy.description || '',
			effect: policy.effect,
			priority: policy.priority,
			resource_pattern: policy.resource_pattern,
			actions: policy.actions,
			conditions: policy.conditions
		};
		_editError = '';
		_showEditDialog = true;
	}

	async function _handleEdit() {
		if (!editingPolicy) return;

		_editLoading = true;
		_editError = '';
		try {
			await adminAdminPoliciesAPI.updatePolicy(editingPolicy.id, editForm);
			_showEditDialog = false;
			await loadPolicies();
		} catch (err) {
			_editError = err instanceof Error ? err.message : 'Failed to update policy';
		} finally {
			_editLoading = false;
		}
	}

	async function toggleActive(policy: AdminPolicy) {
		try {
			if (policy.is_active) {
				await adminAdminPoliciesAPI.deactivatePolicy(policy.id);
			} else {
				await adminAdminPoliciesAPI.activatePolicy(policy.id);
			}
			await loadPolicies();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to toggle policy status';
		}
	}

	function openDeleteDialog(policy: AdminPolicy) {
		deletingPolicy = policy;
		_deleteError = '';
		_showDeleteDialog = true;
	}

	async function _handleDelete() {
		if (!deletingPolicy) return;

		_deleteLoading = true;
		_deleteError = '';
		try {
			await adminAdminPoliciesAPI.deletePolicy(deletingPolicy.id);
			_showDeleteDialog = false;
			await loadPolicies();
		} catch (err) {
			_deleteError = err instanceof Error ? err.message : 'Failed to delete policy';
		} finally {
			_deleteLoading = false;
		}
	}

	function openSimulationDialog() {
		simulationForm = {
			resource: 'admin:admin_users:read',
			action: 'read',
			admin_user_context: {
				roles: ['admin'],
				attributes: {},
				relationships: []
			}
		};
		simulationResult = null;
		simulationError = '';
		showSimulationDialog = true;
	}

	async function handleSimulation() {
		simulationLoading = true;
		simulationError = '';
		try {
			simulationResult = await adminAdminPoliciesAPI.simulatePolicy(simulationForm);
		} catch (err) {
			simulationError = err instanceof Error ? err.message : 'Failed to simulate policy';
		} finally {
			simulationLoading = false;
		}
	}

	function closeOnBackdropKeydown(event: KeyboardEvent, close: () => void) {
		if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			close();
		}
	}

	onMount(() => {
		loadPolicies();
	});

	$: filteredPolicies = policies.filter((p) => {
		const matchesSearch =
			!searchQuery ||
			p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			p.display_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
			p.resource_pattern.toLowerCase().includes(searchQuery.toLowerCase());

		const matchesFilter =
			filterActive === 'all' ||
			(filterActive === 'active' && p.is_active) ||
			(filterActive === 'inactive' && !p.is_active);

		return matchesSearch && matchesFilter;
	});
</script>

<div class="container mx-auto px-4 py-8">
	<!-- Breadcrumb -->
	<nav class="mb-4 text-sm">
		<a
			href="/admin/admin-access-control"
			class="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
			>Admin Access Control</a
		>
		<span class="mx-2 text-gray-400 dark:text-gray-500">/</span>
		<span class="text-gray-600 dark:text-gray-400">Policies</span>
	</nav>

	<!-- Header -->
	<div class="flex items-center justify-between mb-6">
		<div>
			<h1 class="text-3xl font-bold mb-2 dark:text-white">Admin Policies</h1>
			<p class="text-gray-600 dark:text-gray-400">
				Combined RBAC/ABAC/ReBAC access control policies
			</p>
		</div>
		<div class="flex space-x-3">
			<button
				on:click={openSimulationDialog}
				class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center"
			>
				<span class="i-ph-flask mr-2"></span>
				Simulate
			</button>
			<button
				on:click={openCreateDialog}
				class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center"
			>
				<span class="i-ph-plus mr-2"></span>
				Create Policy
			</button>
		</div>
	</div>

	<!-- Error Message -->
	{#if error}
		<div
			class="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded"
		>
			{error}
		</div>
	{/if}

	<!-- Filter Bar -->
	<div class="mb-6 flex gap-4">
		<div class="flex-1 relative">
			<span class="absolute left-3 top-3 i-ph-magnifying-glass text-gray-400 dark:text-gray-500"
			></span>
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search policies..."
				class="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
			/>
		</div>
		<div class="flex space-x-2">
			<button
				on:click={() => (filterActive = 'all')}
				class={`px-4 py-2 rounded-lg transition-colors ${filterActive === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
			>
				All
			</button>
			<button
				on:click={() => (filterActive = 'active')}
				class={`px-4 py-2 rounded-lg transition-colors ${filterActive === 'active' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
			>
				Active
			</button>
			<button
				on:click={() => (filterActive = 'inactive')}
				class={`px-4 py-2 rounded-lg transition-colors ${filterActive === 'inactive' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
			>
				Inactive
			</button>
		</div>
	</div>

	<!-- Loading State -->
	{#if loading}
		<div class="flex justify-center py-12">
			<div class="text-gray-500 dark:text-gray-400">Loading policies...</div>
		</div>
	{:else if filteredPolicies.length === 0}
		<div
			class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-12 text-center"
		>
			<div class="text-gray-400 dark:text-gray-500 text-5xl mb-4 i-ph-shield-check"></div>
			<h3 class="text-xl font-semibold mb-2 dark:text-white">No policies found</h3>
			<p class="text-gray-600 dark:text-gray-400 mb-4">
				{searchQuery || filterActive !== 'all'
					? 'Try adjusting your filters'
					: 'Get started by creating a policy'}
			</p>
			{#if !searchQuery && filterActive === 'all'}
				<button
					on:click={openCreateDialog}
					class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
				>
					Create Policy
				</button>
			{/if}
		</div>
	{:else}
		<!-- Policies Grid -->
		<div class="grid grid-cols-1 gap-4">
			{#each filteredPolicies as policy (policy.id)}
				<div
					class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 hover:shadow-md transition-shadow"
				>
					<div class="flex items-start justify-between">
						<div class="flex-1">
							<div class="flex items-center space-x-3 mb-2">
								<h3 class="text-lg font-semibold font-mono dark:text-white">{policy.name}</h3>
								{#if policy.is_system}
									<span
										class="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full font-medium"
									>
										System
									</span>
								{/if}
								<span
									class={`px-2 py-1 text-xs rounded-full font-medium ${policy.effect === 'allow' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}
								>
									{policy.effect.toUpperCase()}
								</span>
								<span
									class={`px-2 py-1 text-xs rounded-full font-medium ${policy.is_active ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}
								>
									{policy.is_active ? 'Active' : 'Inactive'}
								</span>
							</div>
							{#if policy.display_name}
								<p class="text-gray-900 dark:text-gray-100 mb-1">{policy.display_name}</p>
							{/if}
							{#if policy.description}
								<p class="text-gray-600 dark:text-gray-400 text-sm mb-3">{policy.description}</p>
							{/if}
							<div class="space-y-1 text-sm">
								<div class="flex items-center space-x-2">
									<span class="text-gray-500">Resource:</span>
									<span class="font-mono text-gray-900">{policy.resource_pattern}</span>
								</div>
								<div class="flex items-center space-x-2">
									<span class="text-gray-500">Actions:</span>
									<span class="font-mono text-gray-900">{policy.actions.join(', ')}</span>
								</div>
								<div class="flex items-center space-x-2">
									<span class="text-gray-500">Priority:</span>
									<span class="text-gray-900">{policy.priority}</span>
								</div>
							</div>
						</div>
						<div class="flex items-center space-x-2 ml-4">
							{#if !policy.is_system}
								<button
									on:click={() => toggleActive(policy)}
									class="p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors"
									title={policy.is_active ? 'Deactivate' : 'Activate'}
								>
									<span class={policy.is_active ? 'i-ph-toggle-right' : 'i-ph-toggle-left'}></span>
								</button>
								<button
									on:click={() => openEditDialog(policy)}
									class="p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors"
									title="Edit"
								>
									<span class="i-ph-pencil text-lg"></span>
								</button>
								<button
									on:click={() => openDeleteDialog(policy)}
									class="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
									title="Delete"
								>
									<span class="i-ph-trash text-lg"></span>
								</button>
							{:else}
								<span class="text-xs text-gray-500 italic">System-protected</span>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Create Dialog (simplified for space) -->
{#if showCreateDialog}
	<div
		class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		aria-label="Close create policy dialog"
		on:click|self={() => (showCreateDialog = false)}
		on:keydown={(event) => closeOnBackdropKeydown(event, () => (showCreateDialog = false))}
	>
		<div
			class="bg-white rounded-lg max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto"
			role="dialog"
			aria-modal="true"
		>
			<h2 class="text-xl font-semibold mb-4">Create Policy</h2>
			{#if createError}
				<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
					{createError}
				</div>
			{/if}
			<form on:submit|preventDefault={handleCreate}>
				<div class="space-y-4">
					<div>
						<label for="name" class="block text-sm font-medium text-gray-700 mb-1">
							Name <span class="text-red-500">*</span>
						</label>
						<input
							id="name"
							type="text"
							bind:value={createForm.name}
							required
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
					</div>
					<div>
						<label for="resource_pattern" class="block text-sm font-medium text-gray-700 mb-1">
							Resource Pattern <span class="text-red-500">*</span>
						</label>
						<input
							id="resource_pattern"
							type="text"
							bind:value={createForm.resource_pattern}
							required
							placeholder="admin:admin_users:*"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
					</div>
					<div>
						<label for="effect" class="block text-sm font-medium text-gray-700 mb-1">Effect</label>
						<select
							id="effect"
							bind:value={createForm.effect}
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						>
							<option value="allow">Allow</option>
							<option value="deny">Deny</option>
						</select>
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
						disabled={createLoading || !createForm.name || !createForm.resource_pattern}
						class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
					>
						{createLoading ? 'Creating...' : 'Create'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Simulation Dialog (simplified) -->
{#if showSimulationDialog}
	<div
		class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		aria-label="Close policy simulation dialog"
		on:click|self={() => (showSimulationDialog = false)}
		on:keydown={(event) => closeOnBackdropKeydown(event, () => (showSimulationDialog = false))}
	>
		<div
			class="bg-white rounded-lg max-w-3xl w-full p-6 max-h-[90vh] overflow-y-auto"
			role="dialog"
			aria-modal="true"
		>
			<h2 class="text-xl font-semibold mb-4">Policy Simulation</h2>
			<p class="text-sm text-gray-600 mb-4">Test policy evaluation with custom user context</p>
			{#if simulationError}
				<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
					{simulationError}
				</div>
			{/if}
			<div class="space-y-4 mb-6">
				<input
					type="text"
					bind:value={simulationForm.resource}
					placeholder="Resource (e.g., admin:admin_users:read)"
					class="w-full px-3 py-2 border border-gray-300 rounded-lg"
				/>
				<input
					type="text"
					bind:value={simulationForm.action}
					placeholder="Action (e.g., read)"
					class="w-full px-3 py-2 border border-gray-300 rounded-lg"
				/>
			</div>
			<button
				on:click={handleSimulation}
				disabled={simulationLoading}
				class="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 mb-4"
			>
				{simulationLoading ? 'Running...' : 'Run Simulation'}
			</button>
			{#if simulationResult}
				<div class="bg-gray-50 p-4 rounded-lg">
					<div class="flex items-center space-x-2 mb-3">
						<span class="font-semibold">Decision:</span>
						<span
							class={`px-3 py-1 rounded-full font-medium ${
								simulationResult.decision === 'allow'
									? 'bg-green-100 text-green-700'
									: simulationResult.decision === 'deny'
										? 'bg-red-100 text-red-700'
										: 'bg-gray-100 text-gray-700'
							}`}
						>
							{simulationResult.decision.toUpperCase()}
						</span>
					</div>
					<div class="text-sm text-gray-600">
						Evaluated {simulationResult.total_policies_evaluated} policies
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}

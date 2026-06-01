<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminRebacAPI } from '$lib/api/admin-admin-rebac';
	import type { AdminRebacDefinition, AdminRelationship } from '$lib/api/admin-admin-rebac';

	let definitions: AdminRebacDefinition[] = [];
	let relationships: AdminRelationship[] = [];
	let loading = true;
	let error = '';

	async function loadData() {
		loading = true;
		error = '';
		try {
			const [defsResponse, relsResponse] = await Promise.all([
				adminAdminRebacAPI.listDefinitions({ include_system: true, limit: 10 }),
				adminAdminRebacAPI.listRelationships({ limit: 10 })
			]);
			definitions = defsResponse.items;
			relationships = relsResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load data';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadData();
	});
</script>

<div class="container mx-auto px-4 py-8">
	<!-- Header -->
	<div class="mb-8">
		<h1 class="text-3xl font-bold mb-2 dark:text-white">Admin ReBAC</h1>
		<p class="text-gray-600 dark:text-gray-400">
			Relationship-Based Access Control for Admin Operators
		</p>
	</div>

	<!-- Error Message -->
	{#if error}
		<div
			class="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded"
		>
			{error}
		</div>
	{/if}

	<!-- Navigation Cards -->
	<div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
		<!-- Definitions Card -->
		<a
			href="/admin/admin-rebac/definitions"
			class="block p-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
		>
			<div class="flex items-start justify-between mb-4">
				<div class="flex items-center space-x-3">
					<div
						class="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center"
					>
						<span class="i-ph-arrows-split text-purple-600 dark:text-purple-400 text-2xl"></span>
					</div>
					<div>
						<h2 class="text-xl font-semibold dark:text-white">Relationship Definitions</h2>
						<p class="text-sm text-gray-600 dark:text-gray-400">Manage relationship types</p>
					</div>
				</div>
				<span class="i-ph-arrow-right text-gray-400 dark:text-gray-500 text-xl"></span>
			</div>
			{#if loading}
				<div class="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
			{:else}
				<div class="text-2xl font-bold text-purple-600 dark:text-purple-400">
					{definitions.length}
				</div>
				<div class="text-sm text-gray-600 dark:text-gray-400">Total definitions</div>
			{/if}
		</a>

		<!-- Tuples Card -->
		<a
			href="/admin/admin-rebac/tuples"
			class="block p-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
		>
			<div class="flex items-start justify-between mb-4">
				<div class="flex items-center space-x-3">
					<div
						class="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center"
					>
						<span class="i-ph-link text-blue-600 dark:text-blue-400 text-2xl"></span>
					</div>
					<div>
						<h2 class="text-xl font-semibold dark:text-white">Relationship Tuples</h2>
						<p class="text-sm text-gray-600 dark:text-gray-400">Manage relationship instances</p>
					</div>
				</div>
				<span class="i-ph-arrow-right text-gray-400 dark:text-gray-500 text-xl"></span>
			</div>
			{#if loading}
				<div class="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
			{:else}
				<div class="text-2xl font-bold text-blue-600 dark:text-blue-400">
					{relationships.length}
				</div>
				<div class="text-sm text-gray-600 dark:text-gray-400">Active relationships</div>
			{/if}
		</a>
	</div>

	<!-- Overview Section -->
	<div class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
		<h2 class="text-xl font-semibold mb-4 dark:text-white">What is ReBAC?</h2>
		<div class="space-y-4 text-gray-700 dark:text-gray-300">
			<p>
				ReBAC (Relationship-Based Access Control) allows you to define access control based on
				relationships between Admin users and resources.
			</p>
			<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
				<div class="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
					<h3 class="font-semibold mb-2 flex items-center dark:text-white">
						<span class="i-ph-arrows-split text-purple-600 dark:text-purple-400 mr-2"></span>
						Definitions
					</h3>
					<p class="text-sm text-gray-700 dark:text-gray-300">
						Define relationship types (e.g., admin_supervises, admin_team_member) that can be used
						to model organizational structures.
					</p>
				</div>
				<div class="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
					<h3 class="font-semibold mb-2 flex items-center dark:text-white">
						<span class="i-ph-link text-blue-600 dark:text-blue-400 mr-2"></span>
						Tuples
					</h3>
					<p class="text-sm text-gray-700 dark:text-gray-300">
						Create relationship instances (tuples) to establish connections between Admin users,
						such as "Alice supervises Bob".
					</p>
				</div>
			</div>
		</div>
	</div>

	<!-- Recent Definitions Preview -->
	{#if !loading && definitions.length > 0}
		<div
			class="mt-8 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6"
		>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-xl font-semibold dark:text-white">Recent Definitions</h2>
				<a
					href="/admin/admin-rebac/definitions"
					class="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 flex items-center"
				>
					View all
					<span class="i-ph-arrow-right ml-1"></span>
				</a>
			</div>
			<div class="space-y-2">
				{#each definitions.slice(0, 5) as definition (definition.id)}
					<div
						class="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700"
					>
						<div>
							<div class="font-mono text-sm text-gray-900 dark:text-gray-100">
								{definition.relation_name}
							</div>
							{#if definition.display_name}
								<div class="text-xs text-gray-600 dark:text-gray-400">
									{definition.display_name}
								</div>
							{/if}
						</div>
						<div class="flex items-center space-x-2">
							{#if definition.is_system}
								<span
									class="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full font-medium"
								>
									System
								</span>
							{/if}
							<span class="text-xs text-gray-500 dark:text-gray-400"
								>Priority: {definition.priority}</span
							>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Recent Relationships Preview -->
	{#if !loading && relationships.length > 0}
		<div
			class="mt-8 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6"
		>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-xl font-semibold dark:text-white">Recent Relationships</h2>
				<a
					href="/admin/admin-rebac/tuples"
					class="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 flex items-center"
				>
					View all
					<span class="i-ph-arrow-right ml-1"></span>
				</a>
			</div>
			<div class="space-y-2">
				{#each relationships.slice(0, 5) as relationship (relationship.id)}
					<div
						class="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700"
					>
						<div class="font-mono text-sm text-gray-900 dark:text-gray-100">
							<span class="text-blue-600 dark:text-blue-400">{relationship.from_id}</span>
							<span class="text-gray-500 dark:text-gray-400 mx-2"
								>{relationship.relationship_type}</span
							>
							<span class="text-purple-600 dark:text-purple-400">{relationship.to_id}</span>
						</div>
						<div class="flex items-center space-x-2">
							{#if relationship.permission_level}
								<span
									class="px-2 py-1 text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-full font-medium"
								>
									{relationship.permission_level}
								</span>
							{/if}
							{#if relationship.is_transitive}
								<span
									class="px-2 py-1 text-xs bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 rounded-full font-medium"
								>
									Transitive
								</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

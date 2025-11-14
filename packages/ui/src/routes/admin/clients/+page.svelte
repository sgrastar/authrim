<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Card, Button, Input } from '$lib/components';
	import { onMount } from 'svelte';

	interface Client {
		client_id: string;
		client_name: string;
		grant_types: string;
		created_at: number;
	}

	let clients: Client[] = [];
	let loading = true;
	let searchQuery = '';
	let currentPage = 1;
	let totalPages = 1;
	let totalCount = 0;
	const itemsPerPage = 20;

	onMount(async () => {
		await loadClients();
	});

	async function loadClients() {
		loading = true;
		// Simulate API call - would call GET /admin/clients in real implementation
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Mock data
		const mockClients: Client[] = Array.from({ length: 25 }, (_, i) => ({
			client_id: `client-${i + 1}`,
			client_name: `Application ${i + 1}`,
			grant_types: i % 2 === 0 ? 'authorization_code,refresh_token' : 'authorization_code',
			created_at: Date.now() - i * 86400000
		}));

		// Apply search filter
		let filtered = mockClients;
		if (searchQuery) {
			filtered = filtered.filter(
				(c) =>
					c.client_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
					c.client_id.toLowerCase().includes(searchQuery.toLowerCase())
			);
		}

		totalCount = filtered.length;
		totalPages = Math.ceil(totalCount / itemsPerPage);

		// Pagination
		const start = (currentPage - 1) * itemsPerPage;
		const end = start + itemsPerPage;
		clients = filtered.slice(start, end);

		loading = false;
	}

	function handleSearch() {
		currentPage = 1;
		loadClients();
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString();
	}

	function handleDeleteClient(clientId: string) {
		// In real implementation, would show confirmation dialog and call DELETE /admin/clients/:id
		console.log('Delete client:', clientId);
	}

	function nextPage() {
		if (currentPage < totalPages) {
			currentPage++;
			loadClients();
		}
	}

	function prevPage() {
		if (currentPage > 1) {
			currentPage--;
			loadClients();
		}
	}
</script>

<svelte:head>
	<title>{m.admin_clients_title()} - {m.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
				{m.admin_clients_title()}
			</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				Manage OAuth 2.0 / OpenID Connect clients
			</p>
		</div>
		<Button variant="primary" on:click={() => (window.location.href = '/admin/clients/new')}>
			{m.admin_clients_registerClient()}
		</Button>
	</div>

	<!-- Search -->
	<Card>
		<div class="max-w-md">
			<Input
				type="text"
				placeholder={m.admin_clients_search()}
				bind:value={searchQuery}
				on:input={handleSearch}
			>
				<div slot="icon" class="i-heroicons-magnifying-glass h-5 w-5"></div>
			</Input>
		</div>
	</Card>

	<!-- Clients table -->
	<Card>
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_clients_clientId()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_clients_clientName()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_clients_grantTypes()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_clients_created()}
						</th>
						<th class="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_clients_actions()}
						</th>
					</tr>
				</thead>
				<tbody>
					{#if loading}
						{#each Array(5) as _}
							<tr class="border-b border-gray-200 dark:border-gray-700">
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-40 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-48 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3 text-right">
									<div class="inline-flex gap-2">
										<div class="h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
										<div class="h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
									</div>
								</td>
							</tr>
						{/each}
					{:else if clients.length === 0}
						<tr>
							<td colspan="5" class="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
								No clients found
							</td>
						</tr>
					{:else}
						{#each clients as client}
							<tr class="border-b border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
								<td class="px-4 py-3 font-mono text-sm text-gray-900 dark:text-white">
									{client.client_id}
								</td>
								<td class="px-4 py-3 text-sm text-gray-900 dark:text-white">
									{client.client_name}
								</td>
								<td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
									{client.grant_types}
								</td>
								<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
									{formatDate(client.created_at)}
								</td>
								<td class="px-4 py-3 text-right">
									<div class="inline-flex gap-2">
										<a
											href={`/admin/clients/${client.client_id}`}
											class="rounded bg-primary-500 px-3 py-1 text-xs font-medium text-white hover:bg-primary-600 transition-colors"
										>
											View
										</a>
										<button
											class="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 transition-colors"
											on:click={() => handleDeleteClient(client.client_id)}
										>
											Delete
										</button>
									</div>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if !loading && totalPages > 1}
			<div class="flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-700">
				<div class="text-sm text-gray-700 dark:text-gray-300">
					Showing <span class="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span>
					to
					<span class="font-medium">{Math.min(currentPage * itemsPerPage, totalCount)}</span>
					of
					<span class="font-medium">{totalCount}</span> results
				</div>
				<div class="flex gap-2">
					<button
						class="rounded-lg border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
						disabled={currentPage === 1}
						on:click={prevPage}
					>
						Previous
					</button>
					<button
						class="rounded-lg border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
						disabled={currentPage === totalPages}
						on:click={nextPage}
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	</Card>
</div>

<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Card, Button, Input } from '$lib/components';
	import { onMount } from 'svelte';

	interface User {
		id: string;
		email: string;
		name: string | null;
		email_verified: boolean;
		created_at: number;
		last_login_at: number | null;
	}

	let users: User[] = [];
	let loading = true;
	let searchQuery = '';
	let filterStatus: 'all' | 'verified' | 'unverified' = 'all';
	let currentPage = 1;
	let totalPages = 1;
	let totalCount = 0;
	const itemsPerPage = 20;

	onMount(async () => {
		await loadUsers();
	});

	async function loadUsers() {
		loading = true;
		// Simulate API call - would call GET /admin/users in real implementation
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Mock data
		const mockUsers: User[] = Array.from({ length: 50 }, (_, i) => ({
			id: `user-${i + 1}`,
			email: `user${i + 1}@example.com`,
			name: i % 3 === 0 ? null : `User ${i + 1}`,
			email_verified: i % 4 !== 0,
			created_at: Date.now() - i * 86400000,
			last_login_at: i % 5 === 0 ? null : Date.now() - i * 3600000
		}));

		// Apply filters
		let filtered = mockUsers;
		if (searchQuery) {
			filtered = filtered.filter(
				(u) =>
					u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
					u.name?.toLowerCase().includes(searchQuery.toLowerCase())
			);
		}
		if (filterStatus === 'verified') {
			filtered = filtered.filter((u) => u.email_verified);
		} else if (filterStatus === 'unverified') {
			filtered = filtered.filter((u) => !u.email_verified);
		}

		totalCount = filtered.length;
		totalPages = Math.ceil(totalCount / itemsPerPage);

		// Pagination
		const start = (currentPage - 1) * itemsPerPage;
		const end = start + itemsPerPage;
		users = filtered.slice(start, end);

		loading = false;
	}

	function handleSearch() {
		currentPage = 1;
		loadUsers();
	}

	function handleFilterChange(status: typeof filterStatus) {
		filterStatus = status;
		currentPage = 1;
		loadUsers();
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return 'Never';
		return new Date(timestamp).toLocaleDateString();
	}

	function handleDeleteUser(userId: string) {
		// In real implementation, would show confirmation dialog and call DELETE /admin/users/:id
		console.log('Delete user:', userId);
	}

	function nextPage() {
		if (currentPage < totalPages) {
			currentPage++;
			loadUsers();
		}
	}

	function prevPage() {
		if (currentPage > 1) {
			currentPage--;
			loadUsers();
		}
	}
</script>

<svelte:head>
	<title>{m.admin_users_title()} - {m.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
				{m.admin_users_title()}
			</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				Manage user accounts and permissions
			</p>
		</div>
		<Button variant="primary" on:click={() => (window.location.href = '/admin/users/new')}>
			{m.admin_users_addUser()}
		</Button>
	</div>

	<!-- Filters and search -->
	<Card>
		<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<!-- Search -->
			<div class="flex-1 max-w-md">
				<Input
					type="text"
					placeholder={m.admin_users_search()}
					bind:value={searchQuery}
					on:input={handleSearch}
				>
					<div slot="icon" class="i-heroicons-magnifying-glass h-5 w-5"></div>
				</Input>
			</div>

			<!-- Filter -->
			<div class="flex gap-2">
				<button
					class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
					class:bg-primary-500={filterStatus === 'all'}
					class:text-white={filterStatus === 'all'}
					class:bg-gray-200={filterStatus !== 'all'}
					class:text-gray-700={filterStatus !== 'all'}
					class:dark:bg-gray-700={filterStatus !== 'all'}
					class:dark:text-gray-300={filterStatus !== 'all'}
					on:click={() => handleFilterChange('all')}
				>
					{m.admin_users_all()}
				</button>
				<button
					class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
					class:bg-primary-500={filterStatus === 'verified'}
					class:text-white={filterStatus === 'verified'}
					class:bg-gray-200={filterStatus !== 'verified'}
					class:text-gray-700={filterStatus !== 'verified'}
					class:dark:bg-gray-700={filterStatus !== 'verified'}
					class:dark:text-gray-300={filterStatus !== 'verified'}
					on:click={() => handleFilterChange('verified')}
				>
					{m.admin_users_verified()}
				</button>
				<button
					class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
					class:bg-primary-500={filterStatus === 'unverified'}
					class:text-white={filterStatus === 'unverified'}
					class:bg-gray-200={filterStatus !== 'unverified'}
					class:text-gray-700={filterStatus !== 'unverified'}
					class:dark:bg-gray-700={filterStatus !== 'unverified'}
					class:dark:text-gray-300={filterStatus !== 'unverified'}
					on:click={() => handleFilterChange('unverified')}
				>
					{m.admin_users_unverified()}
				</button>
			</div>
		</div>
	</Card>

	<!-- Users table -->
	<Card>
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_users_email()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_users_name()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_users_status()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_users_created()}
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_users_lastLogin()}
						</th>
						<th class="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-white">
							{m.admin_users_actions()}
						</th>
					</tr>
				</thead>
				<tbody>
					{#if loading}
						{#each Array(5) as _}
							<tr class="border-b border-gray-200 dark:border-gray-700">
								<td class="px-4 py-3">
									<div class="h-4 w-48 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-6 w-20 animate-pulse rounded-full bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
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
					{:else if users.length === 0}
						<tr>
							<td colspan="6" class="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
								No users found
							</td>
						</tr>
					{:else}
						{#each users as user}
							<tr class="border-b border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
								<td class="px-4 py-3 text-sm text-gray-900 dark:text-white">
									{user.email}
								</td>
								<td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
									{user.name || '-'}
								</td>
								<td class="px-4 py-3">
									{#if user.email_verified}
										<span
											class="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200"
										>
											Verified
										</span>
									{:else}
										<span
											class="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-300"
										>
											Unverified
										</span>
									{/if}
								</td>
								<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
									{formatDate(user.created_at)}
								</td>
								<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
									{formatDate(user.last_login_at)}
								</td>
								<td class="px-4 py-3 text-right">
									<div class="inline-flex gap-2">
										<a
											href={`/admin/users/${user.id}`}
											class="rounded bg-primary-500 px-3 py-1 text-xs font-medium text-white hover:bg-primary-600 transition-colors"
										>
											{m.admin_users_view()}
										</a>
										<button
											class="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 transition-colors"
											on:click={() => handleDeleteUser(user.id)}
										>
											{m.admin_users_delete()}
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

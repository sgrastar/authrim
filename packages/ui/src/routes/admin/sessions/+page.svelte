<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button } from '$lib/components';
	import { onMount } from 'svelte';
	import { adminSessionsAPI } from '$lib/api/client';

	interface Session {
		id: string;
		user_id: string;
		user_email: string;
		user_name?: string;
		created_at: string;
		last_accessed_at: string;
		expires_at: string;
		ip_address?: string;
		user_agent?: string;
		is_active: boolean;
	}

	let sessions: Session[] = [];
	let loading = true;
	let filterStatus: 'all' | 'active' | 'expired' = 'all';
	let currentPage = 1;
	let totalPages = 1;
	let totalCount = 0;
	const itemsPerPage = 20;

	onMount(async () => {
		await loadSessions();
	});

	async function loadSessions() {
		loading = true;

		try {
			const { data, error } = await adminSessionsAPI.list({
				page: currentPage,
				limit: itemsPerPage,
				active: filterStatus === 'all' ? undefined : filterStatus === 'active' ? 'true' : 'false'
			});

			if (error) {
				console.error('Failed to load sessions:', error);
				sessions = [];
				totalCount = 0;
				totalPages = 0;
			} else if (data) {
				sessions = data.sessions;
				totalCount = data.pagination.total;
				totalPages = data.pagination.totalPages;
			}
		} catch (err) {
			console.error('Error loading sessions:', err);
			sessions = [];
			totalCount = 0;
			totalPages = 0;
		} finally {
			loading = false;
		}
	}

	function handleFilterChange(status: typeof filterStatus) {
		filterStatus = status;
		currentPage = 1;
		loadSessions();
	}

	function formatDate(dateString: string): string {
		return new Date(dateString).toLocaleString();
	}

	function isExpired(expiresAt: string): boolean {
		return new Date(expiresAt) < new Date();
	}

	async function handleRevokeSession(sessionId: string) {
		if (!confirm('Are you sure you want to revoke this session?')) {
			return;
		}

		try {
			const { error } = await adminSessionsAPI.revoke(sessionId);

			if (error) {
				alert('Failed to revoke session: ' + (error.error_description || 'Unknown error'));
			} else {
				await loadSessions();
			}
		} catch (err) {
			console.error('Error revoking session:', err);
			alert('Failed to revoke session');
		}
	}

	function nextPage() {
		if (currentPage < totalPages) {
			currentPage++;
			loadSessions();
		}
	}

	function prevPage() {
		if (currentPage > 1) {
			currentPage--;
			loadSessions();
		}
	}
</script>

<svelte:head>
	<title>Sessions - {$LL.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">Sessions</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				Manage user sessions and revoke access
			</p>
		</div>
	</div>

	<!-- Filters -->
	<Card>
		<div class="flex gap-2">
			<button
				class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
				class:bg-primary-500={filterStatus === 'all'}
				class:text-white={filterStatus === 'all'}
				class:bg-gray-200={filterStatus !== 'all'}
				class:text-gray-700={filterStatus !== 'all'}
				class:dark:bg-gray-700={filterStatus !== 'all'}
				class:dark:text-gray-300={filterStatus !== 'all'}
				onclick={() => handleFilterChange('all')}
			>
				All
			</button>
			<button
				class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
				class:bg-primary-500={filterStatus === 'active'}
				class:text-white={filterStatus === 'active'}
				class:bg-gray-200={filterStatus !== 'active'}
				class:text-gray-700={filterStatus !== 'active'}
				class:dark:bg-gray-700={filterStatus !== 'active'}
				class:dark:text-gray-300={filterStatus !== 'active'}
				onclick={() => handleFilterChange('active')}
			>
				Active
			</button>
			<button
				class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
				class:bg-primary-500={filterStatus === 'expired'}
				class:text-white={filterStatus === 'expired'}
				class:bg-gray-200={filterStatus !== 'expired'}
				class:text-gray-700={filterStatus !== 'expired'}
				class:dark:bg-gray-700={filterStatus !== 'expired'}
				class:dark:text-gray-300={filterStatus !== 'expired'}
				onclick={() => handleFilterChange('expired')}
			>
				Expired
			</button>
		</div>
	</Card>

	<!-- Sessions table -->
	<Card>
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							User
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							Status
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							Created
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							Last Accessed
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							Expires
						</th>
						<th class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
							IP Address
						</th>
						<th class="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-white">
							Actions
						</th>
					</tr>
				</thead>
				<tbody>
					{#if loading}
						<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
						{#each Array(5) as _item, i (i)}
							<tr class="border-b border-gray-200 dark:border-gray-700">
								<td class="px-4 py-3">
									<div class="h-4 w-48 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div
										class="h-6 w-20 animate-pulse rounded-full bg-gray-300 dark:bg-gray-700"
									></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3 text-right">
									<div class="inline-flex gap-2">
										<div class="h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
									</div>
								</td>
							</tr>
						{/each}
					{:else if sessions.length === 0}
						<tr>
							<td colspan="7" class="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
								No sessions found
							</td>
						</tr>
					{:else}
						{#each sessions as session (session.id)}
							<tr class="border-b border-gray-200 dark:border-gray-700">
								<!-- User -->
								<td class="px-4 py-3">
									<div class="flex flex-col">
										<span class="text-sm font-medium text-gray-900 dark:text-white">
											{session.user_email}
										</span>
										{#if session.user_name}
											<span class="text-xs text-gray-500 dark:text-gray-400">
												{session.user_name}
											</span>
										{/if}
									</div>
								</td>

								<!-- Status -->
								<td class="px-4 py-3">
									{#if session.is_active && !isExpired(session.expires_at)}
										<span
											class="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200"
										>
											Active
										</span>
									{:else}
										<span
											class="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200"
										>
											Expired
										</span>
									{/if}
								</td>

								<!-- Created -->
								<td class="px-4 py-3 text-sm text-gray-900 dark:text-white">
									{formatDate(session.created_at)}
								</td>

								<!-- Last Accessed -->
								<td class="px-4 py-3 text-sm text-gray-900 dark:text-white">
									{formatDate(session.last_accessed_at)}
								</td>

								<!-- Expires -->
								<td class="px-4 py-3 text-sm text-gray-900 dark:text-white">
									{formatDate(session.expires_at)}
								</td>

								<!-- IP Address -->
								<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
									{session.ip_address || 'N/A'}
								</td>

								<!-- Actions -->
								<td class="px-4 py-3 text-right">
									<div class="inline-flex gap-2">
										{#if session.is_active && !isExpired(session.expires_at)}
											<Button
												variant="danger"
												size="sm"
												onclick={() => handleRevokeSession(session.id)}
											>
												Revoke
											</Button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div
				class="mt-4 flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-700"
			>
				<div class="text-sm text-gray-700 dark:text-gray-300">
					Showing <span class="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to
					<span class="font-medium">{Math.min(currentPage * itemsPerPage, totalCount)}</span>
					of
					<span class="font-medium">{totalCount}</span> results
				</div>
				<div class="flex gap-2">
					<Button variant="secondary" size="sm" onclick={prevPage} disabled={currentPage === 1}>
						Previous
					</Button>
					<Button
						variant="secondary"
						size="sm"
						onclick={nextPage}
						disabled={currentPage === totalPages}
					>
						Next
					</Button>
				</div>
			</div>
		{/if}
	</Card>
</div>

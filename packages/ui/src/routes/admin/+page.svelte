<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card } from '$lib/components';
	import { onMount } from 'svelte';

	// Mock statistics data - would be fetched from API in real implementation
	interface Statistics {
		activeUsers: number;
		totalUsers: number;
		clients: number;
		todayLogins: number;
	}

	interface Activity {
		id: string;
		type: 'user_created' | 'user_login' | 'client_registered';
		user: string;
		timestamp: string;
	}

	let stats: Statistics = {
		activeUsers: 0,
		totalUsers: 0,
		clients: 0,
		todayLogins: 0
	};

	let recentActivity: Activity[] = [];
	let loading = true;

	onMount(async () => {
		try {
			// Call real API
			const { adminStatsAPI } = await import('$lib/api/client');
			const { data, error } = await adminStatsAPI.get();

			if (error) {
				console.error('Failed to load stats:', error);
			} else if (data) {
				stats = {
					activeUsers: data.stats.activeUsers,
					totalUsers: data.stats.totalUsers,
					clients: data.stats.registeredClients,
					todayLogins: data.stats.loginsToday
				};

				// Convert recent activity from API format
				recentActivity = data.recentActivity.map(
					(activity: { email?: string; timestamp: number }, index: number) => ({
						id: String(index),
						type: 'user_created' as const,
						user: activity.email || 'Unknown',
						timestamp: new Date(activity.timestamp).toISOString()
					})
				);
			}
		} catch (err) {
			console.error('Error loading admin stats:', err);
		} finally {
			loading = false;
		}
	});

	function formatTimestamp(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);

		if (minutes < 60) {
			return `${minutes} minutes ago`;
		} else if (hours < 24) {
			return `${hours} hours ago`;
		} else {
			return date.toLocaleDateString();
		}
	}

	function getActivityIcon(type: Activity['type']): string {
		switch (type) {
			case 'user_created':
				return 'i-heroicons-user-plus';
			case 'user_login':
				return 'i-heroicons-arrow-right-on-rectangle';
			case 'client_registered':
				return 'i-heroicons-cube';
			default:
				return 'i-heroicons-information-circle';
		}
	}

	function getActivityText(activity: Activity): string {
		switch (activity.type) {
			case 'user_created':
				return `New user registered: ${activity.user}`;
			case 'user_login':
				return `User logged in: ${activity.user}`;
			case 'client_registered':
				return `New OAuth client registered by ${activity.user}`;
			default:
				return `Unknown activity`;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_dashboard_title()} - {$LL.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div>
		<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
			{$LL.admin_dashboard_title()}
		</h1>
		<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Overview of your Authrim instance</p>
	</div>

	<!-- Statistics cards -->
	<div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
		<!-- Active Users -->
		<Card>
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium text-gray-500 dark:text-gray-400">
						{$LL.admin_dashboard_activeUsers()}
					</p>
					<p class="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
						{#if loading}
							<span class="inline-block h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"
							></span>
						{:else}
							{stats.activeUsers.toLocaleString()}
						{/if}
					</p>
				</div>
				<div class="rounded-lg bg-primary-100 p-3 dark:bg-primary-900">
					<div class="i-heroicons-users h-6 w-6 text-primary-600 dark:text-primary-400"></div>
				</div>
			</div>
		</Card>

		<!-- Total Users -->
		<Card>
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium text-gray-500 dark:text-gray-400">
						{$LL.admin_dashboard_totalUsers()}
					</p>
					<p class="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
						{#if loading}
							<span class="inline-block h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"
							></span>
						{:else}
							{stats.totalUsers.toLocaleString()}
						{/if}
					</p>
				</div>
				<div class="rounded-lg bg-secondary-100 p-3 dark:bg-secondary-900">
					<div
						class="i-heroicons-user-group h-6 w-6 text-secondary-600 dark:text-secondary-400"
					></div>
				</div>
			</div>
		</Card>

		<!-- OAuth Clients -->
		<Card>
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium text-gray-500 dark:text-gray-400">
						{$LL.admin_dashboard_clients()}
					</p>
					<p class="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
						{#if loading}
							<span class="inline-block h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"
							></span>
						{:else}
							{stats.clients}
						{/if}
					</p>
				</div>
				<div class="rounded-lg bg-purple-100 p-3 dark:bg-purple-900">
					<div class="i-heroicons-cube h-6 w-6 text-purple-600 dark:text-purple-400"></div>
				</div>
			</div>
		</Card>

		<!-- Today's Logins -->
		<Card>
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium text-gray-500 dark:text-gray-400">
						{$LL.admin_dashboard_todayLogins()}
					</p>
					<p class="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
						{#if loading}
							<span class="inline-block h-8 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"
							></span>
						{:else}
							{stats.todayLogins}
						{/if}
					</p>
				</div>
				<div class="rounded-lg bg-orange-100 p-3 dark:bg-orange-900">
					<div
						class="i-heroicons-arrow-right-on-rectangle h-6 w-6 text-orange-600 dark:text-orange-400"
					></div>
				</div>
			</div>
		</Card>
	</div>

	<!-- Recent Activity -->
	<Card>
		<div class="mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-white">
				{$LL.admin_dashboard_recentActivity()}
			</h2>
		</div>

		{#if loading}
			<div class="space-y-3">
				<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
				{#each Array(3) as _, i (i)}
					<div class="flex items-center gap-3">
						<div class="h-10 w-10 animate-pulse rounded-full bg-gray-300 dark:bg-gray-700"></div>
						<div class="flex-1 space-y-2">
							<div class="h-4 w-2/3 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
							<div class="h-3 w-1/3 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else if recentActivity.length === 0}
			<p class="text-center text-gray-500 dark:text-gray-400">No recent activity</p>
		{:else}
			<div class="space-y-3">
				{#each recentActivity as activity (activity.id)}
					<div class="flex items-start gap-3">
						<div
							class="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800"
						>
							<div
								class={`${getActivityIcon(activity.type)} h-5 w-5 text-gray-600 dark:text-gray-400`}
							></div>
						</div>
						<div class="flex-1 min-w-0">
							<p class="text-sm text-gray-900 dark:text-white">
								{getActivityText(activity)}
							</p>
							<p class="text-xs text-gray-500 dark:text-gray-400">
								{formatTimestamp(activity.timestamp)}
							</p>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</Card>

	<!-- Quick Actions -->
	<div class="grid gap-6 sm:grid-cols-2">
		<Card>
			<div class="flex items-center justify-between">
				<div>
					<h3 class="text-lg font-semibold text-gray-900 dark:text-white">User Management</h3>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
						Manage users and their permissions
					</p>
				</div>
				<a
					href="/admin/users"
					class="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 transition-colors"
				>
					View Users
				</a>
			</div>
		</Card>

		<Card>
			<div class="flex items-center justify-between">
				<div>
					<h3 class="text-lg font-semibold text-gray-900 dark:text-white">Client Management</h3>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
						Register and configure OAuth clients
					</p>
				</div>
				<a
					href="/admin/clients"
					class="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 transition-colors"
				>
					View Clients
				</a>
			</div>
		</Card>
	</div>
</div>

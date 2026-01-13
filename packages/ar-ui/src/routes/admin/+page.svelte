<script lang="ts">
	import { onMount } from 'svelte';
	import { adminStatsAPI, type DashboardStats } from '$lib/api/admin-stats';

	let stats: DashboardStats | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	onMount(async () => {
		try {
			stats = await adminStatsAPI.getDashboardStats();
		} catch (err) {
			console.error('Failed to load dashboard stats:', err);
			error = 'Failed to load statistics';
		} finally {
			loading = false;
		}
	});

	function formatTimestamp(timestamp: number): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);

		if (minutes < 1) return 'Just now';
		if (minutes < 60) return `${minutes} min ago`;
		if (hours < 24) return `${hours} hours ago`;
		return date.toLocaleDateString();
	}
</script>

<svelte:head>
	<title>Admin Dashboard - Authrim</title>
</svelte:head>

<div>
	<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin-bottom: 24px;">
		Dashboard
	</h1>

	{#if loading}
		<p style="color: #6b7280;">Loading statistics...</p>
	{:else if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;"
		>
			{error}
		</div>
	{:else if stats}
		<!-- Statistics Cards -->
		<div
			style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px;"
		>
			<!-- Active Users -->
			<div
				style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
			>
				<p style="color: #6b7280; font-size: 14px; margin: 0 0 8px 0;">Active Users</p>
				<p style="color: #1f2937; font-size: 32px; font-weight: bold; margin: 0;">
					{stats.stats.activeUsers}
				</p>
				<p style="color: #9ca3af; font-size: 12px; margin: 4px 0 0 0;">Last 30 days</p>
			</div>

			<!-- Total Users -->
			<div
				style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
			>
				<p style="color: #6b7280; font-size: 14px; margin: 0 0 8px 0;">Total Users</p>
				<p style="color: #1f2937; font-size: 32px; font-weight: bold; margin: 0;">
					{stats.stats.totalUsers}
				</p>
				<p style="color: #9ca3af; font-size: 12px; margin: 4px 0 0 0;">All time</p>
			</div>

			<!-- OAuth Clients -->
			<div
				style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
			>
				<p style="color: #6b7280; font-size: 14px; margin: 0 0 8px 0;">OAuth Clients</p>
				<p style="color: #1f2937; font-size: 32px; font-weight: bold; margin: 0;">
					{stats.stats.registeredClients}
				</p>
				<p style="color: #9ca3af; font-size: 12px; margin: 4px 0 0 0;">Registered</p>
			</div>

			<!-- Today's Logins -->
			<div
				style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
			>
				<p style="color: #6b7280; font-size: 14px; margin: 0 0 8px 0;">Today's Logins</p>
				<p style="color: #1f2937; font-size: 32px; font-weight: bold; margin: 0;">
					{stats.stats.loginsToday}
				</p>
				<p style="color: #9ca3af; font-size: 12px; margin: 4px 0 0 0;">Successful logins</p>
			</div>
		</div>

		<!-- Recent Activity -->
		<div
			style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
		>
			<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">
				Recent Activity
			</h2>

			{#if stats.recentActivity.length === 0}
				<p style="color: #9ca3af; text-align: center; padding: 20px;">No recent activity</p>
			{:else}
				<ul style="list-style: none; padding: 0; margin: 0;">
					{#each stats.recentActivity as activity (activity.userId + activity.timestamp)}
						<li style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<div>
									<p style="color: #1f2937; font-size: 14px; margin: 0;">
										{#if activity.type === 'user_registration'}
											New user registered
										{:else}
											{activity.type}
										{/if}
									</p>
									<p style="color: #6b7280; font-size: 12px; margin: 4px 0 0 0;">
										{activity.email || activity.name || 'Unknown user'}
									</p>
								</div>
								<span style="color: #9ca3af; font-size: 12px;">
									{formatTimestamp(activity.timestamp)}
								</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

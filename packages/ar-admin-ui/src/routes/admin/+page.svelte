<script lang="ts">
	import { onMount } from 'svelte';
	import { adminStatsAPI, type DashboardStats } from '$lib/api/admin-stats';
	import Card from '$lib/components/Card.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import Button from '$lib/components/Button.svelte';
	import Alert from '$lib/components/Alert.svelte';

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

	function getActivityIcon(type: string): {
		icon: string;
		color: 'green' | 'purple' | 'pink' | 'orange';
	} {
		switch (type) {
			case 'user_registration':
				return { icon: 'i-ph-user-plus', color: 'green' };
			case 'login':
				return { icon: 'i-ph-sign-in', color: 'purple' };
			case 'settings_update':
				return { icon: 'i-ph-gear', color: 'purple' };
			case 'client_registration':
				return { icon: 'i-ph-monitor', color: 'pink' };
			case 'failed_login':
				return { icon: 'i-ph-warning', color: 'orange' };
			default:
				return { icon: 'i-ph-info', color: 'purple' };
		}
	}
</script>

<svelte:head>
	<title>Admin Dashboard - Authrim</title>
</svelte:head>

<div class="dashboard">
	<!-- Page Header -->
	<div class="page-header">
		<div class="page-header-row">
			<div>
				<h1 class="page-title">Welcome back</h1>
				<p class="page-description">
					Here's what's happening with your authentication infrastructure
				</p>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			<p>Loading statistics...</p>
		</div>
	{:else if error}
		<Alert variant="error" title="Error loading dashboard">
			{error}
		</Alert>
	{:else if stats}
		<!-- Stats Grid -->
		<div class="stats-grid">
			<StatCard
				value={stats.stats.activeUsers}
				label="Active Users"
				icon="i-ph-users"
				iconColor="pink"
				change={{ value: '+12%', positive: true }}
			/>
			<StatCard
				value={stats.stats.totalUsers}
				label="Total Users"
				icon="i-ph-users"
				iconColor="purple"
			/>
			<StatCard
				value={stats.stats.registeredClients}
				label="OAuth Clients"
				icon="i-ph-monitor"
				iconColor="green"
				change={{ value: '+5', positive: true }}
			/>
			<StatCard
				value={stats.stats.loginsToday}
				label="Today's Logins"
				icon="i-ph-sign-in"
				iconColor="orange"
			/>
		</div>

		<!-- Content Grid -->
		<div class="content-grid">
			<!-- Recent Activity -->
			<Card>
				{#snippet header()}
					<h3 class="card-title">Recent Activity</h3>
					<Button variant="ghost" size="sm">View all</Button>
				{/snippet}

				{#if stats.recentActivity.length === 0}
					<p class="empty-state">No recent activity</p>
				{:else}
					<ul class="activity-list">
						{#each stats.recentActivity as activity (activity.userId + activity.timestamp)}
							{@const activityStyle = getActivityIcon(activity.type)}
							<li class="activity-item">
								<div class="activity-icon stat-icon {activityStyle.color}">
									<i class={activityStyle.icon}></i>
								</div>
								<div class="activity-content">
									<div class="activity-text">
										{#if activity.type === 'user_registration'}
											New user <strong>{activity.email || activity.name || 'Unknown'}</strong> registered
										{:else if activity.type === 'login'}
											User <strong>{activity.email || activity.name || 'Unknown'}</strong> logged in
										{:else if activity.type === 'client_registration'}
											New client <strong>{activity.name || 'Unknown'}</strong> registered
										{:else}
											{activity.type} -
											<strong>{activity.email || activity.name || 'Unknown'}</strong>
										{/if}
									</div>
									<div class="activity-time">{formatTimestamp(activity.timestamp)}</div>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</Card>

			<!-- Quick Actions -->
			<Card>
				{#snippet header()}
					<h3 class="card-title">Quick Actions</h3>
				{/snippet}

				<div class="quick-actions">
					<a href="/admin/users" class="quick-action-btn">
						<i class="i-ph-magnifying-glass"></i>
						Search Users
					</a>
					<a href="/admin/clients/new" class="quick-action-btn">
						<i class="i-ph-plus"></i>
						Register New Client
					</a>
					<a href="/admin/audit-logs" class="quick-action-btn">
						<i class="i-ph-file-text"></i>
						View Audit Logs
					</a>
					<a href="/admin/settings" class="quick-action-btn">
						<i class="i-ph-gear"></i>
						Manage Settings
					</a>
				</div>
			</Card>
		</div>
	{/if}
</div>

<style>
	.dashboard {
		max-width: 1400px;
	}

	/* Page Header */
	.page-header {
		margin-bottom: 32px;
	}

	.page-header-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
	}

	.page-title {
		font-size: 2.25rem;
		font-weight: 800;
		background: var(--gradient-primary);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
		line-height: 1.2;
		margin: 0;
	}

	.page-description {
		color: var(--text-primary);
		opacity: 0.8;
		font-size: 1rem;
		margin-top: 8px;
		font-weight: 500;
	}

	/* Loading State */
	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 64px;
		color: var(--text-muted);
		gap: 16px;
	}

	.loading-state :global(i) {
		width: 32px;
		height: 32px;
		color: var(--primary);
	}

	/* Stats Grid */
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 20px;
		margin-bottom: 32px;
	}

	/* Content Grid */
	.content-grid {
		display: grid;
		grid-template-columns: 2fr 1fr;
		gap: 24px;
	}

	/* Card Title */
	.card-title {
		font-size: 1.125rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0;
	}

	/* Empty State */
	.empty-state {
		color: var(--text-muted);
		text-align: center;
		padding: 40px 20px;
	}

	/* Activity List */
	.activity-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.activity-item {
		display: flex;
		gap: 16px;
		padding: 16px 0;
		border-bottom: 1px solid var(--border);
	}

	.activity-item:last-child {
		border-bottom: none;
	}

	.activity-icon {
		width: 40px;
		height: 40px;
		border-radius: var(--radius-lg);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.activity-icon :global(i) {
		width: 18px;
		height: 18px;
	}

	.stat-icon.green {
		background: var(--success-light);
		color: var(--success);
	}

	.stat-icon.purple {
		background: var(--primary-light);
		color: var(--primary);
	}

	.stat-icon.pink {
		background: var(--accent-light);
		color: var(--accent);
	}

	.stat-icon.orange {
		background: var(--warning-light);
		color: var(--warning);
	}

	.activity-content {
		flex: 1;
	}

	.activity-text {
		font-size: 0.9375rem;
		color: var(--text-primary);
	}

	.activity-text :global(strong) {
		font-weight: 600;
		color: var(--primary);
	}

	.activity-time {
		font-size: 0.8125rem;
		color: var(--text-muted);
		margin-top: 4px;
	}

	/* Quick Actions */
	.quick-actions {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.quick-action-btn {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: var(--bg-glass);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		color: var(--text-primary);
		font-size: 0.9375rem;
		font-weight: 500;
		text-decoration: none;
		transition: all var(--transition-fast);
		backdrop-filter: var(--blur-sm);
		-webkit-backdrop-filter: var(--blur-sm);
	}

	.quick-action-btn:hover {
		background: var(--bg-card);
		border-color: var(--primary);
		color: var(--primary);
		transform: translateY(-2px);
	}

	.quick-action-btn :global(i) {
		width: 20px;
		height: 20px;
		color: var(--text-muted);
		transition: color var(--transition-fast);
	}

	.quick-action-btn:hover :global(i) {
		color: var(--primary);
	}

	/* Responsive */
	@media (max-width: 1280px) {
		.stats-grid {
			grid-template-columns: repeat(2, 1fr);
		}

		.content-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 768px) {
		.page-title {
			font-size: 1.75rem;
		}

		.stats-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

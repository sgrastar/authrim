<script lang="ts">
	import { onMount } from 'svelte';
	import { adminStatsAPI, type DashboardStats } from '$lib/api/admin-stats';
	import { adminCacheModeAPI, type PlatformCacheModeResponse } from '$lib/api/admin-cache-mode';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import Card from '$lib/components/Card.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import Button from '$lib/components/Button.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	let stats = $state<DashboardStats | null>(null);
	let cacheMode = $state<PlatformCacheModeResponse | null>(null);
	let loading = $state(true);
	let error = $state('');

	// Check if cache is in maintenance mode (short TTL)
	const isMaintenanceMode = $derived(cacheMode !== null && cacheMode.effective === 'maintenance');

	onMount(async () => {
		try {
			await settingsContext.initialize();

			// Load stats and cache mode in parallel
			const [statsResult, cacheModeResult] = await Promise.allSettled([
				adminStatsAPI.getDashboardStats(),
				adminCacheModeAPI.getPlatformCacheMode()
			]);

			if (statsResult.status === 'fulfilled') {
				stats = statsResult.value;
			} else {
				console.error('Failed to load dashboard stats:', statsResult.reason);
				error = $LL.admin_dashboard_error_statistics();
			}

			if (cacheModeResult.status === 'fulfilled') {
				cacheMode = cacheModeResult.value;
			} else {
				// Cache mode failure is non-critical, just log it
				console.warn('Failed to load cache mode:', cacheModeResult.reason);
			}
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

		if (minutes < 1) return $LL.common_just_now();
		if (minutes < 60) return $LL.common_minutes_ago({ count: minutes });
		if (hours < 24) return $LL.common_hours_ago({ count: hours });
		return date.toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
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
	<title>{$LL.admin_dashboard_page_title()}</title>
</svelte:head>

<div class="dashboard">
	<!-- Page Header -->
	<div class="page-header">
		<div class="page-header-row">
			<div>
				<h1 class="page-title">{$LL.admin_dashboard_welcome_title()}</h1>
				<p class="page-description">
					{$LL.admin_dashboard_description()}
				</p>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			<p>{$LL.admin_dashboard_loading_statistics()}</p>
		</div>
	{:else if error}
		<Alert variant="error" title={$LL.admin_dashboard_error_title()}>
			{error}
		</Alert>
	{:else if stats}
		<!-- Cache Mode Warning Banner -->
		{#if isMaintenanceMode}
			<div class="cache-warning-banner">
				<div class="cache-warning-content">
					<div class="cache-warning-icon">
						<i class="i-ph-warning-circle"></i>
					</div>
					<div class="cache-warning-text">
						<strong>{$LL.admin_dashboard_cache_maintenance_title()}</strong>
						<p>
							{$LL.admin_dashboard_cache_maintenance_desc()}
							<a href="/admin/settings/cache-mode">{$LL.admin_dashboard_cache_settings_link()}</a>
						</p>
					</div>
					<a href="/admin/settings/cache-mode" class="cache-warning-action">
						<i class="i-ph-gear"></i>
						{$LL.admin_dashboard_settings_action()}
					</a>
				</div>
			</div>
		{/if}

		<!-- Stats Grid -->
		<div class="stats-grid">
			<StatCard
				value={stats.stats.activeUsers}
				label={$LL.admin_dashboard_activeUsers()}
				icon="i-ph-users"
				iconColor="pink"
				change={{ value: '+12%', positive: true }}
			/>
			<StatCard
				value={stats.stats.totalUsers}
				label={$LL.admin_dashboard_totalUsers()}
				icon="i-ph-users"
				iconColor="purple"
			/>
			<StatCard
				value={stats.stats.registeredClients}
				label={$LL.admin_dashboard_clients()}
				icon="i-ph-monitor"
				iconColor="green"
				change={{ value: '+5', positive: true }}
			/>
			<StatCard
				value={stats.stats.loginsToday}
				label={$LL.admin_dashboard_todayLogins()}
				icon="i-ph-sign-in"
				iconColor="orange"
			/>
		</div>

		<!-- Content Grid -->
		<div class="content-grid">
			<!-- Recent Activity -->
			<Card>
				{#snippet header()}
					<h3 class="card-title">{$LL.admin_dashboard_recentActivity()}</h3>
					<Button variant="ghost" size="sm">{$LL.admin_dashboard_view_all()}</Button>
				{/snippet}

				{#if stats.recentActivity.length === 0}
					<p class="empty-state">{$LL.admin_dashboard_no_recent_activity()}</p>
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
											{$LL.admin_dashboard_activity_new_user()}
											<strong
												>{activity.email || activity.name || $LL.admin_dashboard_unknown()}</strong
											>
											{$LL.admin_dashboard_activity_registered()}
										{:else if activity.type === 'login'}
											{$LL.admin_dashboard_activity_user()}
											<strong
												>{activity.email || activity.name || $LL.admin_dashboard_unknown()}</strong
											>
											{$LL.admin_dashboard_activity_logged_in()}
										{:else if activity.type === 'client_registration'}
											{$LL.admin_dashboard_activity_new_client()}
											<strong>{activity.name || $LL.admin_dashboard_unknown()}</strong>
											{$LL.admin_dashboard_activity_registered()}
										{:else}
											{activity.type} -
											<strong
												>{activity.email || activity.name || $LL.admin_dashboard_unknown()}</strong
											>
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
					<h3 class="card-title">{$LL.admin_dashboard_quick_actions()}</h3>
				{/snippet}

				<div class="quick-actions">
					<a href="/admin/users" class="quick-action-btn">
						<i class="i-ph-magnifying-glass"></i>
						{$LL.admin_dashboard_search_users()}
					</a>
					<a href="/admin/clients/new" class="quick-action-btn">
						<i class="i-ph-plus"></i>
						{$LL.admin_dashboard_register_new_client()}
					</a>
					<a href="/admin/audit-logs" class="quick-action-btn">
						<i class="i-ph-file-text"></i>
						{$LL.admin_dashboard_view_audit_logs()}
					</a>
					<a href="/admin/settings" class="quick-action-btn">
						<i class="i-ph-gear"></i>
						{$LL.admin_dashboard_manage_settings()}
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

	/* Cache Warning Banner */
	.cache-warning-banner {
		background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05));
		border: 1px solid rgba(245, 158, 11, 0.3);
		border-radius: var(--radius-xl);
		padding: 16px 20px;
		margin-bottom: 24px;
	}

	.cache-warning-content {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.cache-warning-icon {
		width: 44px;
		height: 44px;
		background: rgba(245, 158, 11, 0.2);
		border-radius: var(--radius-lg);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.cache-warning-icon :global(i) {
		width: 24px;
		height: 24px;
		color: #f59e0b;
	}

	.cache-warning-text {
		flex: 1;
	}

	.cache-warning-text strong {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		display: block;
		margin-bottom: 4px;
	}

	.cache-warning-text p {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
		line-height: 1.5;
	}

	.cache-warning-text a {
		color: var(--primary);
		text-decoration: none;
		font-weight: 500;
	}

	.cache-warning-text a:hover {
		text-decoration: underline;
	}

	.cache-warning-action {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		background: rgba(245, 158, 11, 0.15);
		border: 1px solid rgba(245, 158, 11, 0.3);
		border-radius: var(--radius-lg);
		color: #f59e0b;
		font-size: 0.875rem;
		font-weight: 600;
		text-decoration: none;
		transition: all var(--transition-fast);
		flex-shrink: 0;
	}

	.cache-warning-action:hover {
		background: rgba(245, 158, 11, 0.25);
		transform: translateY(-1px);
	}

	.cache-warning-action :global(i) {
		width: 18px;
		height: 18px;
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

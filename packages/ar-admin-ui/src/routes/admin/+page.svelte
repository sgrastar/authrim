<script lang="ts">
	import { onMount } from 'svelte';
	import { adminStatsAPI, type DashboardStats } from '$lib/api/admin-stats';
	import { adminCacheModeAPI, type PlatformCacheModeResponse } from '$lib/api/admin-cache-mode';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import Card from '$lib/components/Card.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import Button from '$lib/components/Button.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
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

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_dashboard_welcome_title()}
		description={$LL.admin_dashboard_description()}
	/>

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

		<AdminSection>
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
		</AdminSection>

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
</AdminPageShell>

<style>
	.dashboard {
		max-width: 1400px;
	}

	/* Cache Warning Banner */
	.cache-warning-banner {
		background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-warning) 40%, var(--color-border));
		border-radius: var(--radius-panel, var(--radius-xl));
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
		background: color-mix(in srgb, var(--color-warning) 16%, transparent);
		border-radius: var(--radius-control, var(--radius-lg));
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.cache-warning-icon :global(i) {
		width: 24px;
		height: 24px;
		color: var(--color-warning);
	}

	.cache-warning-text {
		flex: 1;
	}

	.cache-warning-text strong {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-text);
		display: block;
		margin-bottom: 4px;
	}

	.cache-warning-text p {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin: 0;
		line-height: 1.5;
	}

	.cache-warning-text a {
		color: var(--color-accent);
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
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-warning) 38%, var(--color-border));
		border-radius: var(--radius-control, var(--radius-lg));
		color: var(--color-warning);
		font-size: 0.875rem;
		font-weight: 600;
		text-decoration: none;
		transition: all var(--transition-fast);
		flex-shrink: 0;
	}

	.cache-warning-action:hover {
		background: color-mix(in srgb, var(--color-warning) 20%, transparent);
		transform: translateY(-1px);
	}

	.cache-warning-action :global(i) {
		width: 18px;
		height: 18px;
	}

	/* Loading State */
	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 64px;
		color: var(--color-text-subtle);
		gap: 16px;
	}

	.loading-state :global(i) {
		width: 32px;
		height: 32px;
		color: var(--color-accent);
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
		color: var(--color-text);
		margin: 0;
	}

	/* Empty State */
	.empty-state {
		color: var(--color-text-subtle);
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
		border-bottom: 1px solid var(--color-border);
	}

	.activity-item:last-child {
		border-bottom: none;
	}

	.activity-icon {
		width: 40px;
		height: 40px;
		border-radius: var(--radius-control, var(--radius-lg));
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
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.stat-icon.purple {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.stat-icon.pink {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.stat-icon.orange {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.activity-content {
		flex: 1;
	}

	.activity-text {
		font-size: 0.9375rem;
		color: var(--color-text);
	}

	.activity-text :global(strong) {
		font-weight: 600;
		color: var(--color-accent);
	}

	.activity-time {
		font-size: 0.8125rem;
		color: var(--color-text-subtle);
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
		background: var(--control-bg, var(--color-surface));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-lg));
		color: var(--color-text);
		font-size: 0.9375rem;
		font-weight: 500;
		text-decoration: none;
		transition: all var(--transition-fast);
	}

	.quick-action-btn:hover {
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
		border-color: var(--color-accent);
		color: var(--color-accent);
		transform: translateY(-2px);
	}

	.quick-action-btn :global(i) {
		width: 20px;
		height: 20px;
		color: var(--color-text-subtle);
		transition: color var(--transition-fast);
	}

	.quick-action-btn:hover :global(i) {
		color: var(--color-accent);
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
		.stats-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

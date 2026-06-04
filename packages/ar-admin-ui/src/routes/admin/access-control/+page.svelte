<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import { adminAccessControlAPI, type AccessControlStats } from '$lib/api/admin-access-control';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let stats: AccessControlStats | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let loadedTenantId = $state('');

	async function loadStats() {
		loading = true;
		error = '';
		try {
			stats = await adminAccessControlAPI.getStats();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_access_control_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		loadStats();
	});

	function navigateTo(path: string) {
		goto(path);
	}

	// Hub card data with links
	const hubCards = [
		{
			id: 'rbac',
			title: 'RBAC',
			subtitle: () => $LL.admin_access_control_rbac_subtitle(),
			description: () => $LL.admin_access_control_rbac_description(),
			icon: 'i-ph-shield-check',
			color: 'purple',
			href: '/admin/roles',
			statsKey: 'rbac' as const,
			statsLabel: (s: AccessControlStats) =>
				$LL.admin_access_control_rbac_stats({
					roles: s.rbac.total_roles,
					assignments: s.rbac.total_assignments
				})
		},
		{
			id: 'abac',
			title: 'ABAC',
			subtitle: () => $LL.admin_access_control_abac_subtitle(),
			description: () => $LL.admin_access_control_abac_description(),
			icon: 'i-ph-tag',
			color: 'green',
			href: '/admin/attributes',
			statsKey: 'abac' as const,
			statsLabel: (s: AccessControlStats) =>
				$LL.admin_access_control_abac_stats({
					attributes: s.abac.total_attributes,
					active: s.abac.active_attributes
				})
		},
		{
			id: 'rebac',
			title: 'ReBAC',
			subtitle: () => $LL.admin_access_control_rebac_subtitle(),
			description: () => $LL.admin_access_control_rebac_description(),
			icon: 'i-ph-graph',
			color: 'orange',
			href: '/admin/rebac',
			statsKey: 'rebac' as const,
			statsLabel: (s: AccessControlStats) =>
				$LL.admin_access_control_rebac_stats({
					definitions: s.rebac.total_definitions,
					tuples: s.rebac.total_tuples
				})
		}
	];
</script>

<svelte:head>
	<title>{$LL.admin_access_control_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Info Banner -->
	<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
		<div class="flex items-start">
			<span class="i-ph-info text-blue-600 text-xl mr-3 mt-0.5"></span>
			<div>
				<h3 class="font-semibold text-blue-900 mb-1">
					{$LL.admin_access_control_banner_title()}
				</h3>
				<p class="text-sm text-blue-800">
					{$LL.admin_access_control_banner()}
					<a href="/admin/admin-access-control" class="underline hover:text-blue-900"
						>{$LL.admin_access_control_admin_hub()}</a
					>.
				</p>
			</div>
		</div>
	</div>

	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_access_control_title()}</h1>
			<p class="page-description">{$LL.admin_access_control_description()}</p>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_access_control_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error" style="margin-bottom: 16px;">
			{error}
			<button class="btn btn-secondary btn-sm" onclick={() => location.reload()}>
				{$LL.admin_access_control_retry()}
			</button>
		</div>
	{:else if stats}
		<!-- Top Row: 3 Cards -->
		<div class="hub-cards-grid">
			{#each hubCards as card (card.id)}
				<button class="hub-card {card.color}" onclick={() => navigateTo(card.href)} type="button">
					<div class="hub-card-header">
						<div class="hub-card-icon {card.color}">
							<i class={card.icon}></i>
						</div>
						<div class="hub-card-titles">
							<h3 class="hub-card-title">{card.title}</h3>
							<span class="hub-card-subtitle">{card.subtitle()}</span>
						</div>
						<i class="i-ph-arrow-right hub-card-arrow"></i>
					</div>
					<p class="hub-card-description">{card.description()}</p>
					<div class="hub-card-stats">
						<i class="i-ph-chart-bar"></i>
						<span>{card.statsLabel(stats)}</span>
					</div>
				</button>
			{/each}
		</div>

		<!-- Bottom Row: Policies (Full Width) -->
		<button
			class="hub-card hub-card-wide blue"
			onclick={() => navigateTo('/admin/policies')}
			type="button"
		>
			<div class="hub-card-header">
				<div class="hub-card-icon blue">
					<i class="i-ph-scales"></i>
				</div>
				<div class="hub-card-titles">
					<h3 class="hub-card-title">{$LL.admin_access_control_policies_title()}</h3>
					<span class="hub-card-subtitle">{$LL.admin_access_control_policies_subtitle()}</span>
				</div>
				<i class="i-ph-arrow-right hub-card-arrow"></i>
			</div>
			<p class="hub-card-description">{$LL.admin_access_control_policies_description()}</p>
			<div class="hub-card-stats">
				<i class="i-ph-chart-bar"></i>
				<span>
					{$LL.admin_access_control_policies_stats({
						policies: stats.policies.total_policies,
						active: stats.policies.active_policies
					})}
				</span>
			</div>
		</button>

		<!-- Quick Links Section -->
		<div class="quick-links-section">
			<h2 class="section-title">{$LL.admin_access_control_related_tools()}</h2>
			<div class="quick-links-grid">
				<a href="/admin/access-trace" class="quick-link">
					<i class="i-ph-path"></i>
					<span>{$LL.admin_access_control_access_trace()}</span>
					<span class="quick-link-desc">{$LL.admin_access_control_access_trace_desc()}</span>
				</a>
				<a href="/admin/role-rules" class="quick-link">
					<i class="i-ph-git-branch"></i>
					<span>{$LL.admin_access_control_role_rules()}</span>
					<span class="quick-link-desc">{$LL.admin_access_control_role_rules_desc()}</span>
				</a>
			</div>
		</div>
	{/if}
</div>

<style>
	/* === Hub Cards Grid === */
	.hub-cards-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 20px;
		margin-bottom: 20px;
	}

	@media (max-width: 1200px) {
		.hub-cards-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (max-width: 768px) {
		.hub-cards-grid {
			grid-template-columns: 1fr;
		}
	}

	/* === Hub Card === */
	.hub-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 24px;
		background: var(--bg-secondary, var(--bg-card, #ffffff));
		border: 1px solid var(--border-primary, var(--border, #e5e7eb));
		border-radius: var(--radius-lg, 12px);
		cursor: pointer;
		transition: all var(--transition-fast, 0.2s ease);
		text-align: left;
		width: 100%;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.hub-card:hover {
		border-color: var(--border-hover, var(--primary, #2c2724));
		box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
		transform: translateY(-2px);
	}

	.hub-card.purple:hover {
		border-color: var(--purple);
	}

	.hub-card.green:hover {
		border-color: var(--success);
	}

	.hub-card.orange:hover {
		border-color: var(--warning);
	}

	.hub-card.blue:hover {
		border-color: var(--primary);
	}

	.hub-card-wide {
		margin-bottom: 32px;
	}

	/* === Card Header === */
	.hub-card-header {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.hub-card-icon {
		width: 48px;
		height: 48px;
		border-radius: var(--radius-md);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.hub-card-icon.purple {
		background: rgba(139, 92, 246, 0.15);
		color: var(--purple);
	}

	.hub-card-icon.green {
		background: rgba(34, 197, 94, 0.15);
		color: var(--success);
	}

	.hub-card-icon.orange {
		background: rgba(249, 115, 22, 0.15);
		color: var(--warning);
	}

	.hub-card-icon.blue {
		background: rgba(59, 130, 246, 0.15);
		color: var(--primary);
	}

	.hub-card-icon :global(i) {
		width: 24px;
		height: 24px;
	}

	.hub-card-titles {
		flex: 1;
		min-width: 0;
	}

	.hub-card-title {
		font-size: 1.125rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0;
		line-height: 1.3;
	}

	.hub-card-subtitle {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.hub-card-arrow {
		width: 20px;
		height: 20px;
		color: var(--text-tertiary);
		transition: transform var(--transition-fast);
	}

	.hub-card:hover .hub-card-arrow {
		transform: translateX(4px);
		color: var(--text-primary);
	}

	/* === Card Content === */
	.hub-card-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		line-height: 1.5;
		margin: 0;
	}

	.hub-card-stats {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8125rem;
		color: var(--text-tertiary, var(--text-secondary, #64748b));
		padding-top: 8px;
		border-top: 1px solid var(--border-primary, var(--border, #e5e7eb));
	}

	.hub-card-stats :global(i) {
		width: 16px;
		height: 16px;
	}

	/* === Quick Links Section === */
	.quick-links-section {
		margin-top: 16px;
	}

	.section-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 16px;
	}

	.quick-links-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 12px;
	}

	@media (max-width: 768px) {
		.quick-links-grid {
			grid-template-columns: 1fr;
		}
	}

	.quick-link {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px;
		background: var(--bg-secondary, var(--bg-card, #ffffff));
		border: 1px solid var(--border-primary, var(--border, #e5e7eb));
		border-radius: var(--radius-md, 8px);
		text-decoration: none;
		transition: all var(--transition-fast, 0.2s ease);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
	}

	.quick-link:hover {
		border-color: var(--border-hover, var(--primary, #2c2724));
		background: var(--bg-tertiary, var(--bg-hover, #f9fafb));
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
	}

	.quick-link :global(i:first-child) {
		width: 20px;
		height: 20px;
		color: var(--text-secondary);
	}

	.quick-link span:first-of-type {
		font-weight: 500;
		color: var(--text-primary);
	}

	.quick-link-desc {
		margin-left: auto;
		font-size: 0.8125rem;
		color: var(--text-tertiary, var(--text-secondary, #64748b));
	}

	/* === Dark Mode Support === */
	:global(.dark) .hub-card {
		background: var(--bg-secondary, #1e1e1e);
		border-color: var(--border-primary, #374151);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
	}

	:global(.dark) .hub-card:hover {
		border-color: var(--border-hover, #4b5563);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	}

	:global(.dark) .hub-card.purple:hover {
		border-color: rgba(139, 92, 246, 0.6);
	}

	:global(.dark) .hub-card.green:hover {
		border-color: rgba(34, 197, 94, 0.6);
	}

	:global(.dark) .hub-card.orange:hover {
		border-color: rgba(249, 115, 22, 0.6);
	}

	:global(.dark) .hub-card.blue:hover {
		border-color: rgba(59, 130, 246, 0.6);
	}

	:global(.dark) .hub-card-title {
		color: var(--text-primary, #f5f5f5);
	}

	:global(.dark) .hub-card-subtitle {
		color: var(--text-secondary, #a3a3a3);
	}

	:global(.dark) .hub-card-description {
		color: var(--text-secondary, #a3a3a3);
	}

	:global(.dark) .hub-card-stats {
		color: var(--text-tertiary, #737373);
		border-top-color: var(--border-primary, #374151);
	}

	:global(.dark) .hub-card-arrow {
		color: var(--text-tertiary, #737373);
	}

	:global(.dark) .hub-card:hover .hub-card-arrow {
		color: var(--text-primary, #f5f5f5);
	}

	:global(.dark) .quick-link {
		background: var(--bg-secondary, #1e1e1e);
		border-color: var(--border-primary, #374151);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
	}

	:global(.dark) .quick-link:hover {
		border-color: var(--border-hover, #4b5563);
		background: var(--bg-tertiary, #2a2a2a);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
	}

	:global(.dark) .quick-link span:first-of-type {
		color: var(--text-primary, #f5f5f5);
	}

	:global(.dark) .quick-link :global(i:first-child) {
		color: var(--text-secondary, #a3a3a3);
	}

	:global(.dark) .quick-link-desc {
		color: var(--text-tertiary, #737373);
	}

	:global(.dark) .section-title {
		color: var(--text-primary, #f5f5f5);
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminAdminAccessControlAPI,
		type AdminAccessControlStats
	} from '$lib/api/admin-admin-access-control';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let stats: AdminAccessControlStats | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	onMount(async () => {
		try {
			stats = await adminAdminAccessControlAPI.getStats();
		} catch {
			error = $LL.admin_admin_access_control_load_failed();
		} finally {
			loading = false;
		}
	});

	function navigateTo(path: string) {
		goto(path);
	}

	// Hub card data with links
	const hubCards = [
		{
			id: 'rbac',
			title: 'RBAC',
			subtitle: $LL.admin_admin_access_control_rbac_subtitle(),
			description: $LL.admin_admin_access_control_rbac_description(),
			icon: 'i-ph-shield-check',
			color: 'purple',
			href: '/admin/admin-rbac',
			statsKey: 'rbac' as const,
			statsLabel: (s: AdminAccessControlStats) =>
				$LL.admin_admin_access_control_rbac_stats({
					roles: s.rbac.total_roles,
					assignments: s.rbac.total_assignments
				})
		},
		{
			id: 'abac',
			title: 'ABAC',
			subtitle: $LL.admin_admin_access_control_abac_subtitle(),
			description: $LL.admin_admin_access_control_abac_description(),
			icon: 'i-ph-tag',
			color: 'green',
			href: '/admin/admin-abac',
			statsKey: 'abac' as const,
			statsLabel: (s: AdminAccessControlStats) =>
				$LL.admin_admin_access_control_abac_stats({
					attributes: s.abac.total_attributes,
					active: s.abac.active_attributes
				})
		},
		{
			id: 'rebac',
			title: 'ReBAC',
			subtitle: $LL.admin_admin_access_control_rebac_subtitle(),
			description: $LL.admin_admin_access_control_rebac_description(),
			icon: 'i-ph-graph',
			color: 'orange',
			href: '/admin/admin-rebac',
			statsKey: 'rebac' as const,
			statsLabel: (s: AdminAccessControlStats) =>
				$LL.admin_admin_access_control_rebac_stats({
					definitions: s.rebac.total_definitions,
					tuples: s.rebac.total_tuples
				})
		}
	];
</script>

<svelte:head>
	<title>{$LL.admin_admin_access_control_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_access_control_title()}
		description={$LL.admin_admin_access_control_description()}
	/>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_admin_access_control_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error alert--stacked">
			{error}
			<button class="btn btn-secondary btn-sm" onclick={() => location.reload()}>
				{$LL.admin_admin_access_control_retry()}
			</button>
		</div>
	{:else if stats}
		<!-- Top Row: 3 Cards -->
		<AdminSection>
			<div class="hub-cards-grid">
				{#each hubCards as card (card.id)}
					<button class="hub-card {card.color}" onclick={() => navigateTo(card.href)} type="button">
						<div class="hub-card-header">
							<div class="hub-card-icon {card.color}">
								<i class={card.icon}></i>
							</div>
							<div class="hub-card-titles">
								<h3 class="hub-card-title">{card.title}</h3>
								<span class="hub-card-subtitle">{card.subtitle}</span>
							</div>
							<i class="i-ph-arrow-right hub-card-arrow"></i>
						</div>
						<p class="hub-card-description">{card.description}</p>
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
				onclick={() => navigateTo('/admin/admin-policies')}
				type="button"
			>
				<div class="hub-card-header">
					<div class="hub-card-icon blue">
						<i class="i-ph-scales"></i>
					</div>
					<div class="hub-card-titles">
						<h3 class="hub-card-title">{$LL.admin_admin_access_control_policies_title()}</h3>
						<span class="hub-card-subtitle"
							>{$LL.admin_admin_access_control_policies_subtitle()}</span
						>
					</div>
					<i class="i-ph-arrow-right hub-card-arrow"></i>
				</div>
				<p class="hub-card-description">
					{$LL.admin_admin_access_control_policies_description()}
				</p>
				<div class="hub-card-stats">
					<i class="i-ph-chart-bar"></i>
					<span
						>{$LL.admin_admin_access_control_policies_stats({
							policies: stats.policies.total_policies,
							active: stats.policies.active_policies
						})}</span
					>
				</div>
			</button>
		</AdminSection>

		<!-- Quick Links Section -->
		<AdminSection title={$LL.admin_admin_access_control_related_tools()}>
			<div class="quick-links-grid">
				<a href="/admin/admin-audit" class="quick-link">
					<i class="i-ph-clipboard-text"></i>
					<span>{$LL.admin_admin_access_control_admin_audit_log()}</span>
					<span class="quick-link-desc"
						>{$LL.admin_admin_access_control_admin_audit_log_desc()}</span
					>
				</a>
				<a href="/admin/ip-allowlist" class="quick-link">
					<i class="i-ph-shield-check"></i>
					<span>{$LL.admin_admin_access_control_ip_allowlist()}</span>
					<span class="quick-link-desc">{$LL.admin_admin_access_control_ip_allowlist_desc()}</span>
				</a>
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	/* === Hub Cards Grid === */
	.hub-cards-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 20px;
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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		cursor: pointer;
		transition: all var(--transition-fast);
		text-align: left;
		width: 100%;
		box-shadow: var(--card-shadow, var(--shadow-sm));
	}

	.hub-card:hover {
		border-color: var(--color-accent);
		box-shadow: var(--shadow-md);
		transform: translateY(-2px);
	}

	.hub-card.purple:hover {
		border-color: var(--color-accent);
	}

	.hub-card.green:hover {
		border-color: var(--color-success);
	}

	.hub-card.orange:hover {
		border-color: var(--color-warning);
	}

	.hub-card.blue:hover {
		border-color: var(--color-accent);
	}

	.hub-card-wide {
		margin-top: 20px;
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
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.hub-card-icon.green {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.hub-card-icon.orange {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.hub-card-icon.blue {
		background: var(--color-accent-muted);
		color: var(--color-accent);
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
		color: var(--color-text);
		margin: 0;
		line-height: 1.3;
	}

	.hub-card-subtitle {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.hub-card-arrow {
		width: 20px;
		height: 20px;
		color: var(--color-text-subtle);
		transition: transform var(--transition-fast);
	}

	.hub-card:hover .hub-card-arrow {
		transform: translateX(4px);
		color: var(--color-text);
	}

	/* === Card Content === */
	.hub-card-description {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		line-height: 1.5;
		margin: 0;
	}

	.hub-card-stats {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8125rem;
		color: var(--color-text-subtle);
		padding-top: 8px;
		border-top: 1px solid var(--color-border);
	}

	.hub-card-stats :global(i) {
		width: 16px;
		height: 16px;
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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		text-decoration: none;
		transition: all var(--transition-fast);
		box-shadow: var(--card-shadow, var(--shadow-sm));
	}

	.quick-link:hover {
		border-color: var(--color-accent);
		background: var(--color-surface-muted);
		box-shadow: var(--shadow-md);
	}

	.quick-link :global(i:first-child) {
		width: 20px;
		height: 20px;
		color: var(--color-text-muted);
	}

	.quick-link span:first-of-type {
		font-weight: 500;
		color: var(--color-text);
	}

	.quick-link-desc {
		margin-left: auto;
		font-size: 0.8125rem;
		color: var(--color-text-subtle);
	}

	.alert--stacked {
		margin-bottom: 16px;
	}
</style>

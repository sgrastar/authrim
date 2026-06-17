<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import { adminAccessControlAPI, type AccessControlStats } from '$lib/api/admin-access-control';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

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

<AdminPageShell>
	<!-- Info Banner -->
	<div class="info-banner">
		<div class="info-banner__content">
			<span class="i-ph-info info-banner__icon" aria-hidden="true"></span>
			<div>
				<h3 class="info-banner__title">
					{$LL.admin_access_control_banner_title()}
				</h3>
				<p class="info-banner__text">
					{$LL.admin_access_control_banner()}
					<a href="/admin/admin-access-control">{$LL.admin_access_control_admin_hub()}</a>.
				</p>
			</div>
		</div>
	</div>

	<!-- Page Header -->
	<AdminPageHeader
		title={$LL.admin_access_control_title()}
		description={$LL.admin_access_control_description()}
	/>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_access_control_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error access-error">
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
		<AdminSection title={$LL.admin_access_control_related_tools()}>
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
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.info-banner {
		margin-bottom: 18px;
		border: 1px solid color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
		border-radius: var(--radius-panel);
		padding: 16px;
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
	}

	.info-banner__content {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.info-banner__icon {
		flex: 0 0 auto;
		color: var(--color-accent);
		font-size: 1.25rem;
	}

	.info-banner__title {
		margin: 0 0 4px;
		color: var(--color-text);
		font-size: 0.95rem;
		font-weight: 700;
	}

	.info-banner__text {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.88rem;
		line-height: 1.6;
	}

	.access-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 16px;
	}

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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		color: var(--color-text);
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast),
			transform var(--transition-fast);
		text-align: left;
		width: 100%;
		box-shadow: var(--shadow-sm);
	}

	.hub-card:hover {
		border-color: var(--hub-accent, var(--color-accent));
		box-shadow: var(--shadow-md);
		transform: translateY(-2px);
	}

	.hub-card.purple {
		--hub-accent: var(--purple);
	}

	.hub-card.green {
		--hub-accent: var(--color-success);
	}

	.hub-card.orange {
		--hub-accent: var(--color-warning);
	}

	.hub-card.blue {
		--hub-accent: var(--color-accent);
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
		border-radius: var(--radius-control);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--hub-accent, var(--color-accent)) 14%, transparent);
		color: var(--hub-accent, var(--color-accent));
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
		color: var(--hub-accent, var(--color-accent));
	}

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
		border-radius: var(--radius-panel);
		text-decoration: none;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			box-shadow var(--transition-fast);
		box-shadow: var(--shadow-sm);
	}

	.quick-link:hover {
		border-color: var(--color-accent);
		background: var(--color-surface-raised);
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
</style>

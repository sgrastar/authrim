<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { adminAccessControlAPI, type AccessControlStats } from '$lib/api/admin-access-control';

	let stats: AccessControlStats | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	onMount(async () => {
		try {
			stats = await adminAccessControlAPI.getStats();
		} catch (err) {
			console.error('Failed to load access control stats:', err);
			error = 'Failed to load access control statistics';
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
			subtitle: 'Roles',
			description: 'Manage user roles and permissions through role-based access control.',
			icon: 'i-ph-shield-check',
			color: 'purple',
			href: '/admin/roles',
			statsKey: 'rbac' as const,
			statsLabel: (s: AccessControlStats) =>
				`${s.rbac.total_roles} roles, ${s.rbac.total_assignments} assignments`
		},
		{
			id: 'abac',
			title: 'ABAC',
			subtitle: 'Attributes',
			description: 'Define and manage user attributes for attribute-based access control.',
			icon: 'i-ph-tag',
			color: 'green',
			href: '/admin/attributes',
			statsKey: 'abac' as const,
			statsLabel: (s: AccessControlStats) =>
				`${s.abac.total_attributes} attributes (${s.abac.active_attributes} active)`
		},
		{
			id: 'rebac',
			title: 'ReBAC',
			subtitle: 'Relations',
			description: 'Model complex relationships between entities for fine-grained access.',
			icon: 'i-ph-graph',
			color: 'orange',
			href: '/admin/rebac',
			statsKey: 'rebac' as const,
			statsLabel: (s: AccessControlStats) =>
				`${s.rebac.total_definitions} definitions, ${s.rebac.total_tuples} tuples`
		}
	];
</script>

<svelte:head>
	<title>Access Control Hub - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Access Control Hub</h1>
			<p class="page-description">
				Unified management for RBAC, ABAC, ReBAC, and Policy-based access control.
			</p>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading access control statistics...</p>
		</div>
	{:else if error}
		<div class="alert alert-error" style="margin-bottom: 16px;">
			{error}
			<button class="btn btn-secondary btn-sm" onclick={() => location.reload()}>Retry</button>
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
			onclick={() => navigateTo('/admin/policies')}
			type="button"
		>
			<div class="hub-card-header">
				<div class="hub-card-icon blue">
					<i class="i-ph-scales"></i>
				</div>
				<div class="hub-card-titles">
					<h3 class="hub-card-title">Policies</h3>
					<span class="hub-card-subtitle">Combined Rules</span>
				</div>
				<i class="i-ph-arrow-right hub-card-arrow"></i>
			</div>
			<p class="hub-card-description">
				Combine RBAC, ABAC, and ReBAC conditions to create fine-grained access control policies.
				Define complex rules that evaluate multiple factors to determine access decisions.
			</p>
			<div class="hub-card-stats">
				<i class="i-ph-chart-bar"></i>
				<span
					>{stats.policies.total_policies} policies ({stats.policies.active_policies} active)</span
				>
			</div>
		</button>

		<!-- Quick Links Section -->
		<div class="quick-links-section">
			<h2 class="section-title">Related Tools</h2>
			<div class="quick-links-grid">
				<a href="/admin/access-trace" class="quick-link">
					<i class="i-ph-path"></i>
					<span>Access Trace</span>
					<span class="quick-link-desc">Debug access decisions</span>
				</a>
				<a href="/admin/role-rules" class="quick-link">
					<i class="i-ph-git-branch"></i>
					<span>Role Assignment Rules</span>
					<span class="quick-link-desc">Automatic role assignment</span>
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
		background: var(--bg-secondary);
		border: 1px solid var(--border-primary);
		border-radius: var(--radius-lg);
		cursor: pointer;
		transition: all var(--transition-fast);
		text-align: left;
		width: 100%;
	}

	.hub-card:hover {
		border-color: var(--border-hover);
		box-shadow: var(--shadow-md);
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
		color: var(--text-tertiary);
		padding-top: 8px;
		border-top: 1px solid var(--border-primary);
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
		background: var(--bg-secondary);
		border: 1px solid var(--border-primary);
		border-radius: var(--radius-md);
		text-decoration: none;
		transition: all var(--transition-fast);
	}

	.quick-link:hover {
		border-color: var(--border-hover);
		background: var(--bg-tertiary);
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
		color: var(--text-tertiary);
	}
</style>

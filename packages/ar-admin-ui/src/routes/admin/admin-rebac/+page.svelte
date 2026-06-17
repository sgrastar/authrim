<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminRebacAPI } from '$lib/api/admin-admin-rebac';
	import type { AdminRebacDefinition, AdminRelationship } from '$lib/api/admin-admin-rebac';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let definitions: AdminRebacDefinition[] = [];
	let relationships: AdminRelationship[] = [];
	let loading = true;
	let error = '';

	async function loadData() {
		loading = true;
		error = '';
		try {
			const [defsResponse, relsResponse] = await Promise.all([
				adminAdminRebacAPI.listDefinitions({ include_system: true, limit: 10 }),
				adminAdminRebacAPI.listRelationships({ limit: 10 })
			]);
			definitions = defsResponse.items;
			relationships = relsResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_rebac_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadData();
	});
</script>

<svelte:head>
	<title>{$LL.admin_admin_rebac_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_rebac_title()}
		description={$LL.admin_admin_rebac_description()}
	/>

	{#if error}
		<div class="alert alert-error">
			{error}
		</div>
	{/if}

	<AdminSection>
		<div class="nav-card-grid">
			<a href="/admin/admin-rebac/definitions" class="nav-card nav-card--purple">
				<div class="nav-card__header">
					<span class="nav-card__icon i-ph-arrows-split"></span>
					<div class="nav-card__titles">
						<h2>{$LL.admin_admin_rebac_definitions_title()}</h2>
						<p>{$LL.admin_admin_rebac_definitions_subtitle()}</p>
					</div>
					<span class="nav-card__arrow i-ph-arrow-right"></span>
				</div>
				<div class="nav-card__metric">
					{#if loading}
						<span class="nav-card__loading">{$LL.admin_admin_rebac_loading()}</span>
					{:else}
						<strong>{definitions.length}</strong>
						<span>{$LL.admin_admin_rebac_total_definitions()}</span>
					{/if}
				</div>
			</a>

			<a href="/admin/admin-rebac/tuples" class="nav-card nav-card--blue">
				<div class="nav-card__header">
					<span class="nav-card__icon i-ph-link"></span>
					<div class="nav-card__titles">
						<h2>{$LL.admin_admin_rebac_tuples_title()}</h2>
						<p>{$LL.admin_admin_rebac_tuples_subtitle()}</p>
					</div>
					<span class="nav-card__arrow i-ph-arrow-right"></span>
				</div>
				<div class="nav-card__metric">
					{#if loading}
						<span class="nav-card__loading">{$LL.admin_admin_rebac_loading()}</span>
					{:else}
						<strong>{relationships.length}</strong>
						<span>{$LL.admin_admin_rebac_active_relationships()}</span>
					{/if}
				</div>
			</a>
		</div>
	</AdminSection>

	<AdminSection title={$LL.admin_admin_rebac_overview_title()}>
		<div class="overview-panel">
			<p>{$LL.admin_admin_rebac_overview_description()}</p>
			<div class="overview-grid">
				<div class="overview-item">
					<h3>
						<span class="i-ph-arrows-split"></span>
						{$LL.admin_admin_rebac_overview_definitions_title()}
					</h3>
					<p>{$LL.admin_admin_rebac_overview_definitions_description()}</p>
				</div>
				<div class="overview-item">
					<h3>
						<span class="i-ph-link"></span>
						{$LL.admin_admin_rebac_overview_tuples_title()}
					</h3>
					<p>{$LL.admin_admin_rebac_overview_tuples_description()}</p>
				</div>
			</div>
		</div>
	</AdminSection>

	{#if !loading && definitions.length > 0}
		<AdminSection title={$LL.admin_admin_rebac_recent_definitions()}>
			{#snippet actions()}
				<a href="/admin/admin-rebac/definitions" class="section-link">
					{$LL.admin_admin_rebac_view_all()}
					<span class="i-ph-arrow-right"></span>
				</a>
			{/snippet}
			<div class="preview-list">
				{#each definitions.slice(0, 5) as definition (definition.id)}
					<div class="preview-row">
						<div>
							<div class="preview-row__mono">{definition.relation_name}</div>
							{#if definition.display_name}
								<div class="preview-row__sub">{definition.display_name}</div>
							{/if}
						</div>
						<div class="preview-row__meta">
							{#if definition.is_system}
								<span class="mini-badge">{$LL.admin_admin_rebac_system()}</span>
							{/if}
							<span>{$LL.admin_admin_rebac_priority({ priority: definition.priority })}</span>
						</div>
					</div>
				{/each}
			</div>
		</AdminSection>
	{/if}

	{#if !loading && relationships.length > 0}
		<AdminSection title={$LL.admin_admin_rebac_recent_relationships()}>
			{#snippet actions()}
				<a href="/admin/admin-rebac/tuples" class="section-link">
					{$LL.admin_admin_rebac_view_all()}
					<span class="i-ph-arrow-right"></span>
				</a>
			{/snippet}
			<div class="preview-list">
				{#each relationships.slice(0, 5) as relationship (relationship.id)}
					<div class="preview-row">
						<div class="relationship-expression">
							<span class="relationship-expression__from">{relationship.from_id}</span>
							<span class="relationship-expression__type">{relationship.relationship_type}</span>
							<span class="relationship-expression__to">{relationship.to_id}</span>
						</div>
						<div class="preview-row__meta">
							{#if relationship.permission_level}
								<span class="mini-badge mini-badge--accent">{relationship.permission_level}</span>
							{/if}
							{#if relationship.is_transitive}
								<span class="mini-badge">{$LL.admin_admin_rebac_transitive()}</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.alert {
		display: flex;
		align-items: center;
		margin-bottom: 18px;
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		color: var(--color-danger);
	}

	.nav-card-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
	}

	.nav-card {
		display: grid;
		gap: 24px;
		min-height: 190px;
		padding: 22px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-sm));
		color: var(--color-text);
		text-decoration: none;
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast),
			transform var(--transition-fast);
	}

	.nav-card:hover {
		border-color: var(--color-accent);
		box-shadow: var(--shadow-md);
		transform: translateY(-2px);
	}

	.nav-card__header {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 14px;
		align-items: start;
	}

	.nav-card__icon {
		display: grid;
		width: 48px;
		height: 48px;
		place-items: center;
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--card-accent, var(--color-accent)) 16%, transparent);
		color: var(--card-accent, var(--color-accent));
		font-size: 1.6rem;
	}

	.nav-card--purple {
		--card-accent: var(--purple);
	}

	.nav-card--blue {
		--card-accent: var(--color-accent);
	}

	.nav-card__titles h2 {
		margin: 0;
		color: var(--color-text);
		font-size: 1.1rem;
		line-height: 1.3;
	}

	.nav-card__titles p {
		margin: 3px 0 0;
		color: var(--color-text-muted);
		font-size: 0.85rem;
	}

	.nav-card__arrow {
		color: var(--color-text-subtle);
		font-size: 1.25rem;
		transition: transform var(--transition-fast);
	}

	.nav-card:hover .nav-card__arrow {
		transform: translateX(4px);
		color: var(--color-text);
	}

	.nav-card__metric {
		align-self: end;
		display: grid;
		gap: 2px;
		padding-top: 14px;
		border-top: 1px solid var(--color-border);
	}

	.nav-card__metric strong {
		color: var(--card-accent, var(--color-accent));
		font-size: 2rem;
		line-height: 1.1;
	}

	.nav-card__metric span {
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.nav-card__loading {
		color: var(--color-text-muted);
	}

	.overview-panel {
		padding: 22px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-sm));
	}

	.overview-panel > p {
		margin: 0 0 18px;
		color: var(--color-text-muted);
		line-height: 1.75;
	}

	.overview-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.overview-item {
		padding: 16px;
		border: 1px solid var(--color-border-muted);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
	}

	.overview-item h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		color: var(--color-text);
		font-size: 0.95rem;
	}

	.overview-item p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
		line-height: 1.7;
	}

	.section-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--color-accent);
		font-size: 0.86rem;
		font-weight: 600;
		text-decoration: none;
	}

	.preview-list {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-sm));
		overflow: hidden;
	}

	.preview-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		padding: 13px 16px;
		border-bottom: 1px solid var(--color-border-muted);
	}

	.preview-row:last-child {
		border-bottom: 0;
	}

	.preview-row__mono,
	.relationship-expression {
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.84rem;
	}

	.preview-row__sub,
	.preview-row__meta {
		color: var(--color-text-muted);
		font-size: 0.76rem;
	}

	.preview-row__meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.mini-badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.mini-badge--accent {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
	}

	.relationship-expression {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.relationship-expression__from {
		color: var(--color-accent);
	}

	.relationship-expression__type {
		color: var(--color-text-subtle);
	}

	.relationship-expression__to {
		color: var(--purple, var(--color-text));
	}

	@media (max-width: 820px) {
		.nav-card-grid,
		.overview-grid {
			grid-template-columns: 1fr;
		}

		.preview-row {
			align-items: flex-start;
			flex-direction: column;
		}

		.preview-row__meta {
			justify-content: flex-start;
		}
	}
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';

	type HierarchyLevel = 'tenant' | 'system' | 'client' | 'compliance';

	interface Props {
		label?: string;
		level?: HierarchyLevel;
		tenantName?: string;
		children: Snippet;
	}

	let { label, level = 'tenant', tenantName, children }: Props = $props();
</script>

<div class="nav-section" data-level={level}>
	{#if label || tenantName}
		<div class="nav-section-header">
			<span class="section-indicator"></span>
			{#if tenantName}
				<span class="current-tenant-name">{tenantName}</span>
			{:else}
				{label}
			{/if}
		</div>
	{/if}

	{@render children()}
</div>

<style>
	.nav-section {
		margin-bottom: 16px;
	}

	.nav-section[data-level='system'] {
		border-top: 1px solid var(--nav-border);
		padding-top: 16px;
		margin-top: 12px;
	}

	.nav-section-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px;
		font-size: 0.625rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--text-muted);
		min-height: 30px;
	}

	/* Section indicator dot */
	.section-indicator {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.nav-section[data-level='system'] .section-indicator {
		background: var(--system-color);
	}

	.nav-section[data-level='tenant'] .section-indicator {
		background: var(--tenant-color);
	}

	.nav-section[data-level='client'] .section-indicator {
		background: var(--client-color);
	}

	.nav-section[data-level='compliance'] .section-indicator {
		background: var(--compliance-color);
	}

	/* Tenant name styling */
	.current-tenant-name {
		font-size: 0.875rem;
		font-weight: 700;
		color: #ffffff;
		text-transform: none;
		letter-spacing: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	/* Global visibility control - handled by parent */
	:global(.nav-floating:not(.expanded):not(.open)) .nav-section-header {
		opacity: 0;
	}

	:global(.nav-floating.expanded) .nav-section-header,
	:global(.nav-floating.open) .nav-section-header {
		opacity: 1;
	}
</style>

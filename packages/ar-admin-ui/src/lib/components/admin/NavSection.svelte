<script lang="ts">
	import type { Snippet } from 'svelte';

	type HierarchyLevel = 'enduser' | 'client' | 'tenant' | 'platform';

	interface Props {
		label?: string;
		level?: HierarchyLevel;
		children: Snippet;
	}

	let { label, level = 'enduser', children }: Props = $props();
</script>

<div class="nav-section" data-level={level}>
	{#if label}
		<div class="nav-section-header">
			{label}
		</div>
	{/if}

	{@render children()}
</div>

<style>
	.nav-section {
		margin-bottom: 4px;
	}

	/* Section header with left accent bar */
	.nav-section-header {
		display: flex;
		align-items: center;
		margin-top: 12px;
		padding: 5px 12px 5px 10px;
		font-size: 0.625rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		min-height: 26px;
		margin-bottom: 4px;
		border-left: 2px solid transparent;
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	}

	/* Level-specific accent colors */
	.nav-section[data-level='enduser'] .nav-section-header {
		border-left-color: var(--level-enduser-color);
		color: var(--level-enduser-color);
	}

	.nav-section[data-level='client'] .nav-section-header {
		border-left-color: var(--level-client-color);
		color: var(--level-client-color);
	}

	.nav-section[data-level='tenant'] .nav-section-header {
		border-left-color: var(--level-tenant-color);
		color: var(--level-tenant-color);
	}

	.nav-section[data-level='platform'] .nav-section-header {
		border-left-color: var(--level-platform-color);
		color: var(--level-platform-color);
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

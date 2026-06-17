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
		margin-bottom: var(--nav-section-gap, 4px);
	}

	/* Section header with left accent bar */
	.nav-section-header {
		display: flex;
		align-items: center;
		margin-top: var(--nav-section-margin-top, 18px);
		padding: var(--nav-section-header-padding, 5px 20px);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--nav-section-font-size, 0.68rem);
		font-weight: var(--nav-section-font-weight, 700);
		text-transform: uppercase;
		letter-spacing: var(--nav-section-letter-spacing, 0.12em);
		min-height: 26px;
		margin-bottom: 4px;
		border-left: var(--nav-section-border-width, 0) solid transparent;
		border-radius: var(--nav-section-radius, 0);
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
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		children: Snippet;
		header?: Snippet;
		footer?: Snippet;
		hoverable?: boolean;
		noPadding?: boolean;
	}

	let {
		children,
		header,
		footer,
		hoverable = false,
		noPadding = false,
		class: className = '',
		...restProps
	}: Props = $props();
</script>

<div class="card {className}" class:hoverable class:no-padding={noPadding} {...restProps}>
	{#if header}
		<div class="card-header">
			{@render header()}
		</div>
	{/if}

	<div class="card-body">
		{@render children()}
	</div>

	{#if footer}
		<div class="card-footer">
			{@render footer()}
		</div>
	{/if}
</div>

<style>
	/* The --card-* and --surface-* properties are unset (so the fallbacks apply) except where a
	   page asks for flat, still surfaces: the account page (AccountShell) sets them. */
	.card {
		background: var(--card-surface, var(--bg-card));
		backdrop-filter: var(--surface-backdrop-filter, var(--blur-sm));
		-webkit-backdrop-filter: var(--surface-backdrop-filter, var(--blur-sm));
		border-radius: var(--card-radius, var(--radius-xl));
		border: 1px solid var(--border-glass);
		box-shadow: var(--card-shadow, var(--shadow-sm));
		transition: var(--surface-transition, all var(--transition-base));
		overflow: hidden;
	}

	.card.hoverable:hover {
		box-shadow: var(--card-shadow, var(--shadow-md));
		transform: var(--surface-hover-transform, translateY(-4px));
	}

	.card-header {
		padding: 24px;
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.card-body {
		padding: var(--auth-card-padding, var(--card-padding, 24px));
	}

	.card.no-padding .card-body {
		padding: 0;
	}

	.card-footer {
		padding: 16px 24px;
		border-top: 1px solid var(--border);
		background: rgba(51, 51, 51, 0.02);
	}

	/* Header title styling */
	.card-header :global(h2),
	.card-header :global(h3),
	.card-header :global(.card-title) {
		font-size: 1.125rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0;
	}
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string;
		description?: string;
		/** Heading level for the title; defaults to h2 inside a page. */
		level?: 2 | 3;
		/** Body without padding (tables, lists that draw their own rows). */
		flush?: boolean;
		tone?: 'default' | 'warning';
		actions?: Snippet;
		footer?: Snippet;
		children: Snippet;
	}

	let {
		title,
		description,
		level = 2,
		flush = false,
		tone = 'default',
		actions,
		footer,
		children
	}: Props = $props();
</script>

<section class="card card--{tone}">
	{#if title || actions}
		<header class="card__head">
			<div class="card__titles">
				{#if title}
					<svelte:element this={`h${level}`} class="card__title">{title}</svelte:element>
				{/if}
				{#if description}<p class="card__desc">{description}</p>{/if}
			</div>
			{#if actions}<div class="card__actions">{@render actions()}</div>{/if}
		</header>
	{/if}
	<div class="card__body" class:card__body--flush={flush}>
		{@render children()}
	</div>
	{#if footer}<footer class="card__foot">{@render footer()}</footer>{/if}
</section>

<style>
	/* Every panel is drawn through the material tokens so translucent themes work unchanged. */
	.card {
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--surface-bg);
		-webkit-backdrop-filter: var(--surface-backdrop);
		backdrop-filter: var(--surface-backdrop);
		box-shadow: var(--shadow-sm), var(--surface-highlight);
	}

	.card--warning {
		border-color: color-mix(in srgb, var(--warning) 35%, var(--border));
	}

	.card--warning .card__head {
		border-bottom-color: color-mix(in srgb, var(--warning) 22%, transparent);
		background: var(--warning-bg);
	}

	.card--warning .card__title {
		color: var(--warning-text);
	}

	.card__head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: var(--box-head-pad-y) var(--box-pad);
		border-bottom: 1px solid var(--border-subtle);
	}

	.card__titles {
		min-width: 0;
		flex: 1;
	}

	.card__title {
		margin: 0;
		font-size: var(--fs-heading);
		font-weight: var(--fw-semibold);
	}

	.card__desc {
		margin: 2px 0 0;
		font-size: var(--fs-label);
		color: var(--text-secondary);
	}

	.card__actions {
		display: flex;
		flex-shrink: 0;
		gap: 8px;
	}

	.card__body {
		padding: var(--box-pad);
	}

	.card__body--flush {
		padding: 0;
	}

	.card__foot {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: var(--box-foot-pad-y) var(--box-pad);
		border-top: 1px solid var(--border-subtle);
		background: var(--bg-subtle);
		font-size: var(--fs-label);
		color: var(--text-secondary);
	}
</style>

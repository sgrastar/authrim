<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		/** Right-aligned primary actions (create, invite). At most one primary button. */
		actions?: Snippet;
		/** Small context line above the title (e.g. the platform-scope badge). */
		eyebrow?: Snippet;
	}

	let { title, description, actions, eyebrow }: Props = $props();
</script>

<header class="page-head">
	{#if eyebrow}<div class="page-head__eyebrow">{@render eyebrow()}</div>{/if}
	<div class="page-head__row">
		<div class="page-head__text">
			<h1>{title}</h1>
			{#if description}<p>{description}</p>{/if}
		</div>
		{#if actions}<div class="page-head__actions">{@render actions()}</div>{/if}
	</div>
</header>

<style>
	.page-head {
		margin-bottom: var(--space-page-header);
	}

	.page-head__eyebrow {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 6px;
		font-size: var(--fs-small);
		color: var(--text-muted);
	}

	.page-head__row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 10px 16px;
	}

	.page-head__text {
		min-width: 0;
		flex: 1 1 320px;
	}

	h1 {
		margin: 0;
		font-size: var(--fs-page-title);
		font-weight: var(--heading-weight);
		letter-spacing: var(--heading-tracking);
		overflow-wrap: anywhere;
	}

	p {
		max-width: 62ch;
		margin: 6px 0 0;
		font-size: var(--fs-control);
		color: var(--text-secondary);
	}

	.page-head__actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-inline-start: auto;
	}
</style>

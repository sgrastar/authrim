<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Where things go: what leads back (to the list, to the parent) is a BackLink in `back`, above
	 * everything at the top start; what acts or moves on is in `actions`, at the top end.
	 */
	interface Props {
		title: string;
		description?: string;
		/** The way back, at the top start, above the context line and the title. */
		back?: Snippet;
		/** End-aligned primary actions (create, invite). At most one primary button. */
		actions?: Snippet;
		/** Small context line above the title (e.g. the platform-scope badge). */
		eyebrow?: Snippet;
		/** What the page is, as badges at the top end of the title row (its kind, its status). */
		badges?: Snippet;
		/** The title element, so a page that replaces what was on screen can move focus to it. */
		titleElement?: HTMLHeadingElement | null;
	}

	let {
		title,
		description,
		back,
		actions,
		eyebrow,
		badges,
		titleElement = $bindable(null)
	}: Props = $props();
</script>

<header class="page-head">
	{#if back}<div class="page-head__back">{@render back()}</div>{/if}
	{#if eyebrow}<div class="page-head__eyebrow">{@render eyebrow()}</div>{/if}
	<div class="page-head__row">
		<div class="page-head__text">
			<h1 bind:this={titleElement} tabindex="-1">{title}</h1>
			{#if description}<p>{description}</p>{/if}
		</div>
		{#if badges || actions}
			<div class="page-head__aside">
				{#if badges}<div class="page-head__badges">{@render badges()}</div>{/if}
				{#if actions}<div class="page-head__actions">{@render actions()}</div>{/if}
			</div>
		{/if}
	</div>
</header>

<style>
	.page-head {
		margin-bottom: var(--space-page-header);
	}

	.page-head__back {
		display: flex;
		margin-bottom: var(--space-back);
	}

	.page-head__eyebrow {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 6px;
		font-size: var(--fs-small);
		color: var(--text-muted);
	}

	/* The top end of the title row: the page's status, then its actions. One block, so when it
	   wraps under a long title it still sits at the end and wraps inside itself. */
	.page-head__aside {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: flex-end;
		gap: 8px 16px;
		margin-inline-start: auto;
	}

	/* Level with the first line of the title. */
	.page-head__badges {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		min-height: calc(var(--fs-page-title) * 1.35);
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
		/* Focused by the page that replaces the one before; it is not a control. */
		outline: none;
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
	}
</style>

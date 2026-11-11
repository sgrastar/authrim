<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The head of a panel or box that has a way back (a setting that returns to its overview):
	 * the BackLink in `back`, then the title. Same order and the same room under the back link
	 * (`--space-back`) as PageHeader, one level down: an h2 inside a page. Like PageHeader, a small
	 * action can sit beside the title (`titleAction`, such as editing it) and an editor can take its
	 * place while it is edited (`titleEditor`; the heading stays for screen readers).
	 */
	interface Props {
		title: string;
		/** The way back, above the title. */
		back?: Snippet;
		/** Heading level of the title; an h2 inside a page. */
		level?: 2 | 3;
		/** A small action beside the title, such as editing it. */
		titleAction?: Snippet;
		/** Replaces the visible title while it is edited. */
		titleEditor?: Snippet;
	}

	let { title, back, level = 2, titleAction, titleEditor }: Props = $props();
</script>

<div class="panel-head">
	{#if back}<div class="panel-head__back">{@render back()}</div>{/if}
	{#if titleEditor}
		<svelte:element this={`h${level}`} class="sr-only">{title}</svelte:element>
		{@render titleEditor()}
	{:else if titleAction}
		<div class="panel-head__title-inline">
			<svelte:element this={`h${level}`} class="panel-head__title">{title}</svelte:element>
			{@render titleAction()}
		</div>
	{:else}
		<svelte:element this={`h${level}`} class="panel-head__title">{title}</svelte:element>
	{/if}
</div>

<style>
	.panel-head {
		padding: 16px 24px 0;
	}

	.panel-head__back {
		display: flex;
		margin-bottom: var(--space-back);
	}

	.panel-head__title-inline {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.panel-head__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-tight);
	}
</style>

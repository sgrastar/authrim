<script lang="ts">
	/**
	 * The frame every account widget shares: a heading at `headingLevel`, an optional refresh
	 * button, the error with a re-authentication action, and the widget's body.
	 *
	 * At heading level 2 the widget is a card of its own; at level 3 it sits unframed inside a
	 * parent panel that owns the card.
	 */
	import type { Snippet } from 'svelte';
	import { Button, Card } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import type { AccountWidgetHeadingLevel } from './types';

	let {
		title,
		headingLevel = 2,
		busy = false,
		refreshing = false,
		error = '',
		reauthNeeded = false,
		onRefresh,
		onReauthenticate,
		headingAside,
		children
	}: {
		title: string;
		headingLevel?: AccountWidgetHeadingLevel;
		/** First load: aria-busy on the region, and the refresh button waits for it. */
		busy?: boolean;
		refreshing?: boolean;
		error?: string;
		reauthNeeded?: boolean;
		onRefresh?: () => void;
		onReauthenticate?: () => void;
		/** Drawn at the end of the heading row, e.g. a count; next to the refresh button if both. */
		headingAside?: Snippet;
		children: Snippet;
	} = $props();

	const headingId = $props.id();
	const framed = $derived(headingLevel === 2);
</script>

{#snippet panel()}
	<section
		class="widget-panel"
		class:embedded={!framed}
		aria-labelledby={headingId}
		aria-busy={busy || refreshing}
	>
		<div class="widget-heading">
			<svelte:element this={`h${headingLevel}`} id={headingId}>{title}</svelte:element>
			{#if headingAside}
				<span class="widget-heading-aside">{@render headingAside()}</span>
			{/if}
			{#if onRefresh}
				<Button variant="ghost" size="sm" loading={busy || refreshing} onclick={() => onRefresh()}>
					{$LL.account_refresh()}
				</Button>
			{/if}
		</div>

		{#if error}
			<div class="widget-error">
				<p role="alert">{error}</p>
				{#if reauthNeeded && onReauthenticate}
					<Button variant="secondary" size="sm" onclick={() => onReauthenticate()}>
						{$LL.account_reauth()}
					</Button>
				{/if}
			</div>
		{/if}

		{@render children()}
	</section>
{/snippet}

{#if framed}
	<Card>{@render panel()}</Card>
{:else}
	{@render panel()}
{/if}

<style>
	.widget-panel {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.widget-panel.embedded {
		gap: 10px;
		padding-top: 4px;
	}

	.widget-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.widget-heading-aside {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-inline-start: auto;
	}

	.widget-heading :global(h2) {
		margin: 0;
		font-size: 1rem;
	}

	.widget-heading :global(h3) {
		margin: 0;
		font-size: 0.9375rem;
	}

	.widget-error {
		display: grid;
		justify-items: start;
		gap: 8px;
	}

	.widget-error p {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger-fg);
	}
</style>

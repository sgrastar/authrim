<script lang="ts" module>
	import type { IconName } from '$lib/ui/icons/icons';

	export interface TopNavEntry {
		id: string;
		label: string;
		icon: IconName;
		href: string;
		color: string;
		/** Platform scope: category holding the defaults every tenant inherits. */
		inherited?: boolean;
		badge?: string;
	}
</script>

<script lang="ts">
	import CountBadge from '$lib/ui/primitives/CountBadge.svelte';
	import { untrack } from 'svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { afterPaint, motionReduced, TOPNAV_FLIP_MS, TOPNAV_FLIP_STEP_MS } from './motion';

	/**
	 * Header categories. When the scope changes the whole set is replaced, so the items flip
	 * over one by one from the start edge (front = old set, back = new set) — a card turn.
	 */
	interface Props {
		label: string;
		/** Changes to this key trigger the flip (the scope kind). */
		flipKey: string;
		entries: readonly TopNavEntry[];
		activeId: string;
	}

	let { label, flipKey, entries, activeId }: Props = $props();

	let flip = $state<{ front: readonly TopNavEntry[]; turned: boolean } | null>(null);
	let lastKey = untrack(() => flipKey);
	let lastEntries = untrack(() => entries);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const key = flipKey;
		const next = entries;
		untrack(() => {
			if (key !== lastKey && !motionReduced()) {
				clearTimeout(timer);
				// Always turn from what is on screen now, so a switch during a turn restarts cleanly.
				flip = { front: lastEntries, turned: false };
				afterPaint(() => {
					if (flip) flip.turned = true;
				});
				const span = Math.max(lastEntries.length, next.length) * TOPNAV_FLIP_STEP_MS;
				timer = setTimeout(() => (flip = null), TOPNAV_FLIP_MS + span + 60);
			}
			lastKey = key;
			lastEntries = next;
		});
	});

	$effect(() => () => clearTimeout(timer));
</script>

{#snippet itemBody(entry: TopNavEntry)}
	<Icon name={entry.icon} />
	<span>{entry.label}</span>
	{#if entry.badge}<span class="topnav__badge"><CountBadge value={entry.badge} /></span>{/if}
{/snippet}

<nav class="topnav" class:is-flipping={flip} aria-label={label}>
	{#each entries as entry (entry.id)}
		<a
			class="topnav__item"
			class:is-active={entry.id === activeId}
			class:is-inherited={entry.inherited}
			href={entry.href}
			aria-current={entry.id === activeId ? 'page' : undefined}
			style:--scope-color={entry.color}
		>
			{@render itemBody(entry)}
		</a>
	{/each}
	{#if flip}
		<div class="flip-stage" class:is-turned={flip.turned} aria-hidden="true">
			<div class="flip-face flip-face--front">
				{#each flip.front as entry, i (entry.id)}
					<span
						class="topnav__item"
						class:is-active={entry.id === activeId}
						class:is-inherited={entry.inherited}
						style:--i={i}
						style:--scope-color={entry.color}>{@render itemBody(entry)}</span
					>
				{/each}
			</div>
			<div class="flip-face flip-face--back">
				{#each entries as entry, i (entry.id)}
					<span
						class="topnav__item"
						class:is-active={entry.id === activeId}
						class:is-inherited={entry.inherited}
						style:--i={i}
						style:--scope-color={entry.color}>{@render itemBody(entry)}</span
					>
				{/each}
			</div>
		</div>
	{/if}
</nav>

<style>
	.topnav {
		position: sticky;
		top: var(--header-h);
		z-index: var(--z-nav);
		display: flex;
		align-items: stretch;
		gap: 2px;
		height: var(--subheader-h);
		padding: 0 12px;
		overflow-x: auto;
		border-bottom: var(--shell-rule) solid var(--border);
		background: var(--shell-bg);
		-webkit-backdrop-filter: var(--shell-backdrop);
		backdrop-filter: var(--shell-backdrop);
		scrollbar-width: none;
	}

	.topnav::-webkit-scrollbar {
		display: none;
	}

	.topnav__item {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 0 12px;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		font-weight: var(--fw-name);
		white-space: nowrap;
		--icon-size: var(--icon-md);
	}

	.topnav__item :global(svg) {
		opacity: 0.75;
	}

	a.topnav__item:active {
		filter: brightness(0.93);
	}

	a.topnav__item:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.topnav__item.is-active {
		border-bottom-color: var(--scope-color, var(--primary));
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.topnav__item.is-active :global(svg) {
		color: var(--scope-color, var(--primary));
		opacity: 1;
	}

	/* Platform scope: tint the categories that hold every tenant's defaults, and separate them
	   from the platform's own categories. */
	.topnav__item.is-inherited {
		background: color-mix(in srgb, var(--accent-tenant) 18%, transparent);
	}

	a.topnav__item.is-inherited:hover {
		background: color-mix(in srgb, var(--accent-tenant) 26%, transparent);
	}

	.topnav__item.is-inherited + .topnav__item:not(.is-inherited) {
		margin-inline-start: 10px;
		padding-inline-start: 16px;
		box-shadow: inset calc(1px * var(--dir)) 0 0 var(--border);
	}

	/* Where the count sits; CountBadge draws it. */
	.topnav__badge {
		display: inline-flex;
		margin-inline-start: 6px;
	}

	/* ---- Flip ---- */
	.topnav.is-flipping {
		overflow: visible;
	}

	.topnav.is-flipping > a.topnav__item {
		opacity: 0;
	}

	.flip-stage {
		position: absolute;
		inset: 0;
		z-index: 60;
		pointer-events: none;
	}

	.flip-face {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: stretch;
		gap: 2px;
		padding: 0 12px;
		perspective: 800px;
		transform-style: preserve-3d;
	}

	.flip-face .topnav__item {
		backface-visibility: hidden;
		transform-origin: center center;
		/* Overshoots slightly at the end, then settles: the "click" of a turned card. */
		transition: transform 420ms var(--flip-ease);
		transition-delay: calc(var(--i, 0) * 55ms);
	}

	.flip-face--front .topnav__item {
		transform: rotateX(0deg);
	}

	.flip-face--back .topnav__item {
		transform: rotateX(180deg);
	}

	.is-turned .flip-face--front .topnav__item {
		transform: rotateX(-180deg);
	}

	.is-turned .flip-face--back .topnav__item {
		transform: rotateX(0deg);
	}

	@media (max-width: 640px) {
		/* Phones reach categories through the drawer; horizontal scrolling fights swipe-back. */
		.topnav {
			display: none;
		}
	}
</style>

<script lang="ts" module>
	import type { IconName } from '$lib/ui/icons/icons';

	export type SubNavRow =
		| { type: 'scope'; key: string; label: string }
		| { type: 'group'; key: string; label: string }
		| {
				type: 'item';
				key: string;
				label: string;
				icon: IconName;
				href: string;
				active: boolean;
				/** Short platform-scope tag (e.g. "search", "tenant"). */
				tag?: string;
				tagTone?: 'lookup' | 'tenant' | 'template';
				badge?: string;
		  };
</script>

<script lang="ts">
	import CountBadge from '$lib/ui/primitives/CountBadge.svelte';
	import { untrack } from 'svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { motionReduced, SUBNAV_RISE_DELAY_MS, SUBNAV_SETTLE_MS, SUBNAV_STEP_MS } from './motion';

	/**
	 * Left nav: the items of the current header category. When the category changes the rows
	 * turn over from the top: old rows fall (240ms) and the new rows rise half a beat later.
	 * If the category changes again while rows are still turning, the turn is abandoned and only
	 * the new rows rise — replaying half-turned rows as "old" would overlap the new ones.
	 */
	interface Props {
		label: string;
		/** Changes to this key trigger the turn (scope kind + header category). */
		flipKey: string;
		rows: readonly SubNavRow[];
		color: string;
	}

	let { label, flipKey, rows, color }: Props = $props();

	let turning = $state(false);
	let outgoing = $state<readonly SubNavRow[]>([]);
	let riseDelay = $state(SUBNAV_RISE_DELAY_MS);
	let lastKey = untrack(() => flipKey);
	let lastRows = untrack(() => rows);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const key = flipKey;
		const next = rows;
		untrack(() => {
			if (key !== lastKey && next.length > 0 && !motionReduced()) {
				const interrupted = turning;
				clearTimeout(timer);
				outgoing = interrupted ? [] : lastRows;
				riseDelay = outgoing.length ? SUBNAV_RISE_DELAY_MS : 0;
				turning = true;
				const count = Math.max(outgoing.length, next.length);
				timer = setTimeout(
					() => {
						turning = false;
						outgoing = [];
					},
					count * SUBNAV_STEP_MS + SUBNAV_SETTLE_MS
				);
			}
			lastKey = key;
			lastRows = next;
		});
	});

	$effect(() => () => clearTimeout(timer));
</script>

{#snippet row(entry: SubNavRow, index: number, interactive: boolean)}
	{#if entry.type === 'scope'}
		<p class="subnav__scope" style:--fi={index}>{entry.label}</p>
	{:else if entry.type === 'group'}
		<p class="subnav__group" style:--fi={index}>{entry.label}</p>
	{:else if interactive}
		<a
			class="subnav__item"
			class:is-active={entry.active}
			class:is-dim={entry.tagTone === 'tenant'}
			href={entry.href}
			aria-current={entry.active ? 'page' : undefined}
			style:--fi={index}
		>
			<Icon name={entry.icon} />
			<span class="subnav__label">{entry.label}</span>
			{#if entry.tag}<span class="subnav__tag subnav__tag--{entry.tagTone}">{entry.tag}</span>{/if}
			{#if entry.badge}<span class="subnav__badge"><CountBadge value={entry.badge} /></span>{/if}
		</a>
	{:else}
		<span class="subnav__item" class:is-active={entry.active} style:--fi={index}>
			<Icon name={entry.icon} />
			<span class="subnav__label">{entry.label}</span>
		</span>
	{/if}
{/snippet}

{#if rows.length > 0}
	<aside
		class="subnav"
		class:is-turning={turning}
		aria-label={label}
		style:--scope-color={color}
		style:--rise-delay="{riseDelay}ms"
	>
		{#key flipKey}
			<div class="subnav__rows subnav__rows--in">
				{#each rows as entry, i (entry.key)}{@render row(entry, i, true)}{/each}
			</div>
		{/key}
		{#if turning && outgoing.length}
			<div class="subnav__rows subnav__rows--out" aria-hidden="true">
				{#each outgoing as entry, i (entry.key)}{@render row(entry, i, false)}{/each}
			</div>
		{/if}
	</aside>
{/if}

<style>
	.subnav {
		/* The flip's outgoing copy stacks locally. */
		isolation: isolate;
		position: sticky;
		top: calc(var(--header-h) + var(--subheader-h) + var(--shell-inset));
		height: calc(100vh - var(--header-h) - var(--subheader-h) - var(--shell-inset) * 2);
		overflow-y: auto;
		border-inline-end: 1px solid var(--border);
		border-radius: var(--shell-radius);
		background: var(--subnav-bg);
		-webkit-backdrop-filter: var(--surface-backdrop);
		backdrop-filter: var(--surface-backdrop);
	}

	.subnav__rows {
		padding: 18px 12px 28px;
	}

	/* The outgoing copy sits exactly over the incoming rows, row for row. */
	.subnav__rows--out {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
	}

	.subnav__scope {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		padding: 0 8px 12px;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-bold);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.subnav__scope::before {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 2px;
		background: var(--scope-color, var(--primary));
	}

	.subnav__group {
		margin: 14px 0 0;
		padding: 0 8px 6px;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.subnav__item {
		display: flex;
		align-items: center;
		gap: 9px;
		margin-bottom: 1px;
		padding: 7px 8px;
		border-radius: var(--radius-control);
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-snug);
		--icon-size: var(--icon-md);
	}

	.subnav__item :global(svg) {
		opacity: 0.7;
	}

	a.subnav__item:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/* Pressed: the face darkens at once (links, so not covered by the button rule). */
	a.subnav__item:active {
		background: var(--bg-press);
		filter: brightness(0.93);
	}

	.subnav__item.is-active {
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	/* Platform scope: items that can only be set per tenant. Muted colour, not opacity, so the
	   text keeps readable contrast. */
	.subnav__item.is-dim {
		color: var(--text-muted);
	}

	.subnav__item.is-dim :global(svg) {
		opacity: 0.45;
	}

	/* A single long German compound breaks inside the word instead of overflowing. */
	.subnav__label {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.subnav__tag {
		margin-inline-start: auto;
		padding: 1px 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-badge);
		color: var(--text-muted);
		font-size: var(--fs-overline);
		white-space: nowrap;
	}

	.subnav__tag--lookup {
		border-color: color-mix(in srgb, var(--info) 45%, var(--border));
		color: var(--info);
	}

	/* Where the count sits; CountBadge draws it. */
	.subnav__badge {
		display: inline-flex;
		margin-inline-start: auto;
	}

	/* ---- Turn ---- */
	.is-turning .subnav__rows--out > :global(*) {
		animation: subnav-fall 240ms cubic-bezier(0.4, 0, 1, 1) both;
		animation-delay: calc(var(--fi, 0) * 40ms);
		backface-visibility: hidden;
	}

	.is-turning .subnav__rows--in > :global(*) {
		animation: subnav-rise 360ms var(--flip-ease) both;
		animation-delay: calc(var(--fi, 0) * 40ms + var(--rise-delay, 140ms));
		backface-visibility: hidden;
	}

	@keyframes subnav-fall {
		to {
			opacity: 0;
			transform: perspective(500px) rotateX(-90deg);
		}
	}

	@keyframes subnav-rise {
		from {
			opacity: 0;
			transform: perspective(500px) rotateX(90deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.is-turning .subnav__rows--in > :global(*) {
			animation: none;
		}
		.subnav__rows--out {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.subnav {
			display: none;
		}
	}
</style>

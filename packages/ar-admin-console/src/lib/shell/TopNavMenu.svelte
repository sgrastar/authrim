<script lang="ts">
	import CountBadge from '#lib/ui/primitives/CountBadge.svelte';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import type { SubNavRow } from './SubNav.svelte';

	/**
	 * The pages of one header category, dropped from its tab like a menu of the OS menu bar: the
	 * same rows as the left nav in one column (group headings, the items one character in, the
	 * current page ticked in that indent), each a link. No icons, as in an OS menu.
	 * Placement and opening are TopNav's; this only draws the panel.
	 */
	interface Props {
		id: string;
		label: string;
		rows: readonly SubNavRow[];
		/** Where the panel's top start corner goes (viewport px; start = left in LTR). */
		top: number;
		start: number;
		color: string;
		panel?: HTMLElement;
		onpointerenter?: (event: PointerEvent) => void;
		onpointerleave?: (event: PointerEvent) => void;
		onkeydown?: (event: KeyboardEvent) => void;
		onfocusout?: (event: FocusEvent) => void;
		onnavigate?: () => void;
	}

	let {
		id,
		label,
		rows,
		top,
		start,
		color,
		panel = $bindable(),
		onpointerenter,
		onpointerleave,
		onkeydown,
		onfocusout,
		onnavigate
	}: Props = $props();

	type Item = Extract<SubNavRow, { type: 'item' }>;
	interface Block {
		key: string;
		heading?: string;
		items: Item[];
	}

	/** Each group with its items (a category with one area has a single block, no heading). */
	const blocks = $derived.by(() => {
		const list: Block[] = [];
		// `rows` can go missing for a moment while the menu is being closed or switched.
		for (const row of rows ?? []) {
			if (row.type === 'scope') continue;
			if (row.type === 'group') list.push({ key: row.key, heading: row.label, items: [] });
			else {
				if (list.length === 0) list.push({ key: 'items', items: [] });
				list[list.length - 1].items.push(row);
			}
		}
		return list.filter((block) => block.items.length > 0);
	});
</script>

<!-- The keys and the pointer are its links' (delegated): ↑ ↓ ← → Esc move between them. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={panel}
	id="topnav-menu-{id}"
	class="menu"
	role="group"
	aria-label={label}
	style:top="{top}px"
	style:inset-inline-start="{start}px"
	style:--scope-color={color}
	{onpointerenter}
	{onpointerleave}
	{onkeydown}
	{onfocusout}
>
	{#each blocks as block (block.key)}
		<section class="menu__block">
			{#if block.heading}<p class="menu__heading">{block.heading}</p>{/if}
			<ul>
				{#each block.items as item (item.key)}
					<li>
						<a
							class="menu__item"
							class:is-active={item.active}
							class:is-dim={item.tagTone === 'tenant'}
							href={item.href}
							aria-current={item.active ? 'page' : undefined}
							onclick={() => onnavigate?.()}
						>
							<span class="menu__check" aria-hidden="true">
								{#if item.active}<Icon name="check" />{/if}
							</span>
							<span class="menu__label">{item.label}</span>
							{#if item.tag || item.badge}
								<span class="menu__end">
									{#if item.tag}
										<span class="menu__tag menu__tag--{item.tagTone}">{item.tag}</span>
									{/if}
									{#if item.badge}<CountBadge value={item.badge} />{/if}
								</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<style>
	.menu {
		position: fixed;
		z-index: var(--z-menu);
		display: grid;
		gap: 4px;
		min-width: 220px;
		max-width: calc(100vw - 16px);
		max-height: calc(100vh - var(--header-h) - var(--subheader-h) - 24px);
		padding: 5px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg), var(--surface-highlight);
		animation: menu-drop 120ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}

	/* Groups apart by a hairline, as an OS menu's separators. */
	.menu__block + .menu__block {
		padding-top: 4px;
		border-top: 1px solid var(--border-subtle);
	}

	.menu__heading {
		margin: 0;
		padding: 5px 10px 2px;
		color: var(--text-muted);
		font-size: var(--fs-overline);
		font-weight: var(--fw-semibold);
		letter-spacing: 0.04em;
		white-space: nowrap;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The headings start at the edge; the items one character in (the tick's column). */
	.menu__item {
		display: flex;
		align-items: center;
		min-height: var(--control-h-dense);
		padding: 4px 12px 4px 10px;
		border-radius: var(--radius-control);
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-snug);
		white-space: nowrap;
	}

	/* The row under the pointer or the keyboard: the OS menu's highlight, in the category's colour. */
	.menu__item:hover,
	.menu__item:focus-visible {
		background: color-mix(in srgb, var(--scope-color, var(--primary)) 14%, var(--bg-card));
		color: var(--text-primary);
		outline: none;
	}

	.menu__item:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.menu__item.is-active {
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.menu__item.is-dim {
		color: var(--text-muted);
	}

	/* The one-character indent, holding the tick of the current page. */
	.menu__check {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		width: 1em;
		color: var(--scope-color, var(--primary));
		--icon-size: var(--icon-xs);
	}

	/* A tag or a count at the end, apart from the label. */
	.menu__end {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-inline-start: auto;
		padding-inline-start: 16px;
	}

	.menu__tag {
		padding: 1px 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-badge);
		color: var(--text-muted);
		font-size: var(--fs-overline);
	}

	.menu__tag--lookup {
		border-color: color-mix(in srgb, var(--info) 45%, var(--border));
		color: var(--info);
	}

	@keyframes menu-drop {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.menu {
			animation: none;
		}
	}
</style>

<script lang="ts" module>
	import type { IconName } from '#lib/ui/icons/icons.js';

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
	import CountBadge from '#lib/ui/primitives/CountBadge.svelte';
	import { tick, untrack } from 'svelte';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import {
		afterPaint,
		motionReduced,
		TOPNAV_FLIP_MS,
		TOPNAV_FLIP_STEP_MS,
		TOPNAV_MENU_CLOSE_MS,
		TOPNAV_MENU_OPEN_MS
	} from './motion';
	import type { SubNavRow } from './SubNav.svelte';
	import TopNavMenu from './TopNavMenu.svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';

	/**
	 * Header categories. When the scope changes the whole set is replaced, so the items flip
	 * over one by one from the start edge (front = old set, back = new set) — a card turn.
	 *
	 * With `menus`, each category also drops a menu of its pages, as the OS menu bar does:
	 * - a click on a category still opens it (its first page);
	 * - resting the pointer on a category a moment opens its menu, and while a menu is open,
	 *   moving along the bar opens the next one at once;
	 * - the keyboard opens a menu with ↓, walks it with ↑ ↓, moves to the next category's menu
	 *   with ← →, and closes it with Esc (back to the category);
	 * - touch has no resting pointer: a tap only opens the category, as before.
	 */
	interface Props {
		label: string;
		/** Changes to this key trigger the flip (the scope kind). */
		flipKey: string;
		/** Changes to this key (the page shown) close any menu that is open or about to open. */
		pageKey?: string;
		entries: readonly TopNavEntry[];
		activeId: string;
		/** The pages of each category (the left nav's rows), for its menu. */
		menus?: readonly { id: string; rows: readonly SubNavRow[] }[];
	}

	let { label, flipKey, pageKey = '', entries, activeId, menus = [] }: Props = $props();

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

	// ---- Menus ----
	const links: Record<string, HTMLAnchorElement | undefined> = $state({});
	const toggles: Record<string, HTMLButtonElement | undefined> = $state({});
	let nav = $state<HTMLElement>();
	let panel = $state<HTMLElement>();
	/** The open menu; `keyboard`: opened from the keyboard, so the pointer leaving keeps it. */
	let open = $state<{ id: string; top: number; start: number; keyboard: boolean } | null>(null);
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	// Each opening gets a number; a later open or close makes an earlier async step void.
	let generation = 0;

	const rowsOf = (id: string) => {
		const rows = menus.find((menu) => menu.id === id)?.rows;
		return rows?.some((row) => row.type === 'item') ? rows : null;
	};
	const shown = $derived.by(() => {
		if (!open) return null;
		const entry = entries.find((candidate) => candidate.id === open!.id);
		const rows = rowsOf(open.id);
		return entry && rows
			? {
					id: open.id,
					label: entry.label,
					color: entry.color,
					rows,
					top: open.top,
					start: open.start
				}
			: null;
	});

	function cancelTimers() {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
	}

	/** Whether the keyboard is in the open menu or on its category (its link or its toggle). */
	function focusInMenu(): boolean {
		const now = document.activeElement;
		if (!open || !now) return false;
		return Boolean(panel?.contains(now) || links[open.id] === now || toggles[open.id] === now);
	}

	/** Drops the category's menu under its tab, kept inside the window. */
	async function show(id: string, keyboard = false): Promise<boolean> {
		const link = links[id];
		// Not while the bar is turning over to another scope: the tabs are moving.
		if (!link || !rowsOf(id) || flip) {
			close();
			return false;
		}
		cancelTimers();
		const mine = ++generation;
		const rect = link.getBoundingClientRect();
		const rtl = nav ? getComputedStyle(nav).direction === 'rtl' : false;
		const start = rtl ? window.innerWidth - rect.right : rect.left;
		open = { id, top: rect.bottom, start, keyboard: keyboard || Boolean(open?.keyboard) };
		await tick();
		if (mine !== generation || open?.id !== id) return false;
		const width = panel?.offsetWidth ?? 0;
		if (width) open.start = Math.max(8, Math.min(start, window.innerWidth - width - 8));
		return true;
	}

	/** Closes the menu; with `refocus`, the keyboard goes back to its category. */
	function close(refocus = false) {
		cancelTimers();
		generation++;
		const id = open?.id;
		const focusWasInside = refocus && focusInMenu();
		open = null;
		if (id && focusWasInside) links[id]?.focus();
	}

	/** After the pointer leaves: closes unless it came back, or the keyboard is in the menu. */
	function laterClose() {
		if (!open || open.keyboard) return;
		clearTimeout(closeTimer);
		// Checked when it fires: the keyboard may have gone into the menu meanwhile.
		closeTimer = setTimeout(() => {
			if (!panel?.contains(document.activeElement)) close();
		}, TOPNAV_MENU_CLOSE_MS);
	}

	function hoverEntry(event: PointerEvent, id: string) {
		if (event.pointerType !== 'mouse' || flip) return;
		// The keyboard is in the open menu: the pointer passing over the bar does not take it away
		// (switching would remove the link that has the focus).
		if (open && panel?.contains(document.activeElement)) return;
		clearTimeout(closeTimer);
		clearTimeout(openTimer);
		// Once a menu is open, sliding along the bar switches menus at once.
		if (open) void show(id);
		else openTimer = setTimeout(() => void show(id), TOPNAV_MENU_OPEN_MS);
	}

	function leaveEntry(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		clearTimeout(openTimer);
		laterClose();
	}

	/** The first inherited category after the scope's own ones starts the inherited group. */
	const firstInherited = (list: readonly TopNavEntry[], i: number) =>
		list[i].inherited === true && i > 0 && list[i - 1].inherited !== true;

	const menuLinks = () => [...(panel?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];

	async function showAndFocus(id: string, which: 'first' | 'last' = 'first') {
		if (!(await show(id, true))) return;
		await tick();
		const items = menuLinks();
		(which === 'first' ? items[0] : items.at(-1))?.focus();
	}

	/** The next category that has a menu, `step` (±1) along the bar, wrapping round. */
	function neighbour(id: string, step: number): string | null {
		const withMenus = entries.filter((entry) => rowsOf(entry.id));
		const index = withMenus.findIndex((entry) => entry.id === id);
		if (index < 0 || withMenus.length < 2) return null;
		return withMenus[(index + step + withMenus.length) % withMenus.length].id;
	}

	function entryKeydown(event: KeyboardEvent, id: string) {
		if (event.key === 'ArrowDown' && rowsOf(id)) {
			event.preventDefault();
			void showAndFocus(id);
		}
	}

	function toggle(id: string) {
		if (open?.id === id) close(true);
		else void showAndFocus(id);
	}

	function menuKeydown(event: KeyboardEvent) {
		if (!open) return;
		const items = menuLinks();
		const index = items.indexOf(document.activeElement as HTMLAnchorElement);
		const rtl = nav ? getComputedStyle(nav).direction === 'rtl' : false;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				items[(index + 1) % items.length]?.focus();
				break;
			case 'ArrowUp':
				event.preventDefault();
				items[(index - 1 + items.length) % items.length]?.focus();
				break;
			case 'Home':
				event.preventDefault();
				items[0]?.focus();
				break;
			case 'End':
				event.preventDefault();
				items.at(-1)?.focus();
				break;
			case 'Tab': {
				// The panel sits after the whole bar in the page, so leave it as if it were right
				// after its category: back to the category's menu button, and from there Tab goes
				// on to the next category (Shift+Tab stays on the button).
				const back = toggles[open.id] ?? links[open.id];
				close();
				back?.focus();
				if (event.shiftKey) event.preventDefault();
				break;
			}
			case 'ArrowLeft':
			case 'ArrowRight': {
				event.preventDefault();
				const next = neighbour(open.id, (event.key === 'ArrowRight') !== rtl ? 1 : -1);
				if (next) void showAndFocus(next);
				break;
			}
		}
	}

	// Focus leaving the menu and its category (Tab, a click elsewhere) closes it. Checked once the
	// move is over: switching to the next category's menu replaces the links, which also fires
	// focusout.
	function focusLeft() {
		setTimeout(() => {
			if (open && !focusInMenu()) close();
		});
	}

	// A new scope replaces the categories, and a new page (a link, the browser's back) is where
	// the admin went: whatever was open or about to open is void.
	$effect(() => {
		void flipKey;
		void pageKey;
		untrack(() => close());
	});

	$effect(() => () => cancelTimers());
</script>

<svelte:window
	onresize={() => close()}
	onkeydown={(event) => {
		// Esc closes the menu wherever the keyboard is (a menu the pointer opened, too).
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			close(true);
		}
	}}
	onpointerdown={(event) => {
		if (!open) return;
		const target = event.target as Node;
		if (panel?.contains(target) || nav?.contains(target)) return;
		close();
	}}
/>

{#snippet itemBody(entry: TopNavEntry)}
	<Icon name={entry.icon} />
	<span>{entry.label}</span>
	{#if entry.badge}<span class="topnav__badge"><CountBadge value={entry.badge} /></span>{/if}
{/snippet}

<nav
	bind:this={nav}
	class="topnav"
	class:is-flipping={flip}
	aria-label={label}
	onscroll={() => close()}
>
	{#each entries as entry, i (entry.id)}
		{@const hasMenu = rowsOf(entry.id) !== null}
		<a
			bind:this={links[entry.id]}
			class="topnav__item"
			class:is-active={entry.id === activeId}
			class:is-inherited={entry.inherited}
			class:is-first-inherited={firstInherited(entries, i)}
			class:is-open={open?.id === entry.id}
			href={entry.href}
			aria-current={entry.id === activeId ? 'page' : undefined}
			style:--scope-color={entry.color}
			onpointerenter={(event) => hoverEntry(event, entry.id)}
			onpointerleave={leaveEntry}
			onkeydown={(event) => entryKeydown(event, entry.id)}
			onfocusout={focusLeft}
			onclick={() => close()}
		>
			{@render itemBody(entry)}
		</a>
		<!-- The keyboard and screen readers open the menu here (Enter / Space): the link itself
		     goes to the category. Shown only while it has the keyboard. -->
		{#if hasMenu}
			<button
				bind:this={toggles[entry.id]}
				type="button"
				class="topnav__toggle"
				aria-label={t('nav.menuOf', { name: entry.label })}
				aria-expanded={open?.id === entry.id}
				aria-controls={open?.id === entry.id ? `topnav-menu-${entry.id}` : undefined}
				onclick={() => toggle(entry.id)}
				onkeydown={(event) => entryKeydown(event, entry.id)}
				onfocusout={focusLeft}
			>
				<Icon name="caret" />
			</button>
		{/if}
	{/each}
	{#if flip}
		<div class="flip-stage" class:is-turned={flip.turned} aria-hidden="true">
			<div class="flip-face flip-face--front">
				{#each flip.front as entry, i (entry.id)}
					<span
						class="topnav__item"
						class:is-active={entry.id === activeId}
						class:is-inherited={entry.inherited}
						class:is-first-inherited={firstInherited(flip.front, i)}
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
						class:is-first-inherited={firstInherited(entries, i)}
						style:--i={i}
						style:--scope-color={entry.color}>{@render itemBody(entry)}</span
					>
				{/each}
			</div>
		</div>
	{/if}
</nav>
<!-- One item at most; an each keeps the last value while the panel goes, so its props never read
     a menu that has just been closed. -->
{#each shown ? [shown] : [] as menu (menu.id)}
	<TopNavMenu
		bind:panel
		id={menu.id}
		label={menu.label}
		rows={menu.rows}
		top={menu.top}
		start={menu.start}
		color={menu.color}
		onpointerenter={() => clearTimeout(closeTimer)}
		onpointerleave={(event) => {
			if (event.pointerType === 'mouse') laterClose();
		}}
		onkeydown={menuKeydown}
		onfocusout={focusLeft}
		onnavigate={() => close()}
	/>
{/each}

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

	a.topnav__item:hover,
	a.topnav__item.is-open {
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

	/* Set in the markup, not with `+`: each category may be followed by its menu button. */
	.topnav__item.is-first-inherited {
		margin-inline-start: 10px;
		padding-inline-start: 16px;
		box-shadow: inset calc(1px * var(--dir)) 0 0 var(--border);
	}

	/* The menu's own button: out of sight, it appears beside its category while it has the
	   keyboard. */
	.topnav__toggle {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.topnav__toggle:focus-visible,
	.topnav__toggle[aria-expanded='true']:focus {
		position: static;
		display: inline-flex;
		align-self: center;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		margin-inline-start: -10px;
		overflow: visible;
		clip-path: none;
		border: 0;
		border-radius: var(--radius-control);
		background: var(--bg-hover);
		color: var(--text-primary);
		--icon-size: var(--icon-xs);
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

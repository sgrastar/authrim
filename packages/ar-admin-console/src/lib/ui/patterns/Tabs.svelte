<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface TabItem {
		id: string;
		label: string;
		icon?: IconName;
		/** Small count after the label (sessions, pending items). */
		count?: number;
		/** Tabs with URLs are links: each tab is its own page and can be bookmarked or shared. */
		href?: string;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import Popover from './Popover.svelte';
	import { splitTabs } from './tabs';

	/**
	 * Sections of one record (a user's overview, sessions, audit log…). An underline slides to
	 * the current tab. Records should have few tabs; if they still do not fit (long
	 * translations, narrow screens), the ones that do not fit go under "More" at the end, and
	 * the current tab always stays in the row.
	 *
	 * Two kinds, chosen by the items:
	 * - with `href`: links, one URL per tab (deep links, back button). The page renders the
	 *   content itself.
	 * - without: tabs switched in place; `panel` renders the chosen one. Arrow keys move
	 *   between the tabs in the row (mirrored in RTL), Home/End jump to the ends.
	 */
	interface Props {
		/** Accessible name of the tab row, e.g. the record name. */
		label: string;
		items: readonly TabItem[];
		/** The current tab's id. */
		value?: string;
		onchange?: (id: string) => void;
		/** Content of the current tab (in-place tabs only). */
		panel?: Snippet<[string]>;
	}

	let { label, items, value = $bindable(items[0]?.id ?? ''), onchange, panel }: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const links = $derived(items.length > 0 && items.every((item) => item.href));

	let bar = $state<HTMLDivElement>();
	let row = $state<HTMLElement>();
	let ruler = $state<HTMLDivElement>();
	let room = $state(0);
	let widths = $state<number[]>([]);
	let moreWidth = $state(0);
	let indicator = $state({ left: 0, width: 0, ready: false });

	const split = $derived(splitTabs(items, widths, room, moreWidth, value));

	/** Every tab's natural width, measured in a hidden copy of the row. */
	function measureTabs() {
		if (!ruler) return;
		const tabs = [...ruler.querySelectorAll<HTMLElement>('[data-measure="tab"]')];
		widths = tabs.map((tab) => tab.offsetWidth);
		moreWidth = ruler.querySelector<HTMLElement>('[data-measure="more"]')?.offsetWidth ?? 0;
	}

	function placeIndicator() {
		const tab = row?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(value)}"]`);
		if (tab) indicator = { left: tab.offsetLeft, width: tab.offsetWidth, ready: true };
	}

	// Re-measure when labels change (language switch) and once fonts have loaded.
	$effect(() => {
		void items.map((item) => `${item.label}${item.count ?? ''}`).join();
		measureTabs();
		document.fonts?.ready.then(measureTabs);
	});

	$effect(() => {
		if (!bar) return;
		const observer = new ResizeObserver(() => {
			room = bar?.clientWidth ?? 0;
		});
		observer.observe(bar);
		return () => observer.disconnect();
	});

	// After the row is laid out for this split, move the underline.
	$effect(() => {
		void split;
		void value;
		placeIndicator();
	});

	function select(id: string) {
		if (id === value) return;
		value = id;
		onchange?.(id);
	}

	function onkeydown(event: KeyboardEvent) {
		const shown = split.shown;
		const index = shown.findIndex((item) => item.id === value);
		const rtl = row ? getComputedStyle(row).direction === 'rtl' : false;
		const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
		let next = -1;
		if (step !== undefined) next = (index + step + shown.length) % shown.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = shown.length - 1;
		if (next < 0) return;
		event.preventDefault();
		select(shown[next].id);
		row?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(shown[next].id)}"]`)?.focus();
	}
</script>

{#snippet content(item: TabItem)}
	{#if item.icon}<Icon name={item.icon} />{/if}
	<span>{item.label}</span>
	{#if item.count !== undefined}<span class="tabs__count">{item.count}</span>{/if}
{/snippet}

{#snippet indicatorBar()}
	<span
		class="tabs__indicator"
		class:is-ready={indicator.ready}
		style:--x="{indicator.left}px"
		style:--w="{indicator.width}px"
	></span>
{/snippet}

{#snippet moreMenu()}
	{#if split.more.length > 0}
		<div class="tabs__more">
			<Popover label={t('tabs.more')} align="end">
				{#snippet trigger()}
					<span class="tabs__tab tabs__more-trigger">
						<span>{t('tabs.more')}</span><Icon name="caret" />
					</span>
				{/snippet}
				{#snippet children({ close })}
					<ul class="tabs__menu">
						{#each split.more as item (item.id)}
							<li>
								{#if links}
									<a class="tabs__menu-item" href={item.href} onclick={() => close()}
										>{@render content(item)}</a
									>
								{:else}
									<button
										type="button"
										class="tabs__menu-item"
										onclick={() => {
											select(item.id);
											close();
										}}>{@render content(item)}</button
									>
								{/if}
							</li>
						{/each}
					</ul>
				{/snippet}
			</Popover>
		</div>
	{/if}
{/snippet}

<div class="tabs">
	<div class="tabs__bar" bind:this={bar}>
		{#if links}
			<nav class="tabs__row" aria-label={label} bind:this={row}>
				{#each split.shown as item (item.id)}
					<a
						class="tabs__tab"
						class:is-current={item.id === value}
						class:is-busy={busy()}
						data-tab={item.id}
						href={busy() ? undefined : item.href}
						aria-current={item.id === value ? 'page' : undefined}
						aria-disabled={busy() || undefined}
						role={busy() ? 'link' : undefined}>{@render content(item)}</a
					>
				{/each}
				{@render indicatorBar()}
			</nav>
		{:else}
			<div
				class="tabs__row"
				role="tablist"
				aria-label={label}
				tabindex="-1"
				bind:this={row}
				{onkeydown}
			>
				{#each split.shown as item (item.id)}
					<button
						type="button"
						role="tab"
						class="tabs__tab"
						class:is-current={item.id === value}
						id="{uid}-tab-{item.id}"
						data-tab={item.id}
						aria-selected={item.id === value}
						aria-controls="{uid}-panel"
						tabindex={item.id === value ? 0 : -1}
						disabled={busy()}
						onclick={() => select(item.id)}>{@render content(item)}</button
					>
				{/each}
				{@render indicatorBar()}
			</div>
		{/if}
		{@render moreMenu()}

		<!-- Hidden copy used only to measure each tab's natural width. -->
		<div class="tabs__ruler" aria-hidden="true" inert bind:this={ruler}>
			{#each items as item (item.id)}
				<span class="tabs__tab is-current" data-measure="tab">{@render content(item)}</span>
			{/each}
			<span class="tabs__tab" data-measure="more"
				><span>{t('tabs.more')}</span><Icon name="caret" /></span
			>
		</div>
	</div>
	{#if panel && !links}
		<div
			class="tabs__panel"
			role="tabpanel"
			id="{uid}-panel"
			aria-labelledby="{uid}-tab-{value}"
			tabindex="0"
		>
			{#key value}<div class="tabs__panel-body">{@render panel(value)}</div>{/key}
		</div>
	{/if}
</div>

<style>
	.tabs {
		display: grid;
		gap: 18px;
		min-width: 0;
	}

	.tabs__bar {
		position: relative;
		display: flex;
		min-width: 0;
		border-bottom: 1px solid var(--border);
	}

	.tabs__row {
		position: relative;
		display: flex;
		min-width: 0;
		outline: none;
	}

	.tabs__tab {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 7px;
		height: 42px;
		padding: 0 14px;
		border: 0;
		background: none;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		font-weight: var(--fw-medium);
		text-decoration: none;
		white-space: nowrap;
		--icon-size: var(--icon-md);
	}

	.tabs__tab:hover:not(:disabled, .is-busy) {
		color: var(--text-primary);
	}

	/* Measured with the current weight, so a tab never grows when it becomes current. */
	.tabs__tab.is-current {
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.tabs__tab:disabled,
	.tabs__tab.is-busy {
		color: var(--text-muted);
		cursor: progress;
	}

	.tabs__tab:focus-visible {
		outline-offset: -3px;
	}

	.tabs__count {
		min-width: 18px;
		padding: 0 5px;
		border-radius: var(--radius-pill);
		background: var(--bg-hover);
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-variant-numeric: tabular-nums;
		line-height: 17px;
		text-align: center;
	}

	/* One underline that slides to the current tab. */
	.tabs__indicator {
		position: absolute;
		bottom: -1px;
		left: 0;
		width: var(--w);
		height: 2px;
		border-radius: 2px 2px 0 0;
		background: var(--primary);
		translate: var(--x) 0;
		opacity: 0;
	}

	.tabs__indicator.is-ready {
		opacity: 1;
		transition:
			translate 240ms cubic-bezier(0.2, 0.8, 0.2, 1),
			width 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	/* "More" sits right after the last tab that fits. */
	.tabs__more {
		flex-shrink: 0;
	}

	.tabs__more :global(.popover__trigger) {
		height: 42px;
	}

	.tabs__more-trigger {
		--icon-size: var(--icon-xs);
	}

	.tabs__more :global(.popover__trigger[aria-expanded='true'] .tabs__more-trigger) {
		color: var(--text-primary);
	}

	.tabs__menu {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tabs__menu-item {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		min-height: 36px;
		padding: 6px 10px;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		text-align: start;
		text-decoration: none;
		--icon-size: var(--icon-md);
	}

	.tabs__menu-item:hover,
	.tabs__menu-item:focus-visible {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/* Zero-size box: the copy keeps its natural widths but never adds to the page's width. */
	.tabs__ruler {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		width: 0;
		height: 0;
		overflow: hidden;
		visibility: hidden;
		pointer-events: none;
	}

	.tabs__panel {
		min-width: 0;
		outline: none;
	}

	.tabs__panel-body {
		animation: tab-panel-in 200ms ease-out both;
	}

	@keyframes tab-panel-in {
		from {
			opacity: 0;
			translate: 0 4px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tabs__indicator.is-ready {
			transition: none;
		}
		.tabs__panel-body {
			animation: none;
		}
	}
</style>

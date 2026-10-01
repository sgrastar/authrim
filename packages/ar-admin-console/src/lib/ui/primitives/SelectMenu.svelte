<script lang="ts" module>
	import type { IconName } from '../icons/icons';
	import type { ChoiceOption } from './RadioGroup.svelte';

	export interface MenuOption extends ChoiceOption {
		/** Leading icon. */
		icon?: IconName;
		/** Short tag at the end of the row, e.g. a data type ("String") or a count. */
		badge?: string;
		/** Monospace label, for keys and identifiers. */
		mono?: boolean;
		/** Heading of the group this option belongs to; consecutive options share one heading. */
		group?: string;
	}
</script>

<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import TypeBadge from './TypeBadge.svelte';
	import { useChangeMark } from '../save/save-scope';

	/**
	 * A dropdown whose rows carry more than text: an icon, a key in monospace, a badge, a
	 * second line, group headings, or rows drawn by the caller (`option`). Use Select (native)
	 * wherever plain text is enough — it has the platform pickers for free.
	 *
	 * Follows the "select-only combobox" pattern: focus stays on the button while the list is
	 * open, and the active row is pointed at with aria-activedescendant.
	 * - ↓ / ↑ / Enter / Space open; in the list ↓ ↑ Home End move, Enter / Space choose,
	 *   Esc or Tab close; typing jumps to the row starting with the typed letters.
	 * - Disabled rows stay visible (say why with `description` or `hint`) and are skipped.
	 * - The list sits in the top layer (popover) under the button, or above it near the
	 *   bottom of the screen, so no scrolling container clips it.
	 * - `cascade`: for long lists in groups, the list shows the group headings and each
	 *   group's options open beside it (hover or press a heading). ↓ / ↑ still walk every
	 *   option in order, opening its group as they go; screen readers hear the options in
	 *   their groups as usual.
	 */
	interface Props {
		label: string;
		options: readonly MenuOption[];
		value?: string;
		/** Shown while nothing is chosen. */
		placeholder?: string;
		hint?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		/** Keep the label for screen readers only. */
		hideLabel?: boolean;
		size?: 'md' | 'sm';
		/**
		 * `inline`: no box — the choice reads as a word in a sentence ("Country | is one of |
		 * Japan"), showing its frame on hover and focus. Width follows the text.
		 */
		variant?: 'box' | 'inline';
		/** Open the list as soon as it appears (a row just added, waiting for its first choice). */
		autoOpen?: boolean;
		/** Groups as a first level, their options opening beside it (needs `group` on options). */
		cascade?: boolean;
		/** Draws a row's content (list and button) instead of icon, label, badge and description. */
		option?: Snippet<[MenuOption]>;
		onchange?: (value: string) => void;
		/** Path in the SaveScope draft; once the value differs from the saved one it is marked. */
		field?: string;
		/** Mark as changed explicitly (when `field` cannot express the comparison). */
		changed?: boolean;
	}

	let {
		label,
		options,
		value = $bindable(''),
		placeholder = t('select.placeholder'),
		hint,
		error,
		required = false,
		disabled = false,
		hideLabel = false,
		size = 'md',
		variant = 'box',
		autoOpen = false,
		cascade = false,
		option: custom,
		onchange,
		field,
		changed
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const isChanged = $derived(changed ?? changes.changed(field, value));
	const off = $derived(disabled || busy());

	let trigger = $state<HTMLButtonElement>();
	let list = $state<HTMLDivElement>();
	let open = $state(false);
	let active = $state(-1);

	const current = $derived(options.find((option) => option.value === value));
	const describedBy = $derived(
		[hint ? `${uid}-hint` : '', error ? `${uid}-error` : ''].filter(Boolean).join(' ') || undefined
	);

	/** Consecutive options with the same `group`, each run under one heading. */
	const groups = $derived.by(() => {
		const runs: { heading?: string; items: { option: MenuOption; index: number }[] }[] = [];
		options.forEach((option, index) => {
			const last = runs.at(-1);
			if (last && last.heading === option.group) last.items.push({ option, index });
			else runs.push({ heading: option.group, items: [{ option, index }] });
		});
		return runs;
	});
	const optionId = (index: number) => `${uid}-option-${index}`;

	/** Cascade: the group whose options show beside the list (-1: none). */
	let flyGroup = $state(-1);
	const flies: HTMLElement[] = $state([]);
	const groupOf = (index: number) =>
		groups.findIndex((run) => run.items.some((item) => item.index === index));

	function placeFly() {
		const fly = flies[flyGroup];
		const heading = list?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-group-${flyGroup}`)}`);
		if (!fly || !heading || !list) return;
		const gap = 4;
		const outer = list.getBoundingClientRect();
		const row = heading.getBoundingClientRect();
		const box = fly.getBoundingClientRect();
		const rtl = getComputedStyle(list).direction === 'rtl';
		// Beside the list on the reading side; the other side when there is no room.
		const after = rtl ? outer.left - box.width + 2 : outer.right - 2;
		const before = rtl ? outer.right - 2 : outer.left - box.width + 2;
		const fits = (x: number) => x >= gap && x + box.width <= innerWidth - gap;
		const left = fits(after) ? after : fits(before) ? before : outer.left;
		const top = Math.min(row.top - 5, innerHeight - box.height - gap);
		fly.style.left = `${Math.min(Math.max(gap, left), innerWidth - box.width - gap)}px`;
		fly.style.top = `${Math.max(gap, top)}px`;
	}

	function openFly(g: number) {
		if (!cascade || g < 0 || g === flyGroup || !open) return;
		closeFly();
		flyGroup = g;
		flies[g]?.showPopover();
		placeFly();
	}

	/** A heading pointed at: its options show, and the keys carry on from its first one. */
	function enterGroup(g: number) {
		openFly(g);
		if (groupOf(active) === g) return;
		const first = groups[g]?.items.find(({ option }) => !option.disabled);
		if (first) active = first.index;
	}

	function closeFly() {
		if (flyGroup >= 0 && flies[flyGroup]?.matches(':popover-open')) flies[flyGroup].hidePopover();
		flyGroup = -1;
	}

	function place() {
		if (!trigger || !list) return;
		const at = trigger.getBoundingClientRect();
		const gap = 4;
		// An inline trigger is narrow; its list still needs room for the options.
		list.style.minWidth = `${Math.max(at.width, 192)}px`;
		const size = list.getBoundingClientRect();
		const below = innerHeight - at.bottom - gap;
		const top =
			below >= size.height || below >= at.top ? at.bottom + gap : at.top - gap - size.height;
		const rtl = getComputedStyle(trigger).direction === 'rtl';
		const left = rtl ? at.right - size.width : at.left;
		list.style.top = `${Math.max(gap, top)}px`;
		list.style.left = `${Math.min(Math.max(gap, left), innerWidth - size.width - gap)}px`;
		placeFly();
	}

	/** The next row that can be chosen, from `from` in `step` direction. */
	function enabledFrom(from: number, step: 1 | -1): number {
		for (let i = from; i >= 0 && i < options.length; i += step) {
			if (!options[i].disabled) return i;
		}
		return active;
	}

	async function show() {
		if (off || open || !list?.showPopover) return;
		const chosen = options.findIndex((option) => option.value === value);
		active = chosen >= 0 ? chosen : enabledFrom(0, 1);
		// Safari does not focus a pressed button; the list closes when focus leaves it.
		trigger?.focus();
		list.showPopover();
		open = true;
		place();
		if (cascade) openFly(Math.max(0, groupOf(active)));
		await tick();
		reveal();
	}

	function hide() {
		if (!open) return;
		closeFly();
		open = false;
		if (list?.matches(':popover-open')) list.hidePopover();
	}

	function reveal() {
		list?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' });
	}

	function choose(index: number) {
		const option = options[index];
		if (!option || option.disabled) return;
		hide();
		if (option.value === value) return;
		value = option.value;
		onchange?.(value);
	}

	async function moveTo(index: number) {
		active = index;
		if (cascade) openFly(groupOf(index));
		await tick();
		reveal();
	}

	let typed = '';
	let typedAt = 0;
	/** Jump to the row whose label starts with what was typed (the last half-second). */
	function typeAhead(key: string) {
		const now = Date.now();
		typed = now - typedAt > 500 ? key : typed + key;
		typedAt = now;
		const text = typed.toLowerCase();
		const start = typed.length === 1 ? active + 1 : active;
		const order = [...options.keys()].map((i) => (start + i) % options.length);
		const found = order.find(
			(i) => !options[i].disabled && options[i].label.toLowerCase().startsWith(text)
		);
		if (found !== undefined) moveTo(found);
	}

	async function keydown(event: KeyboardEvent) {
		if (!open) {
			if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
				event.preventDefault();
				await show();
			}
			return;
		}
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				moveTo(enabledFrom(active + 1, 1));
				break;
			case 'ArrowUp':
				event.preventDefault();
				moveTo(enabledFrom(active - 1, -1));
				break;
			case 'Home':
				event.preventDefault();
				moveTo(enabledFrom(0, 1));
				break;
			case 'End':
				event.preventDefault();
				moveTo(enabledFrom(options.length - 1, -1));
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				choose(active);
				break;
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				hide();
				break;
			case 'Tab':
				hide();
				break;
			default:
				if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
					typeAhead(event.key);
				}
		}
	}

	/** While open, keep the list under the button when the page scrolls or resizes. */
	$effect(() => {
		if (!open) return;
		addEventListener('scroll', place, true);
		addEventListener('resize', place);
		return () => {
			removeEventListener('scroll', place, true);
			removeEventListener('resize', place);
		};
	});

	onMount(() => {
		if (autoOpen) show();
	});
</script>

{#snippet content(item: MenuOption, inList: boolean)}
	{#if custom}
		{@render custom(item)}
	{:else}
		{#if item.icon}<span class="menu__icon"><Icon name={item.icon} /></span>{/if}
		<span class="menu__text">
			<span class="menu__label" class:is-mono={item.mono}>{item.label}</span>
			{#if inList && item.description}<span class="menu__desc">{item.description}</span>{/if}
		</span>
		{#if item.badge}<TypeBadge muted={item.disabled}>{item.badge}</TypeBadge>{/if}
	{/if}
{/snippet}

{#snippet row(item: MenuOption, index: number)}
	<!-- Keys are handled on the combobox button, which keeps focus (aria-activedescendant). -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<li
		id={optionId(index)}
		class="menu__option"
		class:is-active={index === active}
		role="option"
		aria-selected={item.value === value}
		aria-disabled={item.disabled || undefined}
		onpointermove={() => {
			if (!item.disabled) active = index;
		}}
		onclick={() => choose(index)}
	>
		<span class="menu__check" aria-hidden="true">
			{#if item.value === value}<Icon name="check" />{/if}
		</span>
		{@render content(item, true)}
	</li>
{/snippet}

<div
	class="select-menu"
	class:select-menu--sm={size === 'sm'}
	class:select-menu--inline={variant === 'inline'}
	class:is-changed={isChanged}
	class:is-open={open}
	class:has-error={!!error}
>
	<span class="select-menu__label" class:sr-only={hideLabel} id="{uid}-label"
		>{label}{#if isChanged}<span class="sr-only">
				({t('common.changed')})</span
			>{/if}{#if required}<span class="select-menu__req" aria-hidden="true">*</span>{/if}</span
	>
	<button
		bind:this={trigger}
		type="button"
		class="select-menu__button"
		role="combobox"
		aria-labelledby="{uid}-label"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls="{uid}-list"
		aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
		aria-describedby={describedBy}
		aria-required={required || undefined}
		aria-invalid={error ? 'true' : undefined}
		disabled={off}
		onclick={(event) => {
			// Keys are handled in keydown; a click from Enter or Space has no pointer detail.
			if (event.detail === 0) return;
			if (open) hide();
			else show();
		}}
		onkeydown={keydown}
		onblur={hide}
	>
		<span class="select-menu__value">
			{#if current}
				{@render content(current, false)}
			{:else}
				<span class="menu__label is-placeholder">{placeholder}</span>
			{/if}
		</span>
		<span class="select-menu__caret" aria-hidden="true"><Icon name="caret" /></span>
	</button>
	{#if hint}<p class="select-menu__hint" id="{uid}-hint">{hint}</p>{/if}
	{#if error}<p class="select-menu__error" id="{uid}-error">{error}</p>{/if}

	<!-- Pressing a row must not take focus from the button (that would close the list). -->
	<div
		bind:this={list}
		id="{uid}-list"
		class="menu"
		class:menu--sm={size === 'sm'}
		role="listbox"
		tabindex="-1"
		aria-labelledby="{uid}-label"
		popover="manual"
		onpointerdown={(event) => event.preventDefault()}
	>
		{#if cascade}
			{#each groups as run, g (g)}
				{@const holdsValue = run.items.some((item) => item.option.value === value)}
				<div class="cascade__group" role="group" aria-labelledby="{uid}-group-{g}">
					<!-- Pointer only: keys walk the options on the combobox button. -->
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div
						class="cascade__heading"
						class:is-active={g === flyGroup}
						id="{uid}-group-{g}"
						onpointerenter={() => enterGroup(g)}
						onclick={() => enterGroup(g)}
					>
						<span class="menu__check" aria-hidden="true">
							{#if holdsValue}<Icon name="check" />{/if}
						</span>
						<span class="cascade__label">{run.heading}</span>
						<span class="cascade__caret" aria-hidden="true"><Icon name="caretRight" /></span>
					</div>
					<div
						bind:this={flies[g]}
						class="menu cascade__fly"
						class:menu--sm={size === 'sm'}
						role="presentation"
						tabindex="-1"
						popover="manual"
						onpointerdown={(event) => event.preventDefault()}
					>
						<ul class="menu__group" role="presentation">
							{#each run.items as { option: item, index } (item.value)}
								{@render row(item, index)}
							{/each}
						</ul>
					</div>
				</div>
			{/each}
		{:else}
			{#each groups as run, g (g)}
				<ul
					class="menu__group"
					role={run.heading ? 'group' : 'presentation'}
					aria-labelledby={run.heading ? `${uid}-group-${g}` : undefined}
				>
					{#if run.heading}
						<li class="menu__heading" id="{uid}-group-{g}" role="presentation">{run.heading}</li>
					{/if}
					{#each run.items as { option: item, index } (item.value)}
						{@render row(item, index)}
					{/each}
				</ul>
			{/each}
		{/if}
	</div>
</div>

<style>
	.select-menu {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.select-menu__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.select-menu__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	.select-menu__button {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
		height: var(--control-h);
		padding-inline: 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
		text-align: start;
		cursor: pointer;
	}

	/* Inline: a word in a sentence. The frame shows on hover and focus only. */
	.select-menu--inline {
		display: inline-grid;
		max-width: 100%;
	}

	.select-menu--inline .select-menu__button {
		width: auto;
		max-width: 18rem;
		height: var(--control-h-sm);
		padding-inline: 6px 4px;
		gap: 4px;
		border-color: transparent;
		background: transparent;
		font-size: var(--fs-body);
	}

	.select-menu--inline .select-menu__button:hover:not(:disabled) {
		border-color: var(--border);
		background: var(--bg-input);
	}

	.select-menu--inline .select-menu__caret {
		--icon-size: var(--icon-xs);
	}

	.select-menu--sm .select-menu__button {
		height: var(--control-h-sm);
		padding-inline: 8px;
		font-size: var(--fs-label);
	}

	.select-menu__button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.select-menu__button:focus-visible,
	.is-open .select-menu__button {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	.has-error .select-menu__button {
		border-color: var(--danger);
	}

	/* Changed, not saved yet: the box takes the change colour. */
	.is-changed .select-menu__button {
		border-color: var(--changed-edge);
		background-image: linear-gradient(var(--changed-bg), var(--changed-bg));
	}

	.select-menu__value {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.select-menu__caret {
		display: inline-flex;
		color: var(--text-muted);
		--icon-size: var(--icon-sm);
	}

	.select-menu__hint,
	.select-menu__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.select-menu__hint {
		color: var(--text-muted);
	}

	.select-menu__error {
		color: var(--danger);
	}

	/* Top layer, placed under the button by script (popovers default to the centre). */
	.menu {
		position: fixed;
		inset: auto;
		max-width: min(420px, calc(100vw - 16px));
		max-height: 300px;
		margin: 0;
		padding: 4px;
		overflow-y: auto;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
	}

	.menu__group {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Cascade: group headings in the list, each group's options beside it. */
	.cascade__heading {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--control-h-dense);
		padding: 4px 6px 4px 4px;
		border-radius: var(--radius-xs);
		font-size: var(--fs-body);
		cursor: pointer;
	}

	.menu--sm .cascade__heading {
		min-height: var(--control-h-sm);
		font-size: var(--fs-label);
	}

	.cascade__heading.is-active {
		background: var(--bg-hover);
	}

	.cascade__label {
		flex: 1;
		min-width: 0;
	}

	.cascade__caret {
		display: inline-flex;
		color: var(--text-muted);
		--icon-size: var(--icon-xs);
	}

	.cascade__fly {
		min-width: 200px;
	}

	.menu__group + .menu__group {
		margin-top: 4px;
		padding-top: 4px;
		border-top: 1px solid var(--border-subtle);
	}

	.menu__heading {
		padding: 6px 8px 4px 28px;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.menu__option {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--control-h-dense);
		padding: 4px 8px 4px 4px;
		border-radius: var(--radius-xs);
		font-size: var(--fs-body);
		cursor: pointer;
	}

	.menu--sm .menu__option {
		min-height: var(--control-h-sm);
		font-size: var(--fs-label);
	}

	.menu__option.is-active {
		background: var(--bg-hover);
	}

	/* Disabled rows stay readable (the reason is often in the row) but plainly unavailable. */
	.menu__option[aria-disabled='true'] {
		color: var(--text-muted);
		cursor: not-allowed;
	}

	.menu__check {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 16px;
		color: var(--primary);
		--icon-size: var(--icon-sm);
	}

	.menu__icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-secondary);
		--icon-size: var(--icon-md);
	}

	.menu__text {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.menu__label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Keys and types read left to right, also inside right-to-left text (Design rules). */
	.menu__label.is-mono {
		unicode-bidi: isolate;
		direction: ltr;
	}

	.menu__label.is-mono {
		font-family: var(--font-mono);
		font-size: 0.93em;
	}

	.menu__label.is-placeholder {
		color: var(--text-muted);
	}

	.menu__desc {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>

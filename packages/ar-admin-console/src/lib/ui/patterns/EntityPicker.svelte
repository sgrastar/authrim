<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface PickerItem {
		/** What is stored (an ID). */
		value: string;
		/** What people see (a name, an email address). */
		label: string;
		/** A second line that tells similar items apart (email, client ID). */
		description?: string;
		icon?: IconName;
	}
</script>

<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import { useChangeMark } from '../save/save-scope';

	/**
	 * Find things by typing and pick one or several: members of a group, roles to assign,
	 * clients a grant covers. The list comes from `search` (usually the Admin API), so it
	 * works for thousands of users.
	 *
	 * Editable combobox (WAI-ARIA): focus stays in the text box; ↓ / ↑ move through results,
	 * Enter picks, Esc closes, Backspace in an empty box removes the last pick. Picks show as
	 * chips with their own remove button; each pick and removal is announced. Results that are
	 * already picked stay listed, marked "Selected".
	 */
	interface Props {
		label: string;
		/** The picked items (with labels, so chips can be shown without another lookup). */
		items?: PickerItem[];
		/** Finds items for the typed text; an empty query may return suggestions. */
		search: (query: string, signal: AbortSignal) => Promise<PickerItem[]>;
		/** Pick several (chips) or one (the pick replaces the previous one). */
		multiple?: boolean;
		/** What can be searched ("Name or email"). */
		placeholder?: string;
		hint?: string;
		error?: string;
		max?: number;
		required?: boolean;
		disabled?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		items = $bindable([]),
		search,
		multiple = true,
		placeholder,
		hint,
		error,
		max,
		required = false,
		disabled = false,
		field,
		changed
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const isChanged = $derived(changed ?? changes.changed(field, items));
	const off = $derived(disabled || busy());
	const full = $derived(multiple && max !== undefined && items.length >= max);

	let box = $state<HTMLDivElement>();
	let input = $state<HTMLInputElement>();
	let list = $state<HTMLDivElement>();
	let query = $state('');
	let open = $state(false);
	let active = $state(-1);
	let results = $state<PickerItem[]>([]);
	let status = $state<'idle' | 'loading' | 'error' | 'done'>('idle');
	let announcement = $state('');

	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;

	const picked = (value: string) => items.some((item) => item.value === value);
	const optionId = (index: number) => `${uid}-option-${index}`;

	function run(text: string) {
		clearTimeout(timer);
		timer = setTimeout(async () => {
			controller?.abort();
			const current = new AbortController();
			controller = current;
			status = 'loading';
			try {
				const found = await search(text.trim(), current.signal);
				if (current.signal.aborted) return;
				results = found;
				active = found.findIndex((item) => !picked(item.value));
				status = 'done';
				place();
			} catch (reason) {
				if (current.signal.aborted || (reason as Error)?.name === 'AbortError') return;
				results = [];
				status = 'error';
			}
		}, 200);
	}

	function place() {
		if (!box || !list) return;
		const at = box.getBoundingClientRect();
		const gap = 4;
		list.style.width = `${at.width}px`;
		const height = list.getBoundingClientRect().height;
		const below = innerHeight - at.bottom - gap;
		const top = below >= height || below >= at.top ? at.bottom + gap : at.top - gap - height;
		list.style.top = `${Math.max(gap, top)}px`;
		list.style.left = `${at.left}px`;
	}

	async function show() {
		if (off || open || full || !list?.showPopover) return;
		list.showPopover();
		open = true;
		place();
		run(query);
		await tick();
		place();
	}

	function hide() {
		if (!open) return;
		open = false;
		active = -1;
		if (list?.matches(':popover-open')) list.hidePopover();
	}

	function choose(item: PickerItem | undefined) {
		if (!item || picked(item.value)) return;
		items = multiple ? [...items, item] : [item];
		announcement = t('picker.added', { name: item.label });
		query = '';
		if (!multiple || (max !== undefined && items.length >= max)) hide();
		else run('');
	}

	async function remove(item: PickerItem) {
		items = items.filter((entry) => entry.value !== item.value);
		announcement = t('picker.removed', { name: item.label });
		await tick();
		input?.focus();
	}

	function move(by: 1 | -1) {
		if (!results.length) return;
		let next = active;
		for (let i = 0; i < results.length; i++) {
			next = (next + by + results.length) % results.length;
			if (!picked(results[next].value)) break;
		}
		active = next;
		list?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' });
	}

	function keydown(event: KeyboardEvent) {
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp':
				event.preventDefault();
				if (!open) show();
				else move(event.key === 'ArrowDown' ? 1 : -1);
				break;
			case 'Enter':
				if (open && active >= 0) {
					event.preventDefault();
					choose(results[active]);
				}
				break;
			case 'Escape':
				if (open) {
					event.preventDefault();
					event.stopPropagation();
					hide();
				}
				break;
			case 'Backspace':
				if (!query && multiple && items.length) remove(items[items.length - 1]);
				break;
		}
	}

	/** Leaving the whole picker (not moving between its chips and box) closes the list. */
	function focusout(event: FocusEvent) {
		if (!box?.contains(event.relatedTarget as Node | null)) hide();
	}

	$effect(() => {
		if (!open) return;
		addEventListener('scroll', place, true);
		addEventListener('resize', place);
		return () => {
			removeEventListener('scroll', place, true);
			removeEventListener('resize', place);
		};
	});

	onDestroy(() => {
		clearTimeout(timer);
		controller?.abort();
	});

	const describedBy = $derived(
		[hint ? `${uid}-hint` : '', error ? `${uid}-error` : ''].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="picker" class:is-changed={isChanged} class:has-error={!!error} class:is-off={off}>
	<label class="picker__label" for="{uid}-input">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="picker__req" aria-hidden="true">*</span>{/if}
	</label>
	<!-- The box focuses the text field when its empty space is pressed. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="picker__box" bind:this={box} onfocusout={focusout} onclick={() => input?.focus()}>
		{#if items.length}
			<ul class="picker__chips" aria-label={label}>
				{#each items as item (item.value)}
					<li class="chip">
						{#if item.icon}<Icon name={item.icon} />{/if}
						<span class="chip__label">{item.label}</span>
						<button
							type="button"
							class="chip__remove"
							aria-label={t('picker.remove', { name: item.label })}
							disabled={off}
							onclick={(event) => {
								event.stopPropagation();
								remove(item);
							}}><Icon name="close" /></button
						>
					</li>
				{/each}
			</ul>
		{/if}
		<input
			bind:this={input}
			id="{uid}-input"
			type="text"
			role="combobox"
			autocomplete="off"
			spellcheck="false"
			aria-autocomplete="list"
			aria-expanded={open}
			aria-controls="{uid}-list"
			aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
			aria-describedby={describedBy}
			aria-invalid={error ? 'true' : undefined}
			placeholder={full ? '' : placeholder}
			bind:value={query}
			disabled={disabled || full}
			readonly={busy()}
			onfocus={show}
			onclick={show}
			oninput={() => {
				if (!open) show();
				else run(query);
			}}
			onkeydown={keydown}
		/>
	</div>
	{#if hint}<p class="picker__hint" id="{uid}-hint">{hint}</p>{/if}
	{#if error}<p class="picker__error" id="{uid}-error">{error}</p>{/if}

	<!-- Pressing a result must not take focus from the text box (that would close the list). -->
	<div
		bind:this={list}
		class="picker__list"
		role="presentation"
		popover="manual"
		onpointerdown={(event) => event.preventDefault()}
	>
		<ul
			id="{uid}-list"
			role="listbox"
			tabindex="-1"
			aria-label={label}
			aria-multiselectable={multiple || undefined}
		>
			{#each results as item, index (item.value)}
				{@const isPicked = picked(item.value)}
				<!-- Keys are handled in the text box, which keeps focus (aria-activedescendant). -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id={optionId(index)}
					class="picker__option"
					class:is-active={index === active}
					role="option"
					aria-selected={isPicked}
					aria-disabled={isPicked || undefined}
					onpointermove={() => {
						if (!isPicked) active = index;
					}}
					onclick={() => choose(item)}
				>
					{#if item.icon}<span class="picker__icon"><Icon name={item.icon} /></span>{/if}
					<span class="picker__text">
						<span class="picker__name">{item.label}</span>
						{#if item.description}<span class="picker__desc">{item.description}</span>{/if}
					</span>
					{#if isPicked}<span class="picker__chosen">{t('picker.chosen')}</span>{/if}
				</li>
			{/each}
		</ul>
		{#if status === 'loading'}
			<p class="picker__status" role="status">{t('picker.searching')}</p>
		{:else if status === 'error'}
			<p class="picker__status is-error" role="status">{t('picker.failed')}</p>
		{:else if status === 'done' && results.length === 0}
			<p class="picker__status" role="status">{t('picker.none')}</p>
		{/if}
	</div>
	<p class="sr-only" aria-live="polite">{announcement}</p>
</div>

<style>
	.picker {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.picker__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.picker__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	/* Chips and the text box share one field that grows as picks are added. */
	.picker__box {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		min-height: var(--control-h);
		padding: 3px 6px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		cursor: text;
	}

	.picker__box:focus-within {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
	}

	.is-changed .picker__box {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	.has-error .picker__box {
		border-color: var(--danger);
	}

	.is-off .picker__box {
		background: var(--bg-subtle);
		cursor: default;
	}

	.picker__chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		max-width: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		height: var(--control-h-xs);
		padding-inline: 8px 2px;
		border: 1px solid var(--border);
		border-radius: var(--radius-badge);
		background: var(--bg-subtle);
		color: var(--text-primary);
		font-size: var(--fs-body);
		--icon-size: var(--icon-sm);
	}

	.chip__label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip__remove {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-round);
		background: transparent;
		color: var(--text-muted);
		--icon-size: var(--icon-xs);
	}

	.chip__remove:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	input {
		flex: 1 1 8rem;
		min-width: 6rem;
		height: calc(var(--control-h) - 8px);
		padding: 0 4px;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
		outline: none;
	}

	input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	.picker__hint,
	.picker__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.picker__hint {
		color: var(--text-muted);
	}

	.picker__error {
		color: var(--danger);
	}

	/* Top layer, placed under the field by script. */
	.picker__list {
		position: fixed;
		inset: auto;
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

	.picker__list ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.picker__option {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--control-h-dense);
		padding: 4px 8px;
		border-radius: var(--radius-xs);
		cursor: pointer;
	}

	.picker__option.is-active {
		background: var(--bg-hover);
	}

	.picker__option[aria-disabled='true'] {
		color: var(--text-muted);
		cursor: default;
	}

	.picker__icon {
		display: inline-flex;
		color: var(--text-secondary);
		--icon-size: var(--icon-md);
	}

	.picker__text {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.picker__name {
		font-size: var(--fs-body);
		font-weight: var(--fw-name);
	}

	.picker__desc {
		color: var(--text-muted);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	.picker__chosen {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.picker__status {
		margin: 0;
		padding: 8px;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.picker__status.is-error {
		color: var(--danger);
	}
</style>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';

	/**
	 * Search box for a list. The label is kept for screen readers (the magnifier and the list
	 * above make the purpose plain); the placeholder names what can be searched ("Name, email
	 * or ID"), which is the one kind of placeholder allowed to say something (Design rules ›
	 * Placeholders).
	 * - `onsearch` fires a moment after typing stops, and at once on Enter or clear.
	 * - The × clears the query and returns focus to the box; Esc does the same.
	 */
	interface Props {
		label: string;
		value?: string;
		placeholder?: string;
		size?: 'md' | 'sm';
		/** Show the label above the box instead of keeping it for screen readers only. */
		showLabel?: boolean;
		/** Milliseconds after the last keystroke before `onsearch`. */
		delay?: number;
		onsearch?: (query: string) => void;
	}

	let {
		label,
		value = $bindable(''),
		placeholder,
		size = 'md',
		showLabel = false,
		delay = 250,
		onsearch
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	let input = $state<HTMLInputElement>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function search(now = false) {
		clearTimeout(timer);
		if (now) onsearch?.(value.trim());
		else timer = setTimeout(() => onsearch?.(value.trim()), delay);
	}

	function clear() {
		value = '';
		search(true);
		input?.focus();
	}

	onDestroy(() => clearTimeout(timer));
</script>

<div class="search" class:search--sm={size === 'sm'}>
	<label class="search__label" class:sr-only={!showLabel} for="{uid}-input">{label}</label>
	<div class="search__box">
		<span class="search__icon" aria-hidden="true"><Icon name="search" /></span>
		<input
			bind:this={input}
			id="{uid}-input"
			type="search"
			bind:value
			{placeholder}
			autocomplete="off"
			spellcheck="false"
			readonly={busy()}
			oninput={() => search()}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					search(true);
				} else if (event.key === 'Escape' && value) {
					event.preventDefault();
					clear();
				}
			}}
		/>
		{#if value}
			<button
				type="button"
				class="search__clear"
				aria-label={t('filter.clearSearch')}
				onclick={clear}
			>
				<Icon name="close" />
			</button>
		{/if}
	</div>
</div>

<style>
	.search {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.search__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.search__box {
		position: relative;
		display: flex;
		align-items: center;
	}

	.search__icon {
		position: absolute;
		inset-inline-start: 10px;
		display: inline-flex;
		color: var(--text-muted);
		pointer-events: none;
		--icon-size: var(--icon-md);
	}

	input {
		width: 100%;
		min-width: 0;
		height: var(--control-h);
		padding-inline: 34px 34px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
		appearance: none;
	}

	/* The browser's own clear button would sit next to ours. */
	input::-webkit-search-cancel-button {
		appearance: none;
	}

	input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	input:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	input[readonly] {
		background: var(--bg-subtle);
		cursor: progress;
	}

	.search--sm input {
		height: var(--control-h-sm);
		padding-inline: 30px;
		font-size: var(--fs-body);
	}

	.search--sm .search__icon {
		inset-inline-start: 9px;
		--icon-size: var(--icon-sm);
	}

	.search__clear {
		position: absolute;
		inset-inline-end: 4px;
		display: grid;
		place-items: center;
		width: var(--control-h-xs);
		height: var(--control-h-xs);
		padding: 0;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-muted);
		--icon-size: var(--icon-sm);
	}

	.search__clear:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
</style>

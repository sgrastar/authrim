<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface PickerItem {
		value: string;
		label: string;
		description?: string;
		/** Other words it is found by (its id, an English name). */
		keywords?: string;
		/** Short facts at the row's end (what a step gives: "boolean"). */
		badges?: readonly string[];
	}

	export interface PickerGroup {
		id: string;
		label: string;
		icon?: IconName;
		/** Said while the group has nothing ("Steps from plugins appear here"). */
		empty?: string;
		items: readonly PickerItem[];
	}
</script>

<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '../primitives/Button.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import SearchField from '../primitives/SearchField.svelte';
	import ColumnBrowser, { type BrowserItem } from './ColumnBrowser.svelte';

	/**
	 * Choosing one from a catalogue too long for a dropdown (the steps of an attribute mapping),
	 * in a ColumnBrowser: groups, the group's items, and a preview of the item looked at — what
	 * it does, and the button that applies it. Looking and choosing are two moves, so an item
	 * can be read about before it is used.
	 *
	 * - The search at the top narrows the groups and the items to what matches (names,
	 *   descriptions, keywords); the counts follow.
	 * - The current choice opens first, and its button says it is the current one.
	 * - Built on <dialog>: focus stays inside, Esc closes, focus comes back to what opened it.
	 */
	interface Props {
		open: boolean;
		title: string;
		groups: readonly PickerGroup[];
		/** The current choice: opened first, its button disabled. */
		value?: string | null;
		/** The group to open when there is no current choice. */
		startGroup?: string;
		/** The preview's button ("Add this step", "Use this step instead"). */
		chooseLabel: string;
		/** What the button says on the current choice. */
		currentLabel: string;
		/** More for the preview under the description (a demo, the settings). */
		preview?: Snippet<[PickerItem]>;
		onchoose: (value: string) => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		groups,
		value = null,
		startGroup,
		chooseLabel,
		currentLabel,
		preview,
		onchoose,
		oncancel
	}: Props = $props();

	const uid = $props.id();
	let dialog = $state<HTMLDialogElement>();
	let query = $state('');
	let groupId = $state('');
	let itemId = $state('');

	interface Row extends BrowserItem {
		item: PickerItem;
	}

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			query = '';
			groupId =
				groups.find((group) => group.items.some((item) => item.value === value))?.id ??
				startGroup ??
				groups[0]?.id ??
				'';
			itemId = value ?? '';
			dialog.showModal();
			tick().then(() => dialog?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
		}
		if (!open && dialog.open) dialog.close();
	});

	const words = (item: PickerItem) =>
		`${item.label} ${item.description ?? ''} ${item.keywords ?? ''}`.toLowerCase();

	/** Everything, or only what the search matches (and the groups that have it). */
	const rows = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return groups.flatMap((group) =>
			group.items
				.filter((item) => !q || words(item).includes(q))
				.map(
					(item): Row => ({
						id: item.value,
						groupId: group.id,
						label: item.label,
						badges: item.badges,
						item
					})
				)
		);
	});
	// Every group while browsing (an empty one says why); only those with hits while searching.
	const shownGroups = $derived(
		query.trim() ? groups.filter((group) => rows.some((row) => row.groupId === group.id)) : groups
	);

	// A search that hides the open group opens the first group that has a match.
	$effect(() => {
		if (shownGroups.length && !shownGroups.some((group) => group.id === groupId))
			groupId = shownGroups[0].id;
	});
</script>

<dialog
	bind:this={dialog}
	class="picker"
	aria-labelledby="{uid}-title"
	oncancel={(event) => {
		event.preventDefault();
		oncancel();
	}}
>
	<header class="picker__head">
		<h2 id="{uid}-title">{title}</h2>
		<IconButton icon="close" label={t('common.close')} onclick={oncancel} />
	</header>
	<div class="picker__search">
		<SearchField label={t('picker.search')} placeholder={t('picker.search')} bind:value={query} />
	</div>
	<div class="picker__body">
		{#if shownGroups.length}
			<ColumnBrowser label={title} groups={shownGroups} items={rows} bind:groupId bind:itemId>
				{#snippet detail(row)}
					<div class="picker__preview">
						<h3>{row.item.label}</h3>
						{#if row.item.description}<p>{row.item.description}</p>{/if}
						{@render preview?.(row.item)}
						<div class="picker__choose">
							{#if row.id === value}
								<Button variant="secondary" disabled>{currentLabel}</Button>
							{:else}
								<Button variant="primary" onclick={() => onchoose(row.id)}>{chooseLabel}</Button>
							{/if}
						</div>
					</div>
				{/snippet}
			</ColumnBrowser>
		{:else}
			<p class="picker__none" role="status">{t('picker.none')}</p>
		{/if}
	</div>
</dialog>

<style>
	.picker {
		width: min(980px, calc(100vw - 32px));
		max-height: min(680px, calc(100vh - 48px));
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		color: var(--text-primary);
		box-shadow: var(--shadow-lg);
	}

	.picker[open] {
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr);
		animation: picker-in 160ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}

	.picker::backdrop {
		background: var(--scrim);
	}

	.picker__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 14px 4px var(--dialog-pad-x);
	}

	h2 {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	.picker__search {
		padding: 8px var(--dialog-pad-x) 12px;
	}

	.picker__body {
		display: grid;
		min-height: 0;
		padding: 0 var(--dialog-pad-x) var(--dialog-pad-y);
		overflow: auto;
	}

	/* The browser fills the dialog's height; its columns scroll on their own. */
	.picker__body :global(.browser) {
		min-height: min(440px, 60vh);
	}

	.picker__preview {
		display: grid;
		gap: 12px;
	}

	h3 {
		margin: 0;
		font-size: var(--fs-heading);
		font-weight: var(--fw-semibold);
	}

	.picker__preview p {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-relaxed);
	}

	.picker__choose {
		display: flex;
		justify-content: flex-end;
		padding-top: 4px;
	}

	.picker__none {
		margin: 16px 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	@keyframes picker-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.98);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.picker[open] {
			animation: none;
		}
	}
</style>

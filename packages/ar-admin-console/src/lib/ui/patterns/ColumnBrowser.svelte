<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface BrowserGroup {
		id: string;
		label: string;
		icon?: IconName;
		/** Said in its column while the group has nothing (defaults to "nothing here yet"). */
		empty?: string;
	}

	export interface BrowserItem {
		id: string;
		groupId: string;
		label: string;
		/** Short facts shown at the row's end (data types). */
		badges?: readonly string[];
	}
</script>

<script lang="ts" generics="Item extends BrowserItem">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import TypeBadge from '../primitives/TypeBadge.svelte';

	/**
	 * Column browser for picking one template from a catalogue (e.g. SAML attribute profiles:
	 * General settings / Academic federation → GakuNin, REFEDS …). Categories with counts on the
	 * start side, the items of the chosen category next, and the chosen item's detail last.
	 * Ported from the legacy Admin UI template browser. Stacks vertically on narrow screens.
	 */
	interface Props {
		label: string;
		groups: readonly BrowserGroup[];
		items: readonly Item[];
		groupId?: string;
		itemId?: string;
		detail: Snippet<[Item]>;
	}

	let {
		label,
		groups,
		items,
		groupId = $bindable(''),
		itemId = $bindable(''),
		detail
	}: Props = $props();

	const currentGroup = $derived(groups.find((g) => g.id === groupId) ?? groups[0]);
	const groupItems = $derived(items.filter((item) => item.groupId === currentGroup?.id));
	const current = $derived(groupItems.find((item) => item.id === itemId));
	const count = (id: string) => items.filter((item) => item.groupId === id).length;
</script>

<div class="browser" role="group" aria-label={label}>
	<ul class="browser__col" aria-label={label}>
		{#each groups as group (group.id)}
			<li>
				<button
					type="button"
					class="browser__row"
					aria-pressed={group.id === currentGroup?.id}
					onclick={() => {
						groupId = group.id;
						itemId = '';
					}}
				>
					<Icon name={group.icon ?? 'folder'} />
					<span class="browser__text">{group.label}</span>
					<span class="browser__count">{count(group.id)}</span>
					<span class="browser__chevron" aria-hidden="true"><Icon name="caretRight" /></span>
				</button>
			</li>
		{/each}
	</ul>

	<!-- Choosing another category rebuilds the list, so its rows slide in afresh. -->
	{#key currentGroup?.id}
		<ul class="browser__col" aria-label={currentGroup?.label}>
			{#each groupItems as item, index (item.id)}
				<li class="browser__arrive" style:--i={index}>
					<button
						type="button"
						class="browser__row"
						aria-pressed={item.id === current?.id}
						onclick={() => (itemId = item.id)}
					>
						<span class="browser__text">{item.label}</span>
						{#if item.badges?.length}
							<span class="browser__badges">
								{#each item.badges as badge (badge)}<TypeBadge size="sm">{badge}</TypeBadge>{/each}
							</span>
						{/if}
						<span class="browser__chevron" aria-hidden="true"><Icon name="caretRight" /></span>
					</button>
				</li>
			{:else}
				<li class="browser__empty browser__arrive">{currentGroup?.empty ?? t('browser.none')}</li>
			{/each}
		</ul>
	{/key}

	<div class="browser__detail" aria-live="polite">
		{#if current}
			{#key current.id}
				<div class="browser__arrive">{@render detail(current)}</div>
			{/key}
		{:else}
			<p class="browser__empty">{t('browser.empty')}</p>
		{/if}
	</div>
</div>

<style>
	.browser {
		display: grid;
		grid-template-columns: minmax(180px, 0.8fr) minmax(220px, 1fr) minmax(260px, 1.2fr);
		min-height: 260px;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--surface-bg);
	}

	.browser__col {
		display: grid;
		align-content: start;
		gap: 2px;
		margin: 0;
		padding: 6px;
		overflow-y: auto;
		/* Rows sliding in start outside the column; no sideways scrollbar while they arrive. */
		overflow-x: hidden;
		border-inline-end: 1px solid var(--border-subtle);
		list-style: none;
	}

	.browser__col:first-child {
		background: var(--bg-subtle);
	}

	.browser__row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 8px;
		width: 100%;
		min-height: var(--control-h-dense);
		padding: 4px 8px;
		border: 0;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		text-align: start;
		--icon-size: var(--icon-md);
	}

	.browser__row:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.browser__row[aria-pressed='true'] {
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.browser__col:not(:first-child) .browser__row[aria-pressed='true'] {
		background: color-mix(in srgb, var(--primary) 9%, var(--bg-card));
	}

	/* A long name takes a second line (German, Arabic); beyond that it is cut. */
	.browser__text {
		display: -webkit-box;
		flex: 1 1 9rem;
		min-width: 0;
		overflow: hidden;
		line-height: var(--lh-snug);
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow-wrap: anywhere;
	}

	/* Beside the name while there is room; otherwise on the next line, at the end. */
	.browser__badges {
		display: inline-flex;
		flex-shrink: 0;
		gap: 3px;
		margin-inline-start: auto;
	}

	.browser__count {
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-variant-numeric: tabular-nums;
	}

	.browser__chevron {
		display: inline-flex;
		color: var(--text-muted);
		opacity: 0;
		--icon-size: var(--icon-xs);
	}

	.browser__row[aria-pressed='true'] .browser__chevron {
		opacity: 1;
	}

	.browser__detail {
		display: grid;
		align-content: start;
		gap: 10px;
		min-width: 0;
		padding: 14px 16px;
	}

	.browser__empty {
		margin: 0;
		padding: 10px 8px;
		color: var(--text-muted);
		font-size: var(--fs-label);
	}

	@media (max-width: 760px) {
		.browser {
			grid-template-columns: minmax(0, 1fr);
		}

		.browser__col {
			max-height: 220px;
			border-inline-end: 0;
			border-bottom: 1px solid var(--border-subtle);
		}
	}

	/* Rows slide in from the reading end, one after another from the top. */
	.browser__arrive {
		animation: browser-arrive 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
		animation-delay: calc(var(--i, 0) * 40ms);
	}

	@keyframes browser-arrive {
		from {
			opacity: 0;
			translate: calc(16px * var(--dir)) 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.browser__arrive {
			animation: none;
		}
	}
</style>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { tick } from 'svelte';
	import {
		SEVERITIES,
		countNotifications,
		isDismissible,
		notificationHref,
		orderNotifications,
		type ShellNotification
	} from './notifications';

	/**
	 * The header's notification area, left of the display menu. Closed, it is four circles
	 * (critical red, high orange, caution yellow, info blue) with their counts underneath, and no
	 * text. A click stretches it to the left, then the list unfolds below; the icon at the top
	 * right (or Esc, or a click outside) folds it back.
	 *
	 * Every notification in the list is a link to its page under the operations category. What the
	 * colours mean: critical, a failure is happening now; high, a failure is likely if nothing is
	 * done; caution, not a failure but a problem; info, everything else. Only information has an
	 * icon at the right end of its row that removes it on the spot; the others are deleted from
	 * their page, after they have been looked at.
	 */
	interface Props {
		items: readonly ShellNotification[];
		/** Called when a piece of information is dismissed from the list. */
		ondismiss?: (id: string) => void;
	}

	let { items, ondismiss }: Props = $props();

	const counts = $derived(countNotifications(items));
	const ordered = $derived(orderNotifications(items));
	const summary = $derived(
		SEVERITIES.map((severity) => `${t(`notify.severity.${severity}`)} ${counts[severity]}`).join(
			', '
		)
	);

	let list = $state<HTMLUListElement>();

	/**
	 * Remove information from the list. A keyboard user stays where they were in the list; after a
	 * click focus is left alone, so no focus ring shows up that the click did not ask for.
	 */
	async function dismiss(id: string, index: number, keyboard: boolean) {
		ondismiss?.(id);
		await tick();
		const rows = list?.querySelectorAll<HTMLElement>('.notify__link') ?? [];
		if (keyboard) (rows[index] ?? rows[index - 1] ?? trigger)?.focus();
	}

	let open = $state(false);
	/** How far the sheet may stretch before it leaves the screen (it grows toward the start edge). */
	let room = $state(560);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	const uid = $props.id();

	function measure() {
		if (!root) return;
		const box = root.getBoundingClientRect();
		const edge = getComputedStyle(root).direction === 'rtl' ? innerWidth - box.left : box.right;
		room = Math.max(box.width, edge - 12);
	}

	function toggle() {
		if (open) return close();
		measure();
		open = true;
	}

	/**
	 * A mouse press must not put focus (and with it the focus frame) on the control: keyboard users
	 * reach them with Tab and see the quiet frame below, a pointer user never sees one.
	 */
	function keepFocus(event: MouseEvent) {
		event.preventDefault();
	}

	function close(returnFocus = false) {
		open = false;
		if (returnFocus) trigger?.focus();
	}

	$effect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (root && !root.contains(event.target as Node)) close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') close(true);
		};
		document.addEventListener('pointerdown', onPointer);
		document.addEventListener('keydown', onKey);
		window.addEventListener('resize', measure);
		return () => {
			document.removeEventListener('pointerdown', onPointer);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', measure);
		};
	});
</script>

{#snippet counted()}
	{#each SEVERITIES as severity (severity)}
		<span
			class="notify__count notify__count--{severity}"
			class:is-zero={counts[severity] === 0}
			title="{t(`notify.severity.${severity}`)}: {t(`notify.hint.${severity}`)}"
		>
			<span class="notify__num" aria-hidden="true">{counts[severity]}</span>
			<span class="notify__pill" aria-hidden="true">{t(`notify.short.${severity}`)}</span>
			<span class="notify__dot notify__dot--{severity}" aria-hidden="true"></span>
		</span>
	{/each}
{/snippet}

<div class="notify" bind:this={root}>
	<!-- The slot is as wide as the counts are, whatever the font, from the first paint: this hidden
	     copy is the only thing in the slot's flow, so nothing is measured and nothing moves. -->
	<span class="notify__sizer" aria-hidden="true" inert>
		<span class="notify__cluster">{@render counted()}</span>
	</span>
	<div class="notify__sheet" class:is-open={open} style:--notify-room="{room}px">
		<div class="notify__bar">
			<p class="notify__title" aria-hidden={!open}>{t('notify.label')}</p>
			<button
				bind:this={trigger}
				type="button"
				class="notify__cluster"
				onmousedown={keepFocus}
				aria-expanded={open}
				aria-controls="{uid}-list"
				aria-label="{t('notify.open')}: {summary}"
				onclick={toggle}
			>
				{@render counted()}
			</button>
			<button
				type="button"
				class="notify__close"
				onmousedown={keepFocus}
				aria-label={t('notify.close')}
				title={t('notify.close')}
				tabindex={open ? 0 : -1}
				onclick={(event) => close(event.detail === 0)}
			>
				<Icon name="close" />
			</button>
		</div>
		<div class="notify__body" class:is-open={open} inert={!open}>
			<div class="notify__body-inner">
				<ul class="notify__list" id="{uid}-list" aria-label={t('notify.label')} bind:this={list}>
					{#each ordered as item, index (item.id)}
						<li class="notify__row">
							<a
								class="notify__link"
								href={notificationHref(item.id)}
								onmousedown={keepFocus}
								onclick={() => close()}
							>
								<span
									class="notify__pill notify__pill--row notify__pill--{item.severity}"
									aria-hidden="true">{t(`notify.short.${item.severity}`)}</span
								>
								<span class="notify__item-body">
									<span class="notify__item-text">
										<span class="notify__sr"
											>{t(`notify.severity.${item.severity}`)}:
										</span>{item.text}
									</span>
									{#if item.time}<span class="notify__item-meta">{item.time}</span>{/if}
								</span>
							</a>
							{#if isDismissible(item)}
								<button
									type="button"
									class="notify__dismiss"
									onmousedown={keepFocus}
									aria-label="{t('notify.dismiss')}: {item.text}"
									title={t('notify.dismiss')}
									onclick={(event) => dismiss(item.id, index, event.detail === 0)}
								>
									<Icon name="close" />
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		</div>
	</div>
</div>

<style>
	/* The slot keeps its size, so the header does not move when the sheet opens. */
	.notify {
		position: relative;
		flex: 0 0 auto;
		height: calc(var(--header-h) - 8px);
	}

	/* Room for what the sheet adds around the counts: its border, padding and two gaps. */
	.notify__sizer {
		display: block;
		padding-inline: 9px;
		visibility: hidden;
		pointer-events: none;
	}

	.notify__sheet {
		position: absolute;
		inset-inline-end: 0;
		top: 0;
		z-index: var(--z-menu);
		width: 100%;
		border: 1px solid transparent;
		border-radius: var(--radius-panel);
		background: transparent;
		overflow: hidden;
		/* Closing: the list folds first, then the sheet draws back to the right. */
		transition:
			width 200ms cubic-bezier(0.3, 0.8, 0.3, 1) 150ms,
			background-color 150ms ease 150ms,
			border-color 150ms ease 150ms,
			box-shadow 150ms ease 150ms;
	}

	.notify__sheet.is-open {
		width: min(560px, var(--notify-room));
		border-color: var(--border);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
		/* Opening: it stretches to the left first; the list unfolds after. */
		transition:
			width 220ms cubic-bezier(0.3, 0.8, 0.3, 1),
			background-color 120ms ease,
			border-color 120ms ease,
			box-shadow 120ms ease;
	}

	.notify__bar {
		display: flex;
		align-items: center;
		gap: 4px;
		height: calc(var(--header-h) - 10px);
		padding-inline: 4px;
	}

	/* The page-wide blue outline is loud here and gets clipped by the sheet; a quiet frame instead. */
	.notify__cluster:focus-visible,
	.notify__close:focus-visible,
	.notify__dismiss:focus-visible,
	.notify__link:focus-visible {
		outline: none;
		background: var(--bg-hover);
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}

	.notify__title {
		flex: 1;
		min-width: 0;
		margin: 0;
		padding-inline-start: 10px;
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--fs-small);
		white-space: nowrap;
		opacity: 0;
		transition: opacity 100ms ease;
	}

	.is-open .notify__title {
		opacity: 1;
		transition: opacity 160ms ease 150ms;
	}

	.notify__cluster {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		gap: 12px;
		padding: 4px 8px;
		border: 0;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.notify__cluster:hover {
		background: var(--bg-hover);
	}

	/* A count and the name of its severity in a tinted pill: "0 Critical", "6 High". */
	.notify__count {
		display: flex;
		align-items: center;
		gap: 6px;
		--sev: var(--sev-info);
	}

	.notify__count--critical {
		--sev: var(--sev-critical);
	}

	.notify__count--high {
		--sev: var(--sev-high);
	}

	.notify__count--caution {
		--sev: var(--sev-caution);
	}

	.notify__count--info {
		--sev: var(--sev-info);
	}

	/* Nothing of this severity: the pill goes neutral. (Not faded: faded text fails contrast.) */
	.notify__count.is-zero .notify__pill {
		border-color: var(--border);
		background: transparent;
		color: var(--text-muted);
	}

	.notify__count.is-zero .notify__num {
		color: var(--text-muted);
	}

	.notify__num {
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-variant-numeric: tabular-nums;
		font-weight: var(--fw-semibold);
		line-height: 1;
	}

	/* In the list the pills share one column, as wide as the longest of them (see .notify__list),
	   so the messages start at the same place whatever the language. */
	.notify__pill--row {
		align-self: start;
		margin-block-start: 1px;
		margin-inline-end: 10px;
		text-align: center;
	}

	.notify__pill--critical {
		--sev: var(--sev-critical);
	}

	.notify__pill--high {
		--sev: var(--sev-high);
	}

	.notify__pill--caution {
		--sev: var(--sev-caution);
	}

	.notify__pill--info {
		--sev: var(--sev-info);
	}

	.notify__pill {
		padding: 3px 8px;
		border: 1px solid color-mix(in oklab, var(--sev) 55%, transparent);
		border-radius: var(--radius-control);
		background: color-mix(in oklab, var(--sev) 16%, transparent);
		/* Mixed toward the text colour, so the yellow stays readable on a light header. */
		color: color-mix(in oklab, var(--sev) 42%, var(--text-primary));
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		line-height: 1.2;
		white-space: nowrap;
	}

	/* Rows of the list and the phone header use a plain circle. */
	.notify__dot {
		display: block;
		flex-shrink: 0;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--sev);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--sev) 62%, var(--text-primary));
	}

	.notify__count .notify__dot {
		display: none;
	}

	.notify__dot--critical {
		--sev: var(--sev-critical);
	}

	.notify__dot--high {
		--sev: var(--sev-high);
	}

	.notify__dot--caution {
		--sev: var(--sev-caution);
	}

	.notify__dot--info {
		--sev: var(--sev-info);
	}

	.notify__dot.is-zero {
		opacity: 0.32;
	}

	.notify__close {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 0;
		height: var(--control-h-dense);
		padding: 0;
		overflow: hidden;
		border: 0;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-secondary);
		opacity: 0;
		cursor: pointer;
		--icon-size: var(--icon-md);
		transition:
			width 160ms ease,
			opacity 100ms ease;
	}

	.is-open .notify__close {
		width: var(--control-h-dense);
		opacity: 1;
		transition:
			width 160ms ease 120ms,
			opacity 160ms ease 150ms;
	}

	.notify__close:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/* The list unfolds by growing its row from nothing; no height is measured. */
	.notify__body {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows 150ms ease-in;
	}

	.notify__body.is-open {
		grid-template-rows: 1fr;
		transition: grid-template-rows 240ms cubic-bezier(0.3, 0.8, 0.3, 1) 180ms;
	}

	.notify__body-inner {
		min-height: 0;
		overflow: hidden;
	}

	/* Three columns every row shares: pill, message, dismiss. The pill column takes the width of the
	   widest pill, so nothing is fixed to a number of characters. */
	.notify__list {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) auto;
		align-content: start;
		row-gap: 2px;
		max-height: min(60vh, 420px);
		margin: 0;
		padding: 4px 8px 6px;
		overflow: auto;
		list-style: none;
		border-top: 1px solid var(--border);
	}

	.notify__row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: start;
		border-radius: var(--radius-control);
		font-size: var(--fs-body);
	}

	.notify__row:hover {
		background: var(--bg-hover);
	}

	.notify__link {
		display: grid;
		grid-column: 1 / 3;
		grid-template-columns: subgrid;
		min-width: 0;
		padding: 8px 6px;
		border-radius: var(--radius-control);
		color: inherit;
		text-decoration: none;
	}

	.notify__dismiss {
		display: grid;
		grid-column: 3;
		place-items: center;
		width: var(--control-h-dense);
		height: var(--control-h-dense);
		margin-block-start: 2px;
		margin-inline-start: 4px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		--icon-size: var(--icon-sm);
	}

	.notify__dismiss:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.notify__item-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.notify__item-text {
		overflow-wrap: anywhere;
		color: var(--text-primary);
	}

	.notify__item-meta {
		display: flex;
		gap: 12px;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.notify__sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* Below this width the header has no room for names: a circle beside its count. Wider than the
	   phone layout, because between the two the tenant switcher is squeezed to nothing. */
	@media (max-width: 760px) {
		.notify__cluster {
			align-items: flex-start;
			gap: 4px;
		}

		.notify__count {
			flex-direction: column-reverse;
			gap: 3px;
		}

		/* Only the summary loses its names; the rows of the list keep theirs. */
		.notify__count .notify__pill {
			display: none;
		}

		.notify__count .notify__dot {
			display: block;
			width: 14px;
			height: 14px;
		}

		.notify__num {
			font-size: var(--fs-small);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.notify__sheet,
		.notify__sheet.is-open,
		.notify__title,
		.is-open .notify__title,
		.notify__close,
		.is-open .notify__close,
		.notify__body,
		.notify__body.is-open {
			transition: none;
		}
	}
</style>

<script lang="ts">
	import Icon from '../icons/Icon.svelte';
	import { placeBeside } from './tip-place';

	/**
	 * A "?" that explains something on hover or focus — for short explanations that would
	 * crowd the layout if always shown (a part's purpose in a list of names). The bubble sits
	 * in the top layer (popover), so no scrolling or clipping container hides it; Esc closes
	 * it. Screen readers get the text as the description of whatever points at `id`, so the
	 * explanation is never only visual.
	 */
	interface Props {
		/** Accessible name of the "?" button ("About Heading"). */
		label: string;
		text: string;
		/** Id of the text, to reference from another control with aria-describedby. */
		id?: string;
	}

	let { label, text, id }: Props = $props();

	const uid = $props.id();
	const tipId = $derived(id ?? `${uid}-tip`);
	let trigger = $state<HTMLButtonElement>();
	let bubble = $state<HTMLSpanElement>();

	function place() {
		if (trigger && bubble) placeBeside(trigger, bubble);
	}

	function show() {
		if (!bubble?.showPopover || bubble.matches(':popover-open')) return;
		bubble.showPopover();
		place();
	}

	function hide() {
		if (bubble?.matches(':popover-open')) bubble.hidePopover();
	}
</script>

<button
	bind:this={trigger}
	type="button"
	class="info-tip"
	aria-label={label}
	aria-describedby={tipId}
	onpointerenter={show}
	onpointerleave={hide}
	onfocus={show}
	onblur={hide}
	onkeydown={(event) => {
		if (event.key === 'Escape') hide();
	}}
>
	<Icon name="question" />
</button>
<span bind:this={bubble} id={tipId} role="tooltip" popover="manual" class="info-tip__bubble"
	>{text}</span
>

<style>
	.info-tip {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: var(--control-h-xs);
		height: var(--control-h-xs);
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted);
		cursor: help;
		--icon-size: var(--icon-md);
	}

	.info-tip:hover,
	.info-tip:focus-visible {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/* Top layer, placed next to the "?" by script (popovers default to the centre). */
	.info-tip__bubble {
		position: fixed;
		inset: auto;
		max-width: 260px;
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		font-size: var(--fs-caption);
		line-height: var(--lh-snug);
	}
</style>

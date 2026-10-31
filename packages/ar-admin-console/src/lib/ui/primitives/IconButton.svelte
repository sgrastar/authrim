<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';

	interface Props extends Omit<HTMLButtonAttributes, 'children'> {
		icon: IconName;
		/** Required: an icon-only control needs an accessible name. Also shown as a tooltip. */
		label: string;
		/** Small dot for unread / attention. */
		dot?: boolean;
		/** `sm`: 24px, for controls repeated on every line of a list (move up / down, remove). */
		size?: 'md' | 'sm';
		element?: HTMLButtonElement;
	}

	let {
		icon,
		label,
		dot = false,
		size = 'md',
		type = 'button',
		element = $bindable(),
		disabled,
		...rest
	}: Props = $props();

	const busy = useBusy();
</script>

<button
	bind:this={element}
	class="icon-btn"
	class:icon-btn--sm={size === 'sm'}
	{type}
	aria-label={label}
	title={label}
	{...rest}
	disabled={!!disabled || busy()}
>
	<Icon name={icon} />
	{#if dot}<span class="icon-btn__dot"></span>{/if}
</button>

<style>
	.icon-btn {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--control-h-dense);
		height: var(--control-h-dense);
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-secondary);
		--icon-size: var(--icon-lg);
	}

	.icon-btn--sm {
		width: var(--control-h-xs);
		height: var(--control-h-xs);
		--icon-size: var(--icon-sm);
	}

	.icon-btn:hover:not(:disabled),
	.icon-btn[aria-expanded='true'] {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.icon-btn:disabled {
		opacity: 0.4;
	}

	/* A face while pressed, so touch (no hover) sees it too. */
	.icon-btn:active:not(:disabled) {
		background: var(--bg-press);
		color: var(--text-primary);
	}

	.icon-btn__dot {
		position: absolute;
		top: 6px;
		inset-inline-end: 6px;
		width: 6px;
		height: 6px;
		border: 1.5px solid var(--bg-card);
		border-radius: 50%;
		background: var(--danger);
	}
</style>

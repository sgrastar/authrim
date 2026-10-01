<script lang="ts">
	import { useBusy } from '../busy/busy';
	import type { Snippet } from 'svelte';

	/**
	 * A trigger button with a panel below it. Closes on outside click, Esc (returning focus to
	 * the trigger), when a link in the panel is followed, and when `close()` is called from the
	 * panel.
	 */
	interface Props {
		/** Accessible name of the trigger; also its tooltip. */
		label: string;
		/** Which edge of the trigger the panel lines up with (logical: follows RTL). */
		align?: 'start' | 'end';
		disabled?: boolean;
		/** Visual variant of the trigger. */
		variant?: 'icon' | 'plain';
		/** Panel width when the content needs more than the default. */
		width?: string;
		trigger: Snippet;
		children: Snippet<[{ close: () => void }]>;
	}

	let {
		label,
		align = 'start',
		disabled = false,
		variant = 'plain',
		width,
		trigger,
		children
	}: Props = $props();

	const busy = useBusy();

	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let button = $state<HTMLButtonElement>();
	const uid = $props.id();

	function close(returnFocus = false) {
		open = false;
		if (returnFocus) button?.focus();
	}

	$effect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (root && !root.contains(event.target as Node)) close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') close(true);
		};
		const onClick = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (root?.contains(target) && target?.closest('.popover__panel a[href]')) close();
		};
		document.addEventListener('pointerdown', onPointer);
		document.addEventListener('keydown', onKey);
		document.addEventListener('click', onClick);
		return () => {
			document.removeEventListener('pointerdown', onPointer);
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('click', onClick);
		};
	});
</script>

<div class="popover" bind:this={root}>
	<button
		bind:this={button}
		class="popover__trigger popover__trigger--{variant}"
		type="button"
		aria-label={variant === 'icon' ? label : undefined}
		title={label}
		aria-expanded={open}
		aria-controls="{uid}-panel"
		disabled={disabled || busy()}
		onclick={() => (open = !open)}
	>
		{@render trigger()}
	</button>
	{#if open}
		<div class="popover__panel popover__panel--{align}" id="{uid}-panel" style:width>
			{@render children({ close: () => close(true) })}
		</div>
	{/if}
</div>

<style>
	.popover {
		position: relative;
		min-width: 0;
	}

	.popover__trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
		border: 0;
		background: transparent;
		padding: 0;
	}

	.popover__trigger--icon {
		display: grid;
		place-items: center;
		width: var(--control-h-dense);
		height: var(--control-h-dense);
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		color: var(--text-secondary);
		--icon-size: var(--icon-lg);
	}

	.popover__trigger--icon:hover,
	.popover__trigger--icon[aria-expanded='true'] {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.popover__panel {
		position: absolute;
		top: calc(100% + 7px);
		z-index: var(--z-menu);
		min-width: 264px;
		max-width: min(320px, calc(100vw - 24px));
		padding: 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
		animation: popover-in 140ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}

	.popover__panel--start {
		inset-inline-start: 0;
	}

	.popover__panel--end {
		inset-inline-end: 0;
	}

	@keyframes popover-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.popover__panel {
			animation: none;
		}
	}
</style>

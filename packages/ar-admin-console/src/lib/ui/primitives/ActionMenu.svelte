<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface MenuAction {
		label: string;
		icon?: IconName;
		disabled?: boolean;
		/** Removes or discards something: shown in the danger colour. */
		danger?: boolean;
		onselect: () => void;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';

	/**
	 * A "⋯" button that opens a short list of actions for one item (move up, move down,
	 * remove): the less frequent actions, kept out of the way until wanted.
	 *
	 * - The list sits in the top layer, so a scrolling or clipped container does not cut it.
	 * - Keys follow the menu button pattern: Enter, Space or ↓ open it on the first action,
	 *   ↑ on the last; ↑ / ↓ / Home / End move; Esc or a press outside closes it, and focus
	 *   returns to the button. Unavailable actions are skipped.
	 * - `framed` draws a faint box around the button, for places where a bare "⋯" could be
	 *   read as part of a line or a diagram.
	 */
	interface Props {
		/** Accessible name and tooltip of the button ("Transform 2 actions"). */
		label: string;
		actions: readonly MenuAction[];
		size?: 'md' | 'sm';
		framed?: boolean;
		disabled?: boolean;
		/** Id of the button, to bring focus back to it (an item moved in a list loses focus). */
		id?: string;
	}

	let { label, actions, size = 'md', framed = false, disabled = false, id }: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();
	let open = $state(false);
	/** Which end to focus when the menu opens (↑ opens on the last action). */
	let startAt: 'first' | 'last' = 'first';

	const items = () => [
		...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
	];

	function place() {
		if (!trigger || !menu) return;
		const at = trigger.getBoundingClientRect();
		const gap = 4;
		const box = menu.getBoundingClientRect();
		const below = innerHeight - at.bottom - gap;
		const top =
			below >= box.height || below >= at.top ? at.bottom + gap : at.top - gap - box.height;
		// Lines up with the button's end edge: the menu opens inwards from a row's end.
		const rtl = getComputedStyle(trigger).direction === 'rtl';
		const left = rtl ? at.left : at.right - box.width;
		menu.style.top = `${Math.max(gap, top)}px`;
		menu.style.left = `${Math.min(Math.max(gap, left), innerWidth - box.width - gap)}px`;
	}

	async function toggled(event: ToggleEvent) {
		open = event.newState === 'open';
		if (!open) {
			// Closed from inside (Esc, an action): back to the button. A press elsewhere keeps
			// the focus where it went.
			if (menu?.contains(document.activeElement)) trigger?.focus();
			return;
		}
		place();
		await tick();
		const list = items();
		(startAt === 'last' ? list.at(-1) : list[0])?.focus();
		startAt = 'first';
	}

	function hide() {
		if (menu?.matches(':popover-open')) menu.hidePopover();
	}

	function run(action: MenuAction) {
		if (action.disabled) return;
		hide();
		action.onselect();
	}

	function menuKeydown(event: KeyboardEvent) {
		const list = items();
		const at = list.indexOf(document.activeElement as HTMLButtonElement);
		const go = (index: number) => {
			event.preventDefault();
			list[(index + list.length) % list.length]?.focus();
		};
		if (event.key === 'ArrowDown') go(at + 1);
		else if (event.key === 'ArrowUp') go(at - 1);
		else if (event.key === 'Home') go(0);
		else if (event.key === 'End') go(list.length - 1);
		else if (event.key === 'Tab') hide();
		else if (event.key === 'Escape') {
			// The browser closes an open popover on Esc too; handled here so it does not depend
			// on that (and so a surrounding dialog does not also take the key).
			event.preventDefault();
			event.stopPropagation();
			hide();
		}
	}

	/** While open, keep the menu by its button when the page scrolls or resizes. */
	$effect(() => {
		if (!open) return;
		addEventListener('scroll', place, true);
		addEventListener('resize', place);
		return () => {
			removeEventListener('scroll', place, true);
			removeEventListener('resize', place);
		};
	});
</script>

<button
	bind:this={trigger}
	{id}
	type="button"
	class="action-menu__button"
	class:action-menu__button--sm={size === 'sm'}
	class:is-framed={framed}
	aria-label={label}
	title={label}
	aria-haspopup="menu"
	aria-expanded={open}
	aria-controls="{uid}-menu"
	popovertarget="{uid}-menu"
	disabled={disabled || busy()}
	onkeydown={(event) => {
		if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
		event.preventDefault();
		startAt = event.key === 'ArrowUp' ? 'last' : 'first';
		menu?.showPopover();
	}}
>
	<Icon name="dots" />
</button>

<div
	bind:this={menu}
	id="{uid}-menu"
	class="action-menu"
	role="menu"
	tabindex="-1"
	aria-label={label}
	popover="auto"
	ontoggle={toggled}
	onkeydown={menuKeydown}
>
	{#each actions as action (action.label)}
		<button
			type="button"
			class="action-menu__item"
			class:is-danger={action.danger}
			role="menuitem"
			tabindex="-1"
			disabled={action.disabled}
			onclick={() => run(action)}
		>
			<span class="action-menu__icon" aria-hidden="true"
				>{#if action.icon}<Icon name={action.icon} />{/if}</span
			>
			{action.label}
		</button>
	{/each}
</div>

<style>
	.action-menu__button {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: var(--control-h-dense);
		height: var(--control-h-dense);
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		--icon-size: var(--icon-lg);
	}

	.action-menu__button--sm {
		width: var(--control-h-xs);
		height: var(--control-h-xs);
		border-radius: var(--radius-xs);
		--icon-size: var(--icon-sm);
	}

	/* A faint box: a button, not a stretch of dotted line. */
	.action-menu__button.is-framed {
		border-color: var(--border);
		background: var(--bg-card);
	}

	.action-menu__button:hover:not(:disabled),
	.action-menu__button[aria-expanded='true'] {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.action-menu__button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.action-menu__button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* Top layer, placed by the button by script (popovers default to the centre). */
	.action-menu {
		position: fixed;
		inset: auto;
		min-width: 160px;
		max-width: min(320px, calc(100vw - 16px));
		margin: 0;
		padding: 4px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
	}

	.action-menu__item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: var(--control-h-dense);
		padding: 4px 10px 4px 6px;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: var(--fs-body);
		text-align: start;
		cursor: pointer;
	}

	.action-menu__item:hover:not(:disabled),
	.action-menu__item:focus-visible {
		background: var(--bg-hover);
		outline: none;
	}

	.action-menu__item:disabled {
		color: var(--text-muted);
		cursor: not-allowed;
	}

	.action-menu__item.is-danger:not(:disabled) {
		color: var(--danger);
	}

	.action-menu__icon {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 16px;
		color: var(--text-secondary);
		--icon-size: var(--icon-sm);
	}

	.is-danger:not(:disabled) .action-menu__icon {
		color: inherit;
	}

	.action-menu__item:disabled .action-menu__icon {
		color: var(--text-muted);
	}
</style>

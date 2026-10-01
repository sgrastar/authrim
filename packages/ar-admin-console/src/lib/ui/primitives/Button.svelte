<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';

	interface Props extends Omit<HTMLButtonAttributes, 'children'> {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'md' | 'sm';
		icon?: IconName;
		iconEnd?: IconName;
		/** Renders a link styled as a button. */
		href?: string;
		/** Opens `href` in a new tab and marks it as external. */
		external?: boolean;
		/**
		 * This button's action is running: spinner instead of the icon, clicks ignored. It stays
		 * focusable (aria-disabled, not disabled) so keyboard and screen-reader users keep their
		 * place. Inside a BusyScope every other control is disabled at the same time.
		 */
		loading?: boolean;
		/** Stretch to the container width (auth pages, narrow layouts). */
		block?: boolean;
		children: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'md',
		icon,
		iconEnd,
		href,
		external = false,
		loading = false,
		block = false,
		type = 'button',
		disabled,
		children,
		onclick,
		...rest
	}: Props = $props();

	const scopeBusy = useBusy();
	/** Disabled by the page, or by a busy scope around it (the loading button excepted). */
	const off = $derived(!!disabled || (scopeBusy() && !loading));

	function click(event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
		if (loading) {
			event.preventDefault();
			return;
		}
		onclick?.(event);
	}
</script>

{#snippet content()}
	{#if loading}
		<span class="btn__spin"><Icon name="spinner" /></span>
	{:else if icon}
		<Icon name={icon} />
	{/if}
	<span class="btn__label">{@render children()}</span>
	{#if external}
		<Icon name="external" />
	{:else if iconEnd}
		<Icon name={iconEnd} />
	{/if}
{/snippet}

{#if href && !off && !loading}
	<a
		class="btn btn--{variant} btn--{size}"
		class:btn--block={block}
		{href}
		target={external ? '_blank' : undefined}
		rel={external ? 'noopener noreferrer' : undefined}
	>
		{@render content()}
	</a>
{:else}
	<button
		class="btn btn--{variant} btn--{size}"
		class:btn--block={block}
		{type}
		{...rest}
		disabled={off}
		aria-disabled={loading || undefined}
		aria-busy={loading || undefined}
		onclick={click}
	>
		{@render content()}
	</button>
{/if}

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: var(--control-h);
		padding: 0 13px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-weight: var(--fw-name);
		white-space: nowrap;
		--icon-size: var(--icon-md);
	}

	.btn:hover:not(:disabled, [aria-busy='true']) {
		background: var(--bg-subtle);
	}

	.btn:disabled {
		opacity: 0.55;
	}

	/* The running action stays clearer than the controls it disabled. */
	.btn[aria-busy='true'] {
		opacity: 0.8;
		cursor: progress;
	}

	.btn--sm {
		height: var(--control-h-sm);
		padding: 0 10px;
		font-size: var(--fs-caption);
		--icon-size: var(--icon-sm);
	}

	.btn--block {
		display: flex;
		width: 100%;
		height: var(--control-h-lg);
		font-size: var(--fs-body-lg);
	}

	.btn--primary {
		background: var(--primary);
		border-color: var(--primary);
		color: var(--text-inverse);
	}

	.btn--primary:hover:not(:disabled, [aria-busy='true']) {
		background: var(--primary-hover);
	}

	.btn--ghost {
		border-color: transparent;
		background: transparent;
	}

	.btn--ghost:hover:not(:disabled, [aria-busy='true']) {
		background: var(--bg-hover);
	}

	/* Transparent buttons get a face while pressed, so touch (no hover) sees it too. */
	.btn--ghost:active:not(:disabled, [aria-busy='true']) {
		background: var(--bg-press);
	}

	.btn--danger {
		background: var(--danger);
		border-color: var(--danger);
		color: var(--text-inverse);
	}

	.btn--danger:hover:not(:disabled, [aria-busy='true']) {
		background: var(--danger);
		filter: brightness(0.94);
	}

	.btn__label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.btn__spin {
		display: inline-flex;
		animation: btn-spin 0.9s linear infinite;
	}

	@keyframes btn-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.btn__spin {
			animation-duration: 2.4s;
		}
	}
</style>

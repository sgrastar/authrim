<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface FlowOption {
		id: string;
		label: string;
		description?: string;
		icon?: IconName;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';

	/**
	 * "+" on an edge where optional steps can be inserted. The box itself grows into the list of
	 * steps that fit here (it does not float over the diagram), so the edge and everything below
	 * make room for it. Closes on selection, Esc or a click outside. With nothing to offer it
	 * renders nothing: a "+" that opens onto an empty list is a dead end.
	 */
	interface Props {
		options: readonly FlowOption[];
		onadd: (id: string) => void;
		/** Heading of the open menu, usually the flow name ("Sign-in"). */
		title?: string;
	}

	let { options, onadd, title }: Props = $props();

	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let list = $state<HTMLUListElement>();
	let contentHeight = $state(0);
	const uid = $props.id();

	async function show() {
		open = true;
		await tick();
		list?.querySelector('button')?.focus({ preventScroll: true });
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
		return () => {
			document.removeEventListener('pointerdown', onPointer);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

{#if options.length > 0}
	<div class="add" class:is-open={open} bind:this={root} style:--open-h="{contentHeight + 2}px">
		<div class="add__box">
			<button
				bind:this={trigger}
				type="button"
				class="add__trigger"
				aria-label={t('flow.add')}
				title={t('flow.add')}
				aria-expanded={open}
				aria-controls="{uid}-menu"
				tabindex={open ? -1 : undefined}
				onclick={show}><Icon name="plus" /></button
			>
			<div
				class="add__content"
				id="{uid}-menu"
				inert={!open}
				aria-hidden={open ? undefined : 'true'}
				bind:offsetHeight={contentHeight}
			>
				<div class="add__title">
					<span>{title ?? t('flow.addTitle')}</span>
					<button type="button" aria-label={t('app.close')} onclick={() => close(true)}
						><Icon name="minus" /></button
					>
				</div>
				<ul bind:this={list}>
					{#each options as option, index (option.id)}
						<li style:--i={index}>
							<button
								type="button"
								onclick={() => {
									close();
									onadd(option.id);
								}}
							>
								{#if option.icon}<Icon name={option.icon} />{/if}
								<span>
									<strong>{option.label}</strong>
									{#if option.description}<small>{option.description}</small>{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</div>
		<span class="add__caption" aria-hidden="true">
			{t('flow.pick')}<small>{t('flow.addCount', { n: options.length })}</small>
		</span>
	</div>
{/if}

<style>
	/* The 24px anchor stays on the line; its height follows the box so the edge makes room. */
	.add {
		position: relative;
		width: 24px;
		height: 24px;
		animation: add-arrive 200ms ease-out both;
		transition: height 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.add.is-open {
		height: var(--open-h);
	}

	.add__box {
		position: absolute;
		top: 0;
		left: 50%;
		width: 24px;
		height: 100%;
		overflow: hidden;
		border: 1px solid var(--border-strong);
		border-radius: min(5px, var(--radius-control));
		background: var(--bg-card);
		/* Opaque, with a halo in the canvas colour: the line runs underneath and must not show. */
		box-shadow: 0 0 0 4px var(--bg-subtle);
		transform: translateX(-50%);
		transition:
			width 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
			border-radius 220ms,
			box-shadow 220ms;
	}

	.is-open .add__box {
		width: 252px;
		border-radius: min(9px, var(--radius-panel));
		box-shadow: var(--shadow-lg);
	}

	.add__trigger {
		position: absolute;
		top: 0;
		left: 0;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-secondary);
		transition: opacity 80ms;
		--icon-size: var(--icon-xs);
	}

	.add__trigger:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.is-open .add__trigger {
		opacity: 0;
		pointer-events: none;
	}

	.add__content {
		width: 250px;
		padding: 0 10px 10px;
		opacity: 0;
		visibility: hidden;
		transition:
			opacity 100ms,
			visibility 0s 100ms;
	}

	/* The list shows once the box has started to grow. */
	.is-open .add__content {
		opacity: 1;
		visibility: visible;
		transition: opacity 150ms 90ms;
	}

	.add__title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 40px;
		padding: 0 2px 0 7px;
		color: var(--text-muted);
		font-size: var(--fs-overline);
		letter-spacing: 0.03em;
	}

	.add__title button {
		display: grid;
		place-items: center;
		width: var(--control-h-xs);
		height: var(--control-h-xs);
		padding: 0;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-secondary);
		--icon-size: var(--icon-sm);
	}

	.add__title button:hover {
		background: var(--bg-hover);
	}

	ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li + li {
		border-top: 1px solid var(--border-subtle);
	}

	.is-open .add__title {
		animation: add-row 180ms ease-out 90ms both;
	}

	.is-open li {
		animation: add-row 200ms ease-out both;
		animation-delay: calc(130ms + var(--i, 0) * 45ms);
	}

	li button {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		min-height: 39px;
		padding: 7px 8px;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text-secondary);
		text-align: start;
		--icon-size: var(--icon-md);
	}

	li button:hover,
	li button:focus-visible {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	li button :global(svg) {
		margin-top: 1px;
	}

	li strong {
		display: block;
		font-size: var(--fs-caption);
		font-weight: var(--fw-regular);
	}

	li small {
		display: block;
		margin-top: 2px;
		color: var(--text-muted);
		font-size: var(--fs-small);
		line-height: var(--lh-snug);
	}

	.add__caption {
		position: absolute;
		top: 0;
		inset-inline-start: 36px;
		color: var(--text-secondary);
		font-size: var(--fs-overline);
		line-height: var(--lh-snug);
		/* Wraps instead of running out of the canvas: the room between the point and the edge. */
		width: max-content;
		max-width: calc(var(--flow-node-w) / 2 + var(--flow-gutter) - 30px);
		overflow-wrap: anywhere;
		pointer-events: none;
		transition: opacity 80ms;
	}

	.add__caption small {
		display: block;
		color: var(--text-muted);
		font-size: var(--fs-overline);
	}

	.is-open .add__caption {
		opacity: 0;
	}

	@keyframes add-arrive {
		from {
			opacity: 0;
			transform: scale(0.6);
		}
	}

	@keyframes add-row {
		from {
			opacity: 0;
			transform: translateY(-5px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.add,
		.add__box,
		.add__content,
		.is-open .add__title,
		.is-open li {
			animation: none;
			transition: none;
		}
	}
</style>

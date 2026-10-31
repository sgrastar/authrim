<script lang="ts">
	import Badge from '../primitives/Badge.svelte';
	import { tick, type Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';

	/**
	 * A section that opens on demand — "Advanced settings", rarely changed options — built on
	 * <details>, so it works with the keyboard and screen readers as is. It slides open and
	 * shut (not with reduced motion).
	 *
	 * Rows inside that line up with rows outside (FieldRow, a ruled DetailList) read
	 * `--row-indent`: how far in the body starts, so their columns can take it off.
	 *
	 * A closed section must not hide unsaved work: when a field inside carries the change mark
	 * (SaveScope), the heading carries it too, so the admin knows to look inside before saving.
	 * Open it from the start (`open`) when it holds something that needs attention, such as an
	 * error.
	 */
	interface Props {
		title: string;
		/** One line on what is inside, shown under the title. */
		description?: string;
		open?: boolean;
		/**
		 * Marks on the closed heading about what is inside that is not a change being made —
		 * "Overridden settings: 2" — so a closed section never hides a value that applies.
		 * Shown right after the title.
		 */
		meta?: Snippet;
		/**
		 * Framed, so a closed section is not overlooked among the fields around it (a form's
		 * Advanced part).
		 */
		boxed?: boolean;
		children: Snippet;
	}

	let {
		title,
		description,
		open = $bindable(false),
		meta,
		boxed = false,
		children
	}: Props = $props();

	let body = $state<HTMLDivElement>();
	let hasChanges = $state(false);

	/** The caret and the height follow this at once; `open` waits for a closing slide to end. */
	let expanded = $state(false);
	let running: Animation | null = null;

	$effect.pre(() => {
		if (!running) expanded = open;
	});

	function motionReduced(): boolean {
		return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
	}

	function slide(from: number, to: number, closing: boolean): Animation {
		running?.cancel();
		const animation = body!.animate(
			[
				{ height: `${from}px`, opacity: from === 0 ? 0 : 1 },
				{ height: `${to}px`, opacity: to === 0 ? 0 : 1 }
			],
			{
				duration: 220,
				easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
				fill: closing ? 'forwards' : 'none'
			}
		);
		running = animation;
		return animation;
	}

	/** Opens or closes with a slide; with reduced motion <details> just toggles. */
	async function onsummary(event: MouseEvent): Promise<void> {
		if (!body || motionReduced()) return;
		event.preventDefault();
		if (!expanded) {
			const from = open ? body.offsetHeight : 0;
			expanded = true;
			open = true;
			await tick();
			const animation = slide(from, body.scrollHeight, false);
			animation.onfinish = () => {
				if (running === animation) running = null;
			};
		} else {
			expanded = false;
			const animation = slide(body.offsetHeight, 0, true);
			animation.onfinish = async () => {
				if (running !== animation) return;
				open = false;
				await tick();
				animation.cancel();
				running = null;
			};
		}
	}

	/** Watches the marks fields set on themselves (`is-changed`) anywhere inside. */
	$effect(() => {
		if (!body) return;
		const check = () => (hasChanges = !!body?.querySelector('.is-changed'));
		check();
		const observer = new MutationObserver(check);
		observer.observe(body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['class']
		});
		return () => observer.disconnect();
	});
</script>

<details class="disclosure" class:disclosure--boxed={boxed} class:is-expanded={expanded} bind:open>
	<summary onclick={onsummary}>
		<span class="disclosure__caret" aria-hidden="true"><Icon name="caretRight" /></span>
		<span class="disclosure__text">
			<!-- Marks sit right after the title, where the eye already is. -->
			<span class="disclosure__head">
				<span class="disclosure__title">{title}</span>
				{#if meta}<span class="disclosure__meta">{@render meta()}</span>{/if}
				{#if hasChanges}<Badge tone="changed">{t('common.changed')}</Badge>{/if}
			</span>
			{#if description}<span class="disclosure__desc">{description}</span>{/if}
		</span>
	</summary>
	<div class="disclosure__body" bind:this={body}>
		<div class="disclosure__inner">{@render children()}</div>
	</div>
</details>

<style>
	.disclosure {
		min-width: 0;
	}

	summary {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 0;
		border-radius: var(--radius-xs);
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.disclosure__caret {
		display: inline-flex;
		margin-top: 2px;
		color: var(--text-muted);
		transition: rotate 150ms ease;
		--icon-size: var(--icon-sm);
	}

	/* Points along the reading direction when closed, down when open (mirrored in RTL). */
	.is-expanded > summary .disclosure__caret {
		rotate: calc(90deg * var(--dir));
	}

	.disclosure__text {
		display: grid;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}

	.disclosure__title {
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	summary:hover .disclosure__title {
		text-decoration: underline;
	}

	.disclosure__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
	}

	.disclosure__meta {
		display: inline-flex;
		flex-shrink: 0;
		gap: 6px;
	}

	.disclosure__meta:empty {
		display: none;
	}

	.disclosure__desc {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	/* Clipped while it slides. */
	.disclosure__body {
		overflow: hidden;
	}

	.disclosure__inner {
		--row-indent: calc(var(--icon-sm) + 8px);
		display: grid;
		gap: var(--space-field);
		padding-block: var(--space-related) 4px;
		padding-inline-start: var(--row-indent);
	}

	/* Boxed: a frame on a quieter ground, the heading inside it. */
	.disclosure--boxed {
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
	}

	.disclosure--boxed > summary {
		padding: 10px 14px;
	}

	/* Room between the description and the first row, and under the last one. */
	.disclosure--boxed .disclosure__inner {
		--row-indent: calc(1px + 14px + var(--icon-sm) + 8px);
		padding: 16px 14px 18px calc(14px + var(--icon-sm) + 8px);
	}

	@media (prefers-reduced-motion: reduce) {
		.disclosure__caret {
			transition: none;
		}
	}
</style>

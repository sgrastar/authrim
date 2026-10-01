<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '../primitives/Button.svelte';

	/**
	 * Confirms settings that do not take effect immediately. It rises from the bottom edge of
	 * the window as soon as something is changed and sinks back once the changes are saved or
	 * discarded — always at the bottom of what is on screen, however long or short the page.
	 * It floats as a compact card, centred on the column it is placed in (measured, so it
	 * follows the left nav and narrow screens), and while shown the page keeps room at its end
	 * so the last setting can be scrolled above it. Normally placed by SaveScope.
	 */
	interface Props {
		dirty: boolean;
		saving?: boolean;
		/** A field holds something that cannot be saved: the bar says so, Save points to it. */
		invalid?: boolean;
		onsave: () => void;
		ondiscard: () => void;
	}

	let { dirty, saving = false, invalid = false, onsave, ondiscard }: Props = $props();

	const shown = $derived(dirty || saving);

	let slot = $state<HTMLDivElement>();
	let bar = $state<HTMLDivElement>();
	let place = $state({ left: 0, width: 0 });
	let barHeight = $state(0);

	// Follow the column: its position changes with the window, the left nav and the page width.
	$effect(() => {
		if (!slot) return;
		const measure = () => {
			const target = slot!.getBoundingClientRect();
			// position: fixed is relative to the window — unless an ancestor has a transform or
			// filter (a Storybook preview, an animated container), which re-anchors it. Where the
			// bar actually lands with the current `left` reveals that origin; subtract it.
			const origin = bar ? bar.getBoundingClientRect().left - place.left : 0;
			place = { left: target.left - origin, width: target.width };
		};
		// Reads `place` to find the origin; untracked, or writing it would re-run this effect.
		untrack(measure);
		const observer = new ResizeObserver(measure);
		observer.observe(slot);
		window.addEventListener('resize', measure);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', measure);
		};
	});
</script>

<!-- Zero-height marker in the page column; while shown it reserves room for the bar. -->
<div
	class="save-bar-slot"
	class:is-reserving={shown}
	style:--bar-h="{barHeight}px"
	bind:this={slot}
>
	<div
		class="save-bar"
		class:is-shown={shown}
		role="region"
		aria-label={t('common.unsaved')}
		aria-hidden={shown ? undefined : 'true'}
		inert={!shown}
		bind:this={bar}
		style:left="{place.left}px"
		style:width="{place.width}px"
		bind:offsetHeight={barHeight}
	>
		<div class="save-bar__card">
			<p class="save-bar__msg" class:is-invalid={invalid} role="status">
				{shown ? (invalid ? t('common.fixErrors') : t('common.unsaved')) : ''}
			</p>
			<div class="save-bar__actions">
				<Button variant="ghost" disabled={saving} onclick={ondiscard}>{t('common.discard')}</Button>
				<Button variant="primary" loading={saving} onclick={onsave}>
					{saving ? t('common.saving') : t('common.save')}
				</Button>
			</div>
		</div>
	</div>
</div>

<style>
	.save-bar-slot {
		height: 0;
		transition: height 260ms cubic-bezier(0.2, 0.9, 0.3, 1);
	}

	/* Room at the end of the page, so the last setting can scroll above the bar. */
	.save-bar-slot.is-reserving {
		height: calc(var(--bar-h) + 32px);
	}

	/* A lane fixed to the bottom of the window over the column (left/width measured); the card
	   floats in its middle. The lane itself lets clicks through to the page. */
	.save-bar {
		position: fixed;
		bottom: 20px;
		z-index: var(--z-save-bar);
		display: flex;
		justify-content: center;
		padding-inline: 16px;
		pointer-events: none;
		opacity: 0;
		visibility: hidden;
		/* Below the viewport edge: past its own height and the gap under it. */
		translate: 0 calc(100% + 24px);
		transition:
			translate 260ms cubic-bezier(0.4, 0, 1, 1),
			opacity 200ms ease-in,
			visibility 0s 260ms;
	}

	/* As wide as what it says, never wider than the column. */
	.save-bar__card {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 24px;
		max-width: 100%;
		padding: 10px 12px 10px 20px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-panel);
		background: var(--surface-bg);
		-webkit-backdrop-filter: var(--surface-backdrop);
		backdrop-filter: var(--surface-backdrop);
		box-shadow: var(--shadow-lg), var(--surface-highlight);
		pointer-events: auto;
	}

	/* Rises with a slight overshoot-free ease-out; sinks faster with an ease-in. */
	.save-bar.is-shown {
		opacity: 1;
		visibility: visible;
		translate: 0 0;
		transition:
			translate 320ms cubic-bezier(0.2, 0.9, 0.3, 1),
			opacity 160ms ease-out;
	}

	.save-bar__msg {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	/* Same colour as the changes it saves. */
	.is-shown .save-bar__card {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--surface-bg);
	}

	.save-bar__actions {
		display: flex;
		gap: 8px;
		margin-inline-start: auto;
	}

	@media (prefers-reduced-motion: reduce) {
		.save-bar,
		.save-bar.is-shown {
			translate: none;
			transition:
				opacity 120ms,
				visibility 0s 120ms;
		}

		.save-bar.is-shown {
			transition: opacity 120ms;
		}
	}

	.save-bar__msg.is-invalid {
		color: var(--danger);
	}
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import SegmentedControl from '../primitives/SegmentedControl.svelte';

	/**
	 * Shows a page as the end user will see it, at phone or desktop width. The content is a
	 * picture of the page, not the page itself: it cannot be focused or clicked (inert), so
	 * nothing in it is mistaken for a control of the console.
	 */
	interface Props {
		/** Accessible name of the preview, e.g. the screen's name. */
		label: string;
		width?: 'mobile' | 'desktop';
		children: Snippet;
	}

	let { label, width = $bindable('mobile'), children }: Props = $props();
</script>

<div class="preview">
	<SegmentedControl
		label={t('preview.width')}
		size="sm"
		value={width}
		options={[
			{ value: 'mobile', label: t('preview.mobile'), icon: 'device' },
			{ value: 'desktop', label: t('preview.desktop'), icon: 'app' }
		]}
		onchange={(value) => (width = value === 'desktop' ? 'desktop' : 'mobile')}
	/>
	<div class="preview__stage">
		<div class="preview__screen preview__screen--{width}" role="img" aria-label={label}>
			<div class="preview__content" inert>{@render children()}</div>
		</div>
	</div>
</div>

<style>
	.preview {
		display: grid;
		justify-items: start;
		gap: 12px;
		min-width: 0;
	}

	.preview__stage {
		display: grid;
		justify-items: center;
		width: 100%;
		padding: 24px 16px;
		overflow-x: auto;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
	}

	.preview__screen {
		width: 100%;
		max-width: 390px;
		min-height: 480px;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 18px;
		background: var(--bg-page);
		box-shadow: var(--shadow-sm);
		transition:
			max-width 260ms cubic-bezier(0.2, 0.9, 0.3, 1),
			border-radius 260ms;
	}

	.preview__screen--desktop {
		max-width: 960px;
		border-radius: var(--radius-panel);
	}

	.preview__content {
		padding: 28px 20px;
	}

	@media (prefers-reduced-motion: reduce) {
		.preview__screen {
			transition: none;
		}
	}
</style>

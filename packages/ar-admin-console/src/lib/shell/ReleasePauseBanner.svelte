<script lang="ts">
	import { releasePause } from '#lib/api/release-pause.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';

	/**
	 * Says on every page that the environment is being updated and changes are paused, as a flat
	 * full-width band in the shell's `banner` slot (under the environment notice when both show).
	 * Shown while `releasePause` is on; the status region itself is always there, so screen
	 * readers announce the text when it appears.
	 */
	interface Props {
		/** Whether to show it. Not given: follows what the Admin API last answered. */
		active?: boolean;
	}

	let { active }: Props = $props();

	const shown = $derived(active ?? releasePause.active);
</script>

<div role="status">
	{#if shown}
		<p class="release-pause">{t('common.releasePaused')}</p>
	{/if}
</div>

<style>
	.release-pause {
		margin: 0;
		padding: 6px var(--space-page-x);
		border-block-end: 1px solid color-mix(in srgb, var(--info) 24%, transparent);
		background: var(--info-bg);
		color: var(--info-text);
		font-size: var(--fs-small);
		text-align: center;
		overflow-wrap: anywhere;
	}
</style>

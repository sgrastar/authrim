<script lang="ts">
	import type { Snippet } from 'svelte';
	import { THEME_LOOKS } from '../theme/theme-config';

	/**
	 * Storybook helper: renders the same content under every theme and scheme side by side.
	 * Works because themes key off data attributes on any element, not only <html>.
	 */
	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	const looks = THEME_LOOKS;
</script>

<div class="matrix">
	{#each looks as look (look)}
		{#each ['light', 'dark'] as scheme (scheme)}
			<section class="cell" data-admin-theme={look} data-scheme={scheme}>
				<p class="cell__label">{look} · {scheme}</p>
				{@render children()}
			</section>
		{/each}
	{/each}
</div>

<style>
	.matrix {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 12px;
	}

	.cell {
		display: grid;
		align-content: start;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--border);
		background-color: var(--bg-page);
		background-image: var(--page-backdrop);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--fs-body-lg);
		color-scheme: normal;
	}

	.cell__label {
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--fs-small);
	}
</style>

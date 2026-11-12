<script lang="ts">
	import Icon from '../icons/Icon.svelte';

	/** Placeholder while something loads. The label is announced; the spinner is decorative.
	 * `text` adds a visible line above or below the spinner; it is announced too. */
	interface Props {
		label: string;
		text?: string;
		textPosition?: 'top' | 'bottom';
	}

	let { label, text, textPosition = 'bottom' }: Props = $props();
	const visibleText = $derived(text?.trim() ? text : undefined);
</script>

<div class="loading" role="status">
	{#if visibleText !== label}<span class="sr-only">{label}</span>{/if}
	{#if visibleText && textPosition === 'top'}<p class="loading__text">{visibleText}</p>{/if}
	<span class="loading__spin"><Icon name="spinner" /></span>
	{#if visibleText && textPosition === 'bottom'}<p class="loading__text">{visibleText}</p>{/if}
</div>

<style>
	.loading {
		display: flex;
		min-height: 40vh;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-related);
		color: var(--text-muted);
		--icon-size: var(--icon-xl);
	}

	.loading__spin {
		display: inline-flex;
		animation: loading-spin 0.9s linear infinite;
	}

	.loading__text {
		max-width: 40ch;
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
		text-align: center;
	}

	@keyframes loading-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.loading__spin {
			animation-duration: 2.4s;
		}
	}
</style>

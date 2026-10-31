<script lang="ts">
	import Icon from '../icons/Icon.svelte';

	/** Placeholder while something loads. The label is announced; the spinner is decorative. */
	interface Props {
		label: string;
	}

	let { label }: Props = $props();
</script>

<div class="loading" role="status">
	<span class="loading__spin"><Icon name="spinner" /></span>
	<span class="sr-only">{label}</span>
</div>

<style>
	.loading {
		display: grid;
		min-height: 40vh;
		place-items: center;
		color: var(--text-muted);
		--icon-size: var(--icon-xl);
	}

	.loading__spin {
		display: inline-flex;
		animation: loading-spin 0.9s linear infinite;
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

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		size?: 'sm' | 'md' | 'lg' | 'xl';
		color?: 'primary' | 'secondary' | 'white' | 'gray';
	}

	let { size = 'md', color = 'primary', class: className = '', ...restProps }: Props = $props();
</script>

<div
	class={`spinner-shell ${className}`}
	role="status"
	aria-label={$LL.common_loading()}
	{...restProps}
>
	<svg
		class={`spinner spinner--${size} spinner--${color}`}
		xmlns="http://www.w3.org/2000/svg"
		fill="none"
		viewBox="0 0 24 24"
	>
		<circle class="spinner-track" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
		></circle>
		<path
			class="spinner-fill"
			fill="currentColor"
			d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
		></path>
	</svg>
	<span class="sr-only">{$LL.common_loading()}</span>
</div>

<style>
	.spinner-shell {
		display: inline-block;
	}

	.spinner {
		animation: spinner-rotate 1s linear infinite;
		color: var(--spinner-color, var(--color-accent, var(--primary)));
	}

	.spinner--sm {
		width: 1rem;
		height: 1rem;
	}

	.spinner--md {
		width: 2rem;
		height: 2rem;
	}

	.spinner--lg {
		width: 3rem;
		height: 3rem;
	}

	.spinner--xl {
		width: 4rem;
		height: 4rem;
	}

	.spinner--primary {
		--spinner-color: var(--color-accent, var(--primary));
	}

	.spinner--secondary {
		--spinner-color: var(--color-text-muted, var(--text-secondary));
	}

	.spinner--white {
		--spinner-color: var(--color-accent-contrast, #fff);
	}

	.spinner--gray {
		--spinner-color: var(--color-text-subtle, var(--text-muted));
	}

	.spinner-track {
		opacity: 0.25;
	}

	.spinner-fill {
		opacity: 0.75;
	}

	@keyframes spinner-rotate {
		to {
			transform: rotate(360deg);
		}
	}
</style>

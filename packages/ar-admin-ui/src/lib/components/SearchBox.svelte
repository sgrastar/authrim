<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'value'> {
		value?: string;
		width?: string;
	}

	let { value = $bindable(''), width = '300px', placeholder, ...restProps }: Props = $props();

	const displayPlaceholder = $derived(placeholder ?? $LL.common_search_placeholder());
</script>

<div class="search-box" style:width>
	<i class="search-icon i-ph-magnifying-glass"></i>
	<input
		type="search"
		class="search-input"
		bind:value
		placeholder={displayPlaceholder}
		{...restProps}
	/>
</div>

<style>
	.search-box {
		position: relative;
	}

	.search-icon {
		position: absolute;
		left: 16px;
		top: 50%;
		transform: translateY(-50%);
		width: 20px;
		height: 20px;
		color: var(--color-text-subtle);
		pointer-events: none;
	}

	.search-input {
		width: 100%;
		padding: 14px 16px 14px 48px;
		background: var(--control-bg, var(--color-surface));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-lg));
		font-size: 0.9375rem;
		font-family: var(--font-body);
		color: var(--color-text);
		transition: all var(--transition-fast);
	}

	.search-input::placeholder {
		color: var(--color-text-subtle);
	}

	.search-input:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: var(
			--search-focus-shadow,
			var(--control-focus-shadow, 0 0 0 4px var(--color-accent-muted))
		);
	}

	/* Hide native search input cancel button */
	.search-input::-webkit-search-cancel-button {
		-webkit-appearance: none;
	}
</style>

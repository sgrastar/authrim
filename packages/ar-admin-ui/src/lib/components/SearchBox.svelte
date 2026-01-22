<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'value'> {
		value?: string;
		width?: string;
	}

	let {
		value = $bindable(''),
		width = '300px',
		placeholder = 'Search...',
		...restProps
	}: Props = $props();
</script>

<div class="search-box" style:width>
	<i class="search-icon i-ph-magnifying-glass"></i>
	<input type="search" class="search-input" bind:value {placeholder} {...restProps} />
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
		color: var(--text-muted);
		pointer-events: none;
	}

	.search-input {
		width: 100%;
		padding: 14px 16px 14px 48px;
		background: var(--bg-glass);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		font-size: 0.9375rem;
		font-family: var(--font-body);
		color: var(--text-primary);
		backdrop-filter: var(--blur-sm);
		-webkit-backdrop-filter: var(--blur-sm);
		transition: all var(--transition-fast);
	}

	.search-input::placeholder {
		color: var(--text-muted);
	}

	.search-input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 4px var(--primary-light);
	}

	/* Hide native search input cancel button */
	.search-input::-webkit-search-cancel-button {
		-webkit-appearance: none;
	}
</style>

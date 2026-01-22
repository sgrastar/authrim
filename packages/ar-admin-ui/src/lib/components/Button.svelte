<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends HTMLButtonAttributes {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md' | 'lg';
		loading?: boolean;
		icon?: boolean;
		children: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		loading = false,
		icon = false,
		disabled = false,
		type = 'button',
		class: className = '',
		children,
		...restProps
	}: Props = $props();
</script>

<button
	{type}
	disabled={disabled || loading}
	class="btn btn-{variant} btn-{size} {className}"
	class:btn-icon={icon}
	{...restProps}
>
	{#if loading}
		<i class="spinner i-ph-circle-notch"></i>
	{/if}
	{@render children()}
</button>

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px 20px;
		border-radius: var(--radius-lg);
		font-family: var(--font-display);
		font-size: 0.9375rem;
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition: all var(--transition-fast);
		white-space: nowrap;
		position: relative;
		overflow: hidden;
	}

	.btn :global(i) {
		width: 18px;
		height: 18px;
		font-size: 18px;
	}

	/* Primary variant - gradient with glow */
	.btn-primary {
		background: var(--gradient-primary);
		color: white;
		box-shadow: 0 4px 16px rgba(51, 51, 51, 0.3);
	}

	.btn-primary:hover:not(:disabled) {
		transform: translateY(-2px);
		box-shadow: 0 8px 24px rgba(51, 51, 51, 0.4);
	}

	.btn-primary::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(rgba(255, 255, 255, 0.2), transparent);
		opacity: 0;
		transition: opacity var(--transition-fast);
	}

	.btn-primary:hover::after {
		opacity: 1;
	}

	/* Secondary variant - glass effect */
	.btn-secondary {
		background: var(--bg-glass);
		color: var(--text-primary);
		border: 1px solid var(--border);
		backdrop-filter: var(--blur-sm);
		-webkit-backdrop-filter: var(--blur-sm);
	}

	.btn-secondary:hover:not(:disabled) {
		background: white;
		border-color: var(--primary);
		color: var(--primary);
		transform: translateY(-2px);
	}

	/* Ghost variant */
	.btn-ghost {
		background: transparent;
		color: var(--text-secondary);
		box-shadow: none;
	}

	.btn-ghost:hover:not(:disabled) {
		background: var(--primary-light);
		color: var(--primary);
	}

	/* Danger variant */
	.btn-danger {
		background: var(--danger);
		color: white;
		box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3);
	}

	.btn-danger:hover:not(:disabled) {
		background: #dc2626;
		transform: translateY(-2px);
		box-shadow: 0 8px 24px rgba(239, 68, 68, 0.4);
	}

	/* Size variants */
	.btn-sm {
		padding: 8px 14px;
		font-size: 0.8125rem;
	}

	.btn-md {
		padding: 12px 20px;
	}

	.btn-lg {
		padding: 16px 28px;
		font-size: 1rem;
	}

	/* Icon button */
	.btn-icon {
		width: 40px;
		height: 40px;
		padding: 0;
	}

	.btn-icon.btn-sm {
		width: 36px;
		height: 36px;
	}

	.btn-icon.btn-lg {
		width: 48px;
		height: 48px;
	}

	/* Focus state */
	.btn:focus {
		outline: none;
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	/* Disabled state */
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		transform: none !important;
	}

	/* Spinner */
	.spinner {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends HTMLButtonAttributes {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md' | 'lg';
		loading?: boolean;
		children: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		loading = false,
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
	{...restProps}
>
	{#if loading}
		<svg
			class="spinner"
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
		>
			<circle
				class="spinner-track"
				cx="12"
				cy="12"
				r="10"
				stroke="currentColor"
				stroke-width="4"
			></circle>
			<path
				class="spinner-head"
				fill="currentColor"
				d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
			></path>
		</svg>
	{/if}
	{@render children()}
</button>

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		font-weight: 500;
		font-size: 0.875rem;
		line-height: 1.25rem;
		border-radius: 0.5rem;
		border: none;
		cursor: pointer;
		transition: all 150ms ease-in-out;
		box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
	}

	.btn:hover:not(:disabled) {
		box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
	}

	.btn:focus {
		outline: none;
		box-shadow: 0 0 0 2px #fff, 0 0 0 4px #3b82f6;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Primary variant */
	.btn-primary {
		background-color: #2563eb;
		color: white;
	}
	.btn-primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}
	.btn-primary:active:not(:disabled) {
		background-color: #1e40af;
	}

	/* Secondary variant */
	.btn-secondary {
		background-color: #f3f4f6;
		color: #374151;
		border: 1px solid #d1d5db;
	}
	.btn-secondary:hover:not(:disabled) {
		background-color: #e5e7eb;
	}
	.btn-secondary:active:not(:disabled) {
		background-color: #d1d5db;
	}

	/* Ghost variant */
	.btn-ghost {
		background-color: transparent;
		color: #2563eb;
		box-shadow: none;
	}
	.btn-ghost:hover:not(:disabled) {
		background-color: #eff6ff;
	}
	.btn-ghost:active:not(:disabled) {
		background-color: #dbeafe;
	}

	/* Danger variant */
	.btn-danger {
		background-color: #dc2626;
		color: white;
	}
	.btn-danger:hover:not(:disabled) {
		background-color: #b91c1c;
	}
	.btn-danger:active:not(:disabled) {
		background-color: #991b1b;
	}

	/* Size variants */
	.btn-sm {
		padding: 0.375rem 0.75rem;
		font-size: 0.75rem;
	}
	.btn-md {
		/* Default size, no override needed */
	}
	.btn-lg {
		padding: 0.75rem 1.5rem;
		font-size: 1rem;
	}

	/* Dark mode */
	@media (prefers-color-scheme: dark) {
		.btn:focus {
			box-shadow: 0 0 0 2px #1f2937, 0 0 0 4px #60a5fa;
		}
		.btn-primary {
			background-color: #3b82f6;
		}
		.btn-primary:hover:not(:disabled) {
			background-color: #60a5fa;
		}
		.btn-primary:active:not(:disabled) {
			background-color: #3b82f6;
		}
		.btn-secondary {
			background-color: #374151;
			color: #e5e7eb;
			border-color: #4b5563;
		}
		.btn-secondary:hover:not(:disabled) {
			background-color: #4b5563;
		}
		.btn-secondary:active:not(:disabled) {
			background-color: #374151;
		}
		.btn-ghost {
			color: #60a5fa;
		}
		.btn-ghost:hover:not(:disabled) {
			background-color: rgba(59, 130, 246, 0.2);
		}
		.btn-ghost:active:not(:disabled) {
			background-color: rgba(59, 130, 246, 0.3);
		}
		.btn-danger {
			background-color: #ef4444;
		}
		.btn-danger:hover:not(:disabled) {
			background-color: #f87171;
		}
		.btn-danger:active:not(:disabled) {
			background-color: #ef4444;
		}
	}

	/* Spinner */
	.spinner {
		width: 1rem;
		height: 1rem;
		animation: spin 1s linear infinite;
	}
	.spinner-track {
		opacity: 0.25;
	}
	.spinner-head {
		opacity: 0.75;
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

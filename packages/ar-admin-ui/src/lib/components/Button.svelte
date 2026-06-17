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
	aria-busy={loading ? 'true' : undefined}
	class="btn btn-{variant} btn-{size} {className}"
	class:btn-icon={icon}
	{...restProps}
>
	{#if loading}
		<i class="spinner i-ph-circle-notch" aria-hidden="true"></i>
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
		border-radius: var(--radius-control, var(--radius-lg));
		font-family: var(--button-font, var(--font-display));
		font-size: 0.9375rem;
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition: var(--button-transition, all var(--transition-fast));
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
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
		box-shadow: var(--button-primary-shadow, none);
	}

	.btn-primary:hover:not(:disabled) {
		transform: var(--button-hover-transform, translateY(-2px));
		background: var(
			--button-primary-hover-bg,
			color-mix(in srgb, var(--color-accent) 88%, var(--color-text))
		);
	}

	.btn-primary::after {
		content: '';
		position: absolute;
		inset: 0;
		background: var(
			--button-primary-overlay-bg,
			linear-gradient(
				color-mix(in srgb, var(--color-accent-contrast) 20%, transparent),
				transparent
			)
		);
		opacity: 0;
		transition: opacity var(--transition-fast);
	}

	.btn-primary:hover::after {
		opacity: var(--button-primary-overlay-hover-opacity, 1);
	}

	/* Secondary variant - glass effect */
	.btn-secondary {
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
		border-color: var(--color-accent);
		color: var(--color-accent);
		transform: var(--button-hover-transform, translateY(-2px));
	}

	/* Ghost variant */
	.btn-ghost {
		background: transparent;
		color: var(--color-text-muted);
		box-shadow: none;
	}

	.btn-ghost:hover:not(:disabled) {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	/* Danger variant */
	.btn-danger {
		background: var(--color-danger);
		color: var(--color-accent-contrast);
		box-shadow: none;
	}

	.btn-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger) 88%, var(--color-text));
		transform: var(--button-hover-transform, translateY(-2px));
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
		box-shadow: var(
			--button-focus-shadow,
			var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted))
		);
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

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	interface Common {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md' | 'lg';
		icon?: boolean;
		children: Snippet;
	}

	/** A button. */
	type ButtonProps = Common &
		Omit<HTMLButtonAttributes, keyof Common> & {
			href?: undefined;
			reload?: undefined;
			loading?: boolean;
		};

	/**
	 * The same button drawn as a link, for navigation (one control, not a button in a link). A link
	 * is never disabled or busy: render a button for an action that can be.
	 */
	type LinkProps = Common &
		Omit<HTMLAnchorAttributes, keyof Common | 'href' | 'type'> & {
			href: string;
			/** Reload the page instead of client-side navigation. */
			reload?: boolean;
			loading?: never;
			disabled?: never;
			type?: never;
		};

	type Props = ButtonProps | LinkProps;

	let {
		variant = 'primary',
		size = 'md',
		icon = false,
		class: className = '',
		children,
		...rest
	}: Props = $props();
</script>

{#if rest.href !== undefined}
	{@const { href, reload, ...anchor } = rest as LinkProps}
	<a
		{...anchor}
		{href}
		class="btn btn-{variant} btn-{size} {className}"
		class:btn-icon={icon}
		data-sveltekit-reload={reload ? '' : undefined}
	>
		{@render children()}
	</a>
{:else}
	{@const {
		loading = false,
		disabled = false,
		type = 'button',
		href: _href,
		reload: _reload,
		...button
	} = rest as ButtonProps}
	<button
		{...button}
		{type}
		disabled={disabled || loading}
		aria-busy={loading}
		class="btn btn-{variant} btn-{size} {className}"
		class:btn-icon={icon}
	>
		{#if loading}
			<i class="spinner i-ph-circle-notch"></i>
		{/if}
		{@render children()}
	</button>
{/if}

<style>
	.btn {
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: var(--auth-control-height, 0);
		padding: var(--auth-control-padding-y, 12px) var(--auth-control-padding-x, 20px);
		border-radius: var(--radius-lg);
		font-family: var(--font-display);
		font-size: var(--auth-control-font-size, 0.9375rem);
		font-weight: var(--auth-control-font-weight, 600);
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
		/* The theme's primary button, the same as the sign-in buttons (white text on a dark
		   primary would fail on the light primaries of dark themes). */
		background: var(--button-primary-bg, var(--gradient-primary));
		color: var(--button-primary-text, white);
		box-shadow: 0 4px 16px rgba(51, 51, 51, 0.3);
	}

	/* The fill and label stay the theme's on hover: a same-named UnoCSS shortcut would otherwise
	   paint a fixed blue background with white text. */
	.btn-primary:hover:not(:disabled) {
		background: var(--button-primary-bg, var(--gradient-primary));
		color: var(--button-primary-text, white);
		transform: translateY(-2px);
		box-shadow: 0 8px 24px rgba(51, 51, 51, 0.4);
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
		background: var(--bg-card);
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
		background: var(--danger-bg);
		color: var(--danger-text);
		box-shadow: 0 4px 16px rgba(185, 28, 28, 0.25);
	}

	.btn-danger:hover:not(:disabled) {
		background: var(--danger-bg);
		color: var(--danger-text);
		transform: translateY(-2px);
		box-shadow: 0 8px 24px rgba(185, 28, 28, 0.35);
	}

	/* Size variants */
	.btn-sm {
		padding: 8px 14px;
		font-size: 0.8125rem;
	}

	.btn-md {
		padding: var(--auth-control-padding-y, 12px) var(--auth-control-padding-x, 20px);
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

	/* Focus: a solid outline for keyboard focus, apart from the shadows hover changes. */
	.btn:focus {
		outline: none;
	}

	.btn:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
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

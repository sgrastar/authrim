<script lang="ts">
	interface Props {
		href: string;
		icon: string;
		label: string;
		active?: boolean;
		disabled?: boolean;
		badge?: string | number;
	}

	let { href, icon, label, active = false, disabled = false, badge }: Props = $props();
</script>

{#if disabled}
	<span class="nav-item disabled" aria-disabled="true">
		<i class="{icon} nav-icon"></i>
		<span class="nav-item-text">{label}</span>
		{#if badge !== undefined}
			<span class="nav-item-badge">{badge}</span>
		{/if}
	</span>
{:else}
	<a {href} class="nav-item" class:active aria-current={active ? 'page' : undefined}>
		<i class="{icon} nav-icon"></i>
		<span class="nav-item-text">{label}</span>
		{#if badge !== undefined}
			<span class="nav-item-badge">{badge}</span>
		{/if}
	</a>
{/if}

<style>
	.nav-item {
		display: flex;
		align-items: center;
		gap: var(--nav-item-gap, 10px);
		min-height: var(--nav-item-min-height, 32px);
		padding: var(--nav-item-padding, 7px 20px);
		margin-bottom: var(--nav-item-gap-y, 1px);
		border-left: var(--nav-active-border-width, 3px) solid transparent;
		border-radius: var(--nav-item-radius, 0);
		color: var(--nav-text, var(--color-text-muted));
		font-size: var(--nav-item-font-size, 0.9rem);
		font-weight: var(--nav-item-font-weight, 500);
		line-height: var(--nav-item-line-height, 1.35);
		transition: all var(--transition-fast);
		position: relative;
		text-decoration: none;
		cursor: pointer;
	}

	.nav-item :global(.nav-icon) {
		display: var(--nav-icon-display, inline-block);
		width: var(--nav-icon-size, 18px);
		height: var(--nav-icon-size, 18px);
		font-size: var(--nav-icon-size, 18px);
		flex-shrink: 0;
	}

	.nav-item-text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}

	/* Hover state */
	.nav-item:hover:not(.disabled) {
		background: var(--nav-hover-bg, var(--color-surface-muted));
		color: var(--nav-text-hover, var(--color-text));
	}

	/* Active state */
	.nav-item.active {
		background: var(--nav-active-bg, var(--gradient-primary));
		color: var(--nav-active-text, var(--color-accent-contrast));
		border-left-color: var(--nav-active-border, var(--color-accent));
		box-shadow: var(--nav-active-shadow, none);
	}

	.nav-item:focus-visible {
		outline: var(--nav-focus-outline, 2px solid var(--nav-active-border, var(--color-accent)));
		outline-offset: var(--nav-focus-outline-offset, -2px);
	}

	/* Disabled state */
	.nav-item.disabled {
		opacity: 0.3;
		pointer-events: none;
		cursor: not-allowed;
	}

	/* Badge */
	.nav-item-badge {
		position: var(--nav-item-badge-position, absolute);
		top: var(--nav-item-badge-top, 8px);
		right: var(--nav-item-badge-right, 8px);
		margin-left: var(--nav-item-badge-margin-left, 0);
		background: var(--nav-item-badge-bg, var(--color-accent));
		color: var(--nav-item-badge-color, var(--color-accent-contrast));
		font-size: var(--nav-item-badge-font-size, 0.625rem);
		font-weight: var(--nav-item-badge-font-weight, 700);
		padding: var(--nav-item-badge-padding, 2px 6px);
		border-radius: var(--nav-item-badge-radius, var(--radius-full));
		min-width: var(--nav-item-badge-min-width, 18px);
		text-align: center;
	}
</style>

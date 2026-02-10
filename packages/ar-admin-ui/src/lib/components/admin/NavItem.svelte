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
		gap: 14px;
		padding: 4px 12px;
		margin-bottom: 1px;
		border-radius: var(--radius-md);
		color: var(--nav-text, rgba(255, 255, 255, 0.6));
		font-size: 0.9375rem;
		font-weight: 500;
		transition: all var(--transition-fast);
		position: relative;
		text-decoration: none;
		cursor: pointer;
	}

	.nav-item :global(.nav-icon) {
		width: 22px;
		height: 22px;
		font-size: 22px;
		flex-shrink: 0;
		transition: transform var(--transition-fast);
	}

	.nav-item-text {
		opacity: 0;
		transition: opacity var(--transition-base);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}

	/* Expanded state - show text but keep it single line to avoid layout shift */
	:global(.nav-floating.expanded) .nav-item-text,
	:global(.nav-floating.open) .nav-item-text {
		opacity: 1;
	}

	/* Hover state */
	.nav-item:hover:not(.disabled) {
		background: rgba(255, 255, 255, 0.08);
		color: var(--nav-text-hover, var(--text-inverse));
	}

	.nav-item:hover:not(.disabled) :global(.nav-icon) {
		transform: scale(1.1);
	}

	/* Active state */
	.nav-item.active {
		background: var(--nav-active-bg, var(--gradient-primary));
		color: var(--text-inverse);
		box-shadow: 0 4px 16px rgba(51, 51, 51, 0.4);
	}

	/* Disabled state */
	.nav-item.disabled {
		opacity: 0.3;
		pointer-events: none;
		cursor: not-allowed;
	}

	/* Badge */
	.nav-item-badge {
		position: absolute;
		top: 8px;
		right: 8px;
		background: var(--accent);
		color: white;
		font-size: 0.625rem;
		font-weight: 700;
		padding: 2px 6px;
		border-radius: var(--radius-full);
		min-width: 18px;
		text-align: center;
	}

	:global(.nav-floating.expanded) .nav-item-badge,
	:global(.nav-floating.open) .nav-item-badge {
		position: static;
		margin-left: auto;
	}
</style>

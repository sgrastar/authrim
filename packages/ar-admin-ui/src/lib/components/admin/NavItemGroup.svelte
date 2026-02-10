<script lang="ts">
	import { page } from '$app/stores';

	interface NavChild {
		href: string;
		icon?: string;
		label: string;
	}

	interface Props {
		parent: {
			href: string;
			icon: string;
			label: string;
		};
		children: NavChild[];
	}

	let { parent, children }: Props = $props();

	// Check if any child or parent is active
	function isParentActive(): boolean {
		return $page.url.pathname === parent.href;
	}

	function isChildActive(href: string): boolean {
		return $page.url.pathname.startsWith(href);
	}
</script>

<!-- Parent item -->
<a
	href={parent.href}
	class="nav-item nav-parent"
	class:active={isParentActive()}
	aria-current={isParentActive() ? 'page' : undefined}
>
	<i class="{parent.icon} nav-icon"></i>
	<span class="nav-item-text">{parent.label}</span>
</a>

<!-- Children with vertical line -->
<div class="nav-children">
	{#each children as child (child.href)}
		<a
			href={child.href}
			class="nav-item nav-child"
			class:active={isChildActive(child.href)}
			aria-current={isChildActive(child.href) ? 'page' : undefined}
		>
			{#if child.icon}
				<i class="{child.icon} nav-icon nav-icon-small"></i>
			{/if}
			<span class="nav-item-text">{child.label}</span>
		</a>
	{/each}
</div>

<style>
	/* === Parent Nav Item === */
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

	.nav-item :global(.nav-icon-small) {
		width: 18px;
		height: 18px;
		font-size: 18px;
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

	/* Expanded state - show text */
	:global(.nav-floating.expanded) .nav-item-text,
	:global(.nav-floating.open) .nav-item-text {
		opacity: 1;
	}

	/* Hover state */
	.nav-item:hover {
		background: rgba(255, 255, 255, 0.08);
		color: var(--nav-text-hover, var(--text-inverse));
	}

	.nav-item:hover :global(.nav-icon) {
		transform: scale(1.1);
	}

	/* Active state */
	.nav-item.active {
		background: var(--nav-active-bg, var(--gradient-primary));
		color: var(--text-inverse);
		box-shadow: 0 4px 16px rgba(51, 51, 51, 0.4);
	}

	/* === Children Container with Vertical Line === */
	.nav-children {
		position: relative;
		padding-left: 20px;
		margin-left: 18px; /* Align with icon center */
		border-left: 2px solid rgba(255, 255, 255, 0.15);
	}

	/* Hide vertical line when collapsed */
	:global(.nav-floating:not(.expanded):not(.open)) .nav-children {
		border-left-color: transparent;
	}

	/* Child items */
	.nav-child {
		padding: 4px 12px;
		font-size: 0.875rem;
	}

	.nav-child :global(.nav-icon) {
		width: 18px;
		height: 18px;
		font-size: 18px;
	}

	/* Dot indicator for items without icons */
	.nav-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.4);
		flex-shrink: 0;
		margin-left: 6px;
		margin-right: 6px;
	}

	.nav-child.active .nav-dot {
		background: var(--text-inverse);
	}
</style>

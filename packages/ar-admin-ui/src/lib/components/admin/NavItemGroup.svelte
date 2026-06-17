<script lang="ts">
	import { page } from '$app/stores';

	interface NavChild {
		href: string;
		icon?: string;
		label: string;
		activePaths?: string[];
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
		const child = children.find((item) => item.href === href);
		return (
			$page.url.pathname.startsWith(href) ||
			(child?.activePaths?.some(
				(path) => $page.url.pathname === path || $page.url.pathname.startsWith(`${path}/`)
			) ??
				false)
		);
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

	.nav-item :global(.nav-icon-small) {
		width: 18px;
		height: 18px;
		font-size: 18px;
	}

	.nav-item-text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}

	/* Hover state */
	.nav-item:hover {
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

	/* === Children Container with Vertical Line === */
	.nav-children {
		position: relative;
		margin: var(--nav-child-margin, 0);
		padding: var(--nav-child-padding, 0);
		border-left: var(--nav-child-border, none);
	}

	/* Child items */
	.nav-child {
		padding: var(--nav-child-item-padding, 6px 20px 6px 42px);
		font-size: var(--nav-child-font-size, 0.82rem);
	}

	.nav-child :global(.nav-icon) {
		display: var(--nav-icon-display, inline-block);
		width: 18px;
		height: 18px;
		font-size: 18px;
	}

	/* Dot indicator for items without icons */
	.nav-dot {
		width: 6px;
		height: 6px;
		border-radius: var(--nav-item-dot-radius, 50%);
		background: var(--nav-item-dot-bg, var(--nav-text, var(--color-text-muted)));
		flex-shrink: 0;
		margin-left: 6px;
		margin-right: 6px;
	}

	.nav-child.active .nav-dot {
		background: var(--nav-active-text, var(--color-accent-contrast));
	}
</style>

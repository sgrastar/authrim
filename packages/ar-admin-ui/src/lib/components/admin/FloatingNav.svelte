<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		mobileOpen?: boolean;
		onMobileClose?: () => void;
		productName?: string;
		adminLabel?: string;
		productLogoUrl?: string;
		productLogoAlt?: string;
		versionLabel?: string;
		environmentLabel?: string;
		tenantLabel?: string;
		children: Snippet;
	}

	let {
		mobileOpen = false,
		onMobileClose,
		productName = 'Authrim',
		adminLabel = 'ADMIN',
		productLogoUrl = '',
		productLogoAlt = productName,
		versionLabel,
		environmentLabel,
		tenantLabel,
		children
	}: Props = $props();
</script>

<!-- Mobile overlay -->
{#if mobileOpen}
	<button class="mobile-overlay" onclick={onMobileClose} aria-label={$LL.admin_header_close_menu()}
	></button>
{/if}

<nav class="nav-floating" class:open={mobileOpen} aria-label={$LL.admin_nav_main_navigation()}>
	<!-- Header with logo -->
	<div class="nav-header">
		<div class="nav-logo" class:nav-logo--custom={!!productLogoUrl}>
			{#if productLogoUrl}
				<img class="nav-logo-image" src={productLogoUrl} alt={productLogoAlt} />
			{:else}
				<i class="i-ph-stack" aria-hidden="true"></i>
			{/if}
		</div>
		<div class="nav-brand">
			<span class="nav-logo-text">{productName}</span>
			<sup class="nav-logo-sup">{adminLabel}</sup>
		</div>
		{#if mobileOpen}
			<button
				class="mobile-close-btn"
				onclick={onMobileClose}
				aria-label={$LL.admin_header_close_menu()}
			>
				<i class="i-ph-x"></i>
			</button>
		{/if}
	</div>

	<!-- Navigation body -->
	<div class="nav-body">
		{@render children()}
	</div>

	{#if versionLabel || environmentLabel || tenantLabel}
		<div class="nav-footer" aria-label="Admin runtime context">
			{#if versionLabel || environmentLabel}
				<div class="nav-footer-line">
					{#if versionLabel}
						<span>{versionLabel}</span>
					{/if}
					{#if versionLabel && environmentLabel}
						<span aria-hidden="true">-</span>
					{/if}
					{#if environmentLabel}
						<span>{environmentLabel}</span>
					{/if}
				</div>
			{/if}
			{#if tenantLabel}
				<div class="nav-footer-line">{tenantLabel}</div>
			{/if}
		</div>
	{/if}
</nav>

<style>
	/* === Fixed Navigation === */
	.nav-floating {
		position: fixed;
		top: var(--nav-position-top, 0);
		left: var(--nav-position-left, 0);
		bottom: var(--nav-position-bottom, 0);
		height: var(--nav-height, auto);
		width: var(--nav-width-expanded);
		background: var(--nav-bg);
		border: var(--nav-border-all, none);
		border-right: var(--nav-border-width, 1px) solid var(--nav-border);
		border-radius: var(--nav-radius, 0);
		display: flex;
		flex-direction: column;
		z-index: var(--z-nav);
		overflow: hidden;
		box-shadow: var(--nav-shadow, none);
		backdrop-filter: var(--nav-backdrop, none);
		-webkit-backdrop-filter: var(--nav-backdrop, none);
	}

	/* === Nav Header === */
	.nav-header {
		min-height: var(--header-height);
		padding: var(--nav-brand-padding, 20px 24px);
		display: flex;
		align-items: center;
		gap: 12px;
		border-bottom: var(--nav-header-border, 1px solid var(--nav-border));
		background: var(--nav-header-bg, var(--nav-bg));
		position: relative;
		z-index: 2;
		flex: none;
		box-sizing: border-box;
	}

	.nav-logo {
		display: var(--nav-logo-display, none);
		width: 30px;
		height: 30px;
		background: var(--nav-logo-bg, var(--color-accent));
		color: var(--nav-logo-color, var(--color-accent-contrast));
		border-radius: var(--radius-control);
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.nav-logo--custom {
		display: flex;
		background: transparent;
		border: var(--nav-logo-image-border, 1px solid var(--nav-border));
		overflow: hidden;
	}

	.nav-logo :global(i) {
		width: 18px;
		height: 18px;
		font-size: 18px;
	}

	.nav-logo-image {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}

	.nav-brand {
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 7px;
	}

	.nav-logo-text {
		font-family: var(--font-brand, var(--font-display));
		font-weight: var(--brand-weight, 800);
		font-size: var(--brand-size, 1.2rem);
		letter-spacing: var(--brand-letter-spacing, 0);
		text-transform: var(--brand-text-transform, none);
		color: var(--nav-heading);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.nav-logo-sup {
		font-family: var(--nav-sup-font, var(--font-meta, var(--font-body)));
		font-size: var(--nav-sup-size, 0.56rem);
		font-weight: var(--nav-sup-weight, 700);
		letter-spacing: var(--nav-sup-letter-spacing, 0.16em);
		color: var(--nav-sup-color, var(--color-accent));
		vertical-align: baseline;
	}

	/* === Nav Body === */
	.nav-body {
		flex: 1;
		padding: var(--nav-body-padding, 16px 12px 22px);
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none;
		-ms-overflow-style: none;
	}

	.nav-body::-webkit-scrollbar {
		display: none;
	}

	.nav-footer {
		flex: none;
		padding: var(--nav-footer-padding, 12px 20px 16px);
		border-top: var(--nav-footer-border, 1px solid var(--nav-border));
		color: var(--nav-footer-color, var(--nav-group-label-color, var(--color-text-subtle)));
		font-family: var(--nav-footer-font, var(--font-meta, var(--font-body)));
		font-size: var(--nav-footer-size, 0.68rem);
		font-weight: var(--nav-footer-weight, 500);
		line-height: 1.7;
		letter-spacing: var(--nav-footer-letter-spacing, 0.04em);
		background: var(--nav-footer-bg, transparent);
	}

	.nav-footer-line {
		min-width: 0;
		display: flex;
		gap: 6px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* === Mobile Overlay === */
	.mobile-overlay {
		display: none;
		position: fixed;
		inset: 0;
		background: var(--nav-mobile-overlay-bg, var(--color-overlay-scrim));
		z-index: calc(var(--z-nav) - 1);
		border: none;
		padding: 0;
		cursor: pointer;
		appearance: none;
	}

	/* === Mobile Close Button === */
	.mobile-close-btn {
		display: none;
		width: 32px;
		height: 32px;
		border: none;
		background: var(--nav-mobile-close-bg, var(--color-surface-muted));
		border-radius: var(--radius-control);
		color: var(--nav-mobile-close-color, var(--nav-text-hover, var(--color-text)));
		cursor: pointer;
		align-items: center;
		justify-content: center;
		margin-left: auto;
		transition: background var(--transition-fast);
	}

	.mobile-close-btn:hover {
		background: var(--nav-mobile-close-hover-bg, var(--color-surface-muted));
	}

	.mobile-close-btn :global(i) {
		width: 20px;
		height: 20px;
	}

	/* === Responsive === */
	@media (max-width: 768px) {
		.mobile-overlay {
			display: block;
		}

		.mobile-close-btn {
			display: flex;
		}

		.nav-floating {
			transform: translateX(calc(-100% - var(--nav-mobile-position-left, 0px)));
			width: min(var(--nav-mobile-width, var(--nav-width-expanded)), calc(100vw - 24px));
			max-width: calc(100vw - 24px);
			top: var(--nav-mobile-position-top, 0);
			left: var(--nav-mobile-position-left, 0);
			bottom: var(--nav-mobile-position-bottom, 0);
			height: var(--nav-mobile-height, auto);
			border-radius: var(--nav-mobile-radius, 0);
			transition: transform var(--transition-base);
		}

		.nav-floating.open {
			transform: translateX(0);
		}
	}

	@media (max-width: 480px) {
		.nav-floating {
			width: min(var(--nav-mobile-width, var(--nav-width-expanded)), calc(100vw - 16px));
			max-width: calc(100vw - 16px);
		}
	}
</style>

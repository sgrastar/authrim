<script lang="ts">
	/**
	 * The account page frame: document title, header (brand, title, description, sign-out), the
	 * page-level error, the two-column grid the widgets go in, the theme and language controls,
	 * and the configured footer. Reads the Login UI stores from context (the route layout, or
	 * `LoginUIFrame` in Storybook).
	 *
	 * Surfaces inside are flat and still: the page draws many cards at once, so it drops the glass
	 * blur, hover lift and transitions the authentication pages use, through the --card-*,
	 * --control-*, --button-* and --surface-* properties Card, Button and Input read.
	 */
	import type { Snippet } from 'svelte';
	import { Button } from '$lib/components';
	import ConfiguredFooter from '$lib/components/ConfiguredFooter.svelte';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	let {
		brandName = '',
		title,
		description = '',
		locale,
		logoutLoading = false,
		onLogout,
		pageError = '',
		busy = false,
		children,
		dialog
	}: {
		/** The tenant's brand; the product name when empty. */
		brandName?: string;
		title: string;
		description?: string;
		/** The UI language, for the configured footer text. */
		locale?: string;
		logoutLoading?: boolean;
		onLogout: () => void;
		/** A page-level failure (the profile did not load, signing out failed). */
		pageError?: string;
		/** The grid's first load is still running. */
		busy?: boolean;
		/** The grid content: published placements, or the fallback widgets. */
		children: Snippet;
		/** A modal over the page (re-authentication); inside the shell so it shares its surfaces. */
		dialog?: Snippet;
	} = $props();

	const { loginUIPageStore } = useLoginUIStores();
	const brand = $derived(brandName || $LL.app_title());
</script>

<svelte:head>
	<title>{title || $LL.account_title()} - {brand}</title>
</svelte:head>

<div class="account-shell">
	<div class="account-layout">
		<header class="account-header">
			<div>
				<p class="account-kicker">{brand}</p>
				<h1>{title}</h1>
				{#if description}<p class="account-description">{description}</p>{/if}
			</div>
			<Button variant="secondary" loading={logoutLoading} onclick={() => onLogout()}>
				{$LL.header_logout()}
			</Button>
		</header>

		{#if pageError}
			<p class="account-error" role="alert">{pageError}</p>
		{/if}

		<section class="account-grid" aria-busy={busy}>
			{@render children()}
		</section>
	</div>

	{#if loginUIPageStore.showTopbar}
		<div class="account-preferences" data-position={loginUIPageStore.topbarPosition}>
			<LanguageSwitcher
				showThemeToggle={loginUIPageStore.themeToggleEnabled}
				showLanguageSelect={loginUIPageStore.languageSelectEnabled}
			/>
		</div>
	{/if}

	<ConfiguredFooter {locale} class="account-footer" />

	{@render dialog?.()}
</div>

<style>
	.account-shell {
		/* Read by Card, Button and Input (see the component comment). */
		--card-surface: var(--bg-card, #fefdfa);
		--card-shadow: none;
		--control-surface: var(--bg-input, #ffffff);
		--control-hover-surface: var(--surface-muted, var(--bg-subtle, #f7f3ec));
		--button-primary-surface: var(--button-primary-bg, var(--primary, #2c2724));
		--button-shadow: none;
		/* Hover keeps the button's own fill: its label colour is chosen for that fill (a darker
		   --primary-hover under dark text would fail contrast), and a ring marks the hover. */
		--button-primary-hover-shadow: inset 0 0 0 2px
			color-mix(in srgb, var(--button-primary-text, #ffffff) 45%, transparent);
		--surface-backdrop-filter: none;
		--surface-transition: none;
		--surface-hover-transform: none;

		min-height: 100dvh;
		background: var(--bg-page);
		color: var(--text-primary);
		isolation: isolate;
		padding: 24px;
		display: flex;
		flex-direction: column;
	}

	.account-layout {
		width: min(1040px, 100%);
		margin: 0 auto;
	}

	.account-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
	}

	.account-kicker {
		margin: 0 0 4px;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
	}

	.account-description {
		max-width: 60ch;
		margin: 6px 0 0;
		color: var(--text-muted);
		font-size: 0.875rem;
		line-height: 1.6;
	}

	.account-error {
		margin: 0;
		color: var(--danger);
	}

	.account-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
	}

	.account-preferences {
		order: 2;
		width: min(1040px, 100%);
		margin: 24px auto 0;
		display: flex;
		justify-content: center;
	}

	.account-preferences[data-position='in_card'] {
		order: -1;
		justify-content: flex-end;
		margin: 0 auto 24px;
	}

	.account-preferences[data-position='top_right'],
	.account-preferences[data-position='bottom_left'],
	.account-preferences[data-position='bottom_center'],
	.account-preferences[data-position='bottom_right'] {
		position: fixed;
		z-index: 40;
		width: auto;
		margin: 0;
	}

	.account-preferences[data-position='top_right'] {
		top: max(20px, env(safe-area-inset-top));
		right: max(20px, env(safe-area-inset-right));
	}

	.account-preferences[data-position='bottom_left'],
	.account-preferences[data-position='bottom_center'],
	.account-preferences[data-position='bottom_right'] {
		bottom: max(20px, env(safe-area-inset-bottom));
	}

	.account-preferences[data-position='bottom_left'] {
		left: max(20px, env(safe-area-inset-left));
	}

	.account-preferences[data-position='bottom_center'] {
		left: 50%;
		transform: translateX(-50%);
	}

	.account-preferences[data-position='bottom_right'] {
		right: max(20px, env(safe-area-inset-right));
	}

	/* The switcher's controls are app.css classes (they are shared with the authentication pages'
	   top bar), so the flat surface is applied to them here rather than through Card or Button. */
	.account-preferences :global(:is(.theme-toggle, .auth-lang-select)) {
		background: var(--control-surface);
		backdrop-filter: var(--surface-backdrop-filter);
		-webkit-backdrop-filter: var(--surface-backdrop-filter);
		transition: var(--surface-transition);
	}

	.account-preferences :global(:is(.theme-toggle, .auth-lang-select):hover) {
		background: var(--control-hover-surface);
	}

	/* ConfiguredFooter is shared with the authentication pages; its placement is the shell's. */
	.account-shell :global(.account-footer) {
		order: 3;
		align-self: center;
		margin-top: 32px;
		padding-bottom: max(0px, env(safe-area-inset-bottom));
	}

	.account-shell :global(.account-footer p) {
		margin: 0;
	}

	.account-shell :global(.account-footer p + p) {
		margin-top: 6px;
	}

	@media (max-width: 760px) {
		.account-shell {
			padding: 16px;
		}

		.account-grid {
			grid-template-columns: 1fr;
		}

		.account-header {
			align-items: flex-start;
			gap: 16px;
		}
	}
</style>

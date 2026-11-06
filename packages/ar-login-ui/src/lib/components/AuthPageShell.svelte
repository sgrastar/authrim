<script lang="ts">
	import type { Snippet } from 'svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '#lib/stores/login-ui-context.js';
	import { isValidImageUrl } from '#lib/utils/url-validation.js';
	import ConfiguredFooter from './ConfiguredFooter.svelte';
	import LanguageSwitcher from './LanguageSwitcher.svelte';
	import LocalizedTagline from './LocalizedTagline.svelte';

	type Props = {
		children: Snippet;
		wide?: boolean;
		/** Reveal the page parts one after another; login and signup turn it on while they load. */
		entryMotion?: boolean;
		/**
		 * The brand this page shows instead of the tenant's (the discovery page on the common entry
		 * host, which loads no tenant branding). Known when the page renders, so it shows at once.
		 */
		brand?: { name: string; logoUrl: string | null };
	};

	let { children, wide = false, entryMotion = false, brand }: Props = $props();
	const { brandingStore, loginUIPageStore } = useLoginUIStores();
	const brandName = $derived(brand ? brand.name : brandingStore.brandName);
	const brandLogoUrl = $derived(brand ? brand.logoUrl : brandingStore.logoUrl);
	const localizedBrandPanelTitle = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'brandPanelTitle')
	);
	const localizedBrandPanelText = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'brandPanelText')
	);
	const hasBrandingLogo = $derived(Boolean(brandLogoUrl && isValidImageUrl(brandLogoUrl)));
	const showBrandLogo = $derived(
		loginUIPageStore.logoDisplay !== 'hidden' &&
			loginUIPageStore.logoDisplay !== 'text' &&
			hasBrandingLogo
	);
	const showBrandText = $derived(
		loginUIPageStore.logoDisplay !== 'hidden' &&
			(loginUIPageStore.logoDisplay !== 'image' || !hasBrandingLogo)
	);
	/** The logo and name on the brand panel follow `brandPanelLogoDisplay`, which may differ. */
	const panelShowLogo = $derived(
		loginUIPageStore.brandPanelLogoDisplay !== 'hidden' &&
			loginUIPageStore.brandPanelLogoDisplay !== 'text' &&
			hasBrandingLogo
	);
	const panelShowName = $derived(
		loginUIPageStore.brandPanelLogoDisplay !== 'hidden' &&
			(loginUIPageStore.brandPanelLogoDisplay !== 'image' || !hasBrandingLogo)
	);
	/** The header names the page by `headerName` when the tenant set one, else by the brand. */
	const headerTitle = $derived(loginUIPageStore.headerName || brandName || $LL.app_title());
	/** The language and mode switches may sit in the form row, below the form. */
	const topbarInForm = $derived(loginUIPageStore.topbarPosition.startsWith('form_bottom_'));
	/** The page always has a level-one heading: the brand, shown in the header or for screen readers. */
	const showVisibleHeading = $derived(loginUIPageStore.headerEnabled && showBrandText);
</script>

<div
	class="auth-page"
	class:auth-page--entry-motion={entryMotion}
	data-branding-loaded={brand ? '' : undefined}
	class:auth-page--has-footer={loginUIPageStore.footerEnabled}
	style:--login-page-background-color={loginUIPageStore.backgroundColor || undefined}
	data-has-accent-color={loginUIPageStore.accentColor ? 'true' : 'false'}
	style:--login-accent-color={loginUIPageStore.accentColor || undefined}
	style:--login-accent-text={loginUIPageStore.accentTextColor || undefined}
	style:--login-title-color={loginUIPageStore.titleColor || undefined}
	style:--login-text-color={loginUIPageStore.textColor || undefined}
	style:--login-copy-color={loginUIPageStore.copyColor || undefined}
	style:--login-page-background-layer={loginUIPageStore.backgroundImageLayer ?? undefined}
	style:--login-panel-background-layer={loginUIPageStore.loginPanelBackgroundLayer ?? undefined}
	style:--login-panel-background-fill={loginUIPageStore.loginPanelBackgroundColor
		? loginUIPageStore.loginPanelBackgroundGradientColor
			? `linear-gradient(135deg, ${loginUIPageStore.loginPanelBackgroundColor}, ${loginUIPageStore.loginPanelBackgroundGradientColor})`
			: loginUIPageStore.loginPanelBackgroundColor
		: undefined}
	style:--login-panel-background-opacity={String(
		loginUIPageStore.loginPanelBackgroundOpacity / 100
	)}
	style:--login-form-area-color={loginUIPageStore.formAreaColor || undefined}
	style:--login-page-background-opacity={String(loginUIPageStore.backgroundImageOpacity / 100)}
	style:--login-brand-panel-image-layer={loginUIPageStore.brandPanelImageLayer ?? undefined}
	style:--login-brand-panel-image-opacity={String(loginUIPageStore.brandPanelImageOpacity / 100)}
>
	<div class="auth-main">
		{#if loginUIPageStore.showTopbar && loginUIPageStore.topbarPosition !== 'in_card' && !topbarInForm}
			<LanguageSwitcher
				showThemeToggle={loginUIPageStore.themeToggleEnabled}
				showLanguageSelect={loginUIPageStore.languageSelectEnabled}
			/>
		{/if}

		{#if loginUIPageStore.showBrandPanel}
			<aside class="auth-brand-panel" aria-hidden="true">
				{#if loginUIPageStore.brandContentMode !== 'none'}
					<div class="auth-brand-panel__content">
						{#if panelShowLogo && brandLogoUrl}
							<img
								src={brandLogoUrl}
								alt=""
								class="auth-brand-panel__logo"
								onerror={(event) =>
									((event.currentTarget as HTMLImageElement).style.display = 'none')}
							/>
						{/if}
						{#if loginUIPageStore.brandContentMode === 'logo_copy'}
							{#if panelShowName}
								<p class="auth-brand-panel__eyebrow">
									{brandName || $LL.app_title()}
								</p>
							{/if}
							{#if localizedBrandPanelTitle}
								<h2>{localizedBrandPanelTitle}</h2>
							{/if}
							{#if localizedBrandPanelText}
								<p>{localizedBrandPanelText}</p>
							{/if}
						{:else if !panelShowLogo && panelShowName}
							<h2>{brandName || $LL.app_title()}</h2>
						{/if}
					</div>
				{/if}
			</aside>
		{/if}

		<div class="auth-container" class:auth-container--wide={wide}>
			{#if !showVisibleHeading}
				<h1 class="sr-only">{brandName || $LL.app_title()}</h1>
			{/if}
			{#if loginUIPageStore.headerEnabled}
				<header class="auth-header">
					{#if showBrandLogo && brandLogoUrl}
						<img
							src={brandLogoUrl}
							alt={brandName || $LL.common_logoAlt()}
							class="auth-header__logo"
							onerror={(event) =>
								((event.currentTarget as HTMLImageElement).style.display = 'none')}
						/>
					{/if}
					{#if showBrandText}
						<h1 class="auth-header__title">
							{headerTitle}
						</h1>
					{/if}
					{#if loginUIPageStore.subtitleEnabled}
						<p class="auth-header__subtitle">
							<LocalizedTagline />
						</p>
					{/if}
				</header>
			{/if}

			{#if loginUIPageStore.showTopbar && loginUIPageStore.topbarPosition === 'in_card'}
				<LanguageSwitcher
					showThemeToggle={loginUIPageStore.themeToggleEnabled}
					showLanguageSelect={loginUIPageStore.languageSelectEnabled}
				/>
			{/if}

			{@render children()}

			{#if loginUIPageStore.showTopbar && topbarInForm}
				<LanguageSwitcher
					showThemeToggle={loginUIPageStore.themeToggleEnabled}
					showLanguageSelect={loginUIPageStore.languageSelectEnabled}
				/>
			{/if}
		</div>
	</div>

	<ConfiguredFooter class="auth-page-footer" />
</div>

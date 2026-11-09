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
	/**
	 * The language and mode switches may sit in the form row, below the form. In the split template
	 * "below the card" is there too: the form side is one scrolling column, and switches laid over
	 * its foot would cover the form's last lines.
	 */
	const topbarInForm = $derived(
		loginUIPageStore.topbarPosition.startsWith('form_bottom_') ||
			(loginUIPageStore.topbarPosition === 'below_card' &&
				loginUIPageStore.layout === 'split_panel')
	);
	/** The page always has a level-one heading: the brand, shown in the header or for screen readers. */
	const showVisibleHeading = $derived(loginUIPageStore.headerEnabled && showBrandText);
	/**
	 * The colour-mode and language choices in the header or footer bar: the bar and the side, or
	 * null where they sit elsewhere (the store has already moved them out of a bar that is not shown).
	 */
	const topbarInBar = $derived.by(() => {
		if (!loginUIPageStore.showTopbar) return null;
		const match = /^(header|footer)_(left|center|right)$/.exec(loginUIPageStore.topbarPosition);
		return match
			? { bar: match[1] as 'header' | 'footer', side: match[2] as 'left' | 'center' | 'right' }
			: null;
	});
	const BAR_ZONES = ['left', 'center', 'right'] as const;
</script>

{#snippet footerTools()}
	<LanguageSwitcher
		showThemeToggle={loginUIPageStore.themeToggleEnabled}
		showLanguageSelect={loginUIPageStore.languageSelectEnabled}
	/>
{/snippet}

<div
	class="auth-page"
	class:auth-page--entry-motion={entryMotion}
	data-branding-loaded={brand ? '' : undefined}
	class:auth-page--has-footer={loginUIPageStore.footerEnabled}
	class:auth-page--header-bar={loginUIPageStore.headerBar}
	class:auth-page--footer-bar={loginUIPageStore.footerBar}
	data-has-link-color={loginUIPageStore.linkColor ? 'true' : undefined}
	style:--login-link-color={loginUIPageStore.linkColor || undefined}
	style:--login-header-background={loginUIPageStore.headerBackgroundColor || undefined}
	style:--login-header-text={loginUIPageStore.headerTextColor || undefined}
	style:--login-footer-background={loginUIPageStore.footerBackgroundColor || undefined}
	style:--login-footer-text={loginUIPageStore.footerTextColor || undefined}
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
	style:--login-brand-panel-background-color={loginUIPageStore.brandPanelBackgroundColor ||
		undefined}
	style:--login-theme-toggle-background-color={loginUIPageStore.themeToggleBackgroundColor ||
		undefined}
	style:--login-theme-toggle-text-color={loginUIPageStore.themeToggleTextColor || undefined}
	style:--login-language-select-background-color={loginUIPageStore.languageSelectBackgroundColor ||
		undefined}
	style:--login-language-select-text-color={loginUIPageStore.languageSelectTextColor || undefined}
	data-has-field-color={loginUIPageStore.fieldColor ? 'true' : undefined}
	style:--bg-input={loginUIPageStore.fieldColor || undefined}
	style:--field-bg={loginUIPageStore.fieldColor || undefined}
	style:--field-text={loginUIPageStore.fieldColor
		? (loginUIPageStore.fieldTextColor ?? undefined)
		: undefined}
	data-has-secondary-button-color={loginUIPageStore.secondaryButtonColor ? 'true' : undefined}
	style:--button-secondary-bg={loginUIPageStore.secondaryButtonColor || undefined}
	style:--secondary-bg={loginUIPageStore.secondaryButtonColor || undefined}
	style:--secondary-text={loginUIPageStore.secondaryButtonColor
		? (loginUIPageStore.secondaryButtonTextColor ?? undefined)
		: undefined}
	style:--button-secondary-text={loginUIPageStore.secondaryButtonColor
		? (loginUIPageStore.secondaryButtonTextColor ?? undefined)
		: undefined}
	style:--login-page-background-opacity={String(loginUIPageStore.backgroundImageOpacity / 100)}
	style:--login-brand-panel-image-layer={loginUIPageStore.brandPanelImageLayer ?? undefined}
	style:--login-brand-panel-image-opacity={String(loginUIPageStore.brandPanelImageOpacity / 100)}
	data-page-image-filter={loginUIPageStore.backgroundImageFilter ? 'true' : undefined}
	style:--login-page-image-filter={loginUIPageStore.backgroundImageFilter || undefined}
	style:--login-page-image-tone={loginUIPageStore.backgroundImageGrayscale
		? 'linear-gradient(#808080, #808080)'
		: undefined}
	style:--login-panel-background-filter={loginUIPageStore.loginPanelBackgroundGrayscale
		? 'grayscale(1)'
		: undefined}
	style:--login-brand-panel-image-filter={loginUIPageStore.brandPanelImageGrayscale
		? 'grayscale(1)'
		: undefined}
>
	{#if loginUIPageStore.backgroundImageFilter}<span class="auth-image-filter" aria-hidden="true"
		></span>{/if}
	{#if loginUIPageStore.headerBar}
		<!-- The header bar runs along the top of the whole page (over the brand panel too): the brand
		     at its start, middle or end, and the choices on their side when they sit in it. -->
		<header class="auth-bar auth-bar--header" data-align={loginUIPageStore.headerAlign}>
			{#each BAR_ZONES as zone (zone)}
				<div class="auth-bar__zone auth-bar__zone--{zone}">
					{#if loginUIPageStore.headerAlign === zone}
						<div class="auth-bar__brand">
							{#if showBrandLogo && brandLogoUrl}
								<img
									src={brandLogoUrl}
									alt={brandName || $LL.common_logoAlt()}
									class="auth-bar__logo"
									onerror={(event) =>
										((event.currentTarget as HTMLImageElement).style.display = 'none')}
								/>
							{/if}
							{#if showBrandText || loginUIPageStore.subtitleEnabled}
								<div class="auth-bar__text">
									{#if showBrandText}
										<h1 class="auth-bar__title">{headerTitle}</h1>
									{/if}
									{#if loginUIPageStore.subtitleEnabled}
										<p class="auth-bar__subtitle"><LocalizedTagline /></p>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
					{#if topbarInBar?.bar === 'header' && topbarInBar.side === zone}
						<LanguageSwitcher
							showThemeToggle={loginUIPageStore.themeToggleEnabled}
							showLanguageSelect={loginUIPageStore.languageSelectEnabled}
						/>
					{/if}
				</div>
			{/each}
		</header>
	{/if}
	<div class="auth-main">
		{#if loginUIPageStore.backgroundImageFilter}<span class="auth-image-filter" aria-hidden="true"
			></span>{/if}
		{#if loginUIPageStore.showTopbar && loginUIPageStore.topbarPosition !== 'in_card' && !topbarInForm && !topbarInBar}
			<LanguageSwitcher
				showThemeToggle={loginUIPageStore.themeToggleEnabled}
				showLanguageSelect={loginUIPageStore.languageSelectEnabled}
			/>
		{/if}

		{#if loginUIPageStore.showBrandPanel}
			<aside class="auth-brand-panel" aria-hidden="true">
				{#if loginUIPageStore.backgroundImageFilter}<span class="auth-image-filter"></span>{/if}
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
			{#if loginUIPageStore.headerEnabled && !loginUIPageStore.headerBar}
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

	<ConfiguredFooter
		class="auth-page-footer"
		tools={topbarInBar?.bar === 'footer' ? footerTools : undefined}
		toolsSide={topbarInBar?.bar === 'footer' ? topbarInBar.side : undefined}
	/>
</div>

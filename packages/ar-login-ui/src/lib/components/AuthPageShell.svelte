<script lang="ts">
	import type { Snippet } from 'svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { isValidImageUrl } from '$lib/utils/url-validation';
	import ConfiguredFooter from './ConfiguredFooter.svelte';
	import LanguageSwitcher from './LanguageSwitcher.svelte';
	import LocalizedTagline from './LocalizedTagline.svelte';

	type Props = {
		children: Snippet;
		wide?: boolean;
	};

	let { children, wide = false }: Props = $props();
	const { brandingStore, loginUIPageStore } = useLoginUIStores();
	const localizedBrandPanelTitle = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'brandPanelTitle')
	);
	const localizedBrandPanelText = $derived(
		loginUIPageStore.getLocalizedText(getLocale(), 'brandPanelText')
	);
	const hasBrandingLogo = $derived(
		Boolean(brandingStore.logoUrl && isValidImageUrl(brandingStore.logoUrl))
	);
	const showBrandLogo = $derived(
		loginUIPageStore.logoDisplay !== 'hidden' &&
			loginUIPageStore.logoDisplay !== 'text' &&
			hasBrandingLogo
	);
	const showBrandText = $derived(
		loginUIPageStore.logoDisplay !== 'hidden' &&
			(loginUIPageStore.logoDisplay !== 'image' || !hasBrandingLogo)
	);
</script>

<div
	class="auth-page"
	class:auth-page--has-footer={loginUIPageStore.footerEnabled}
	style:--login-page-background-color={loginUIPageStore.backgroundColor || undefined}
	style:--login-accent-color={loginUIPageStore.accentColor || undefined}
	style:--login-title-color={loginUIPageStore.titleColor || undefined}
	style:--login-text-color={loginUIPageStore.textColor || undefined}
	style:--login-copy-color={loginUIPageStore.copyColor || undefined}
	style:--login-page-background-layer={loginUIPageStore.backgroundImageUrl
		? `url("${loginUIPageStore.backgroundImageUrl}")`
		: undefined}
	style:--login-panel-background-layer={loginUIPageStore.loginPanelBackgroundImageUrl
		? `url("${loginUIPageStore.loginPanelBackgroundImageUrl}")`
		: undefined}
	style:--login-panel-background-fill={loginUIPageStore.loginPanelBackgroundColor
		? loginUIPageStore.loginPanelBackgroundGradientColor
			? `linear-gradient(135deg, ${loginUIPageStore.loginPanelBackgroundColor}, ${loginUIPageStore.loginPanelBackgroundGradientColor})`
			: loginUIPageStore.loginPanelBackgroundColor
		: undefined}
	style:--login-panel-background-opacity={String(
		loginUIPageStore.loginPanelBackgroundOpacity / 100
	)}
>
	<div class="auth-main">
		{#if loginUIPageStore.showTopbar && loginUIPageStore.topbarPosition !== 'in_card'}
			<LanguageSwitcher
				showThemeToggle={loginUIPageStore.themeToggleEnabled}
				showLanguageSelect={loginUIPageStore.languageSelectEnabled}
			/>
		{/if}

		{#if loginUIPageStore.showBrandPanel}
			<aside class="auth-brand-panel" aria-hidden="true">
				<div class="auth-brand-panel__content">
					{#if showBrandLogo && brandingStore.logoUrl}
						<img
							src={brandingStore.logoUrl}
							alt=""
							class="auth-brand-panel__logo"
							onerror={(event) =>
								((event.currentTarget as HTMLImageElement).style.display = 'none')}
						/>
					{/if}
					{#if loginUIPageStore.brandContentMode === 'logo_copy'}
						<p class="auth-brand-panel__eyebrow">
							{brandingStore.brandName || $LL.app_title()}
						</p>
						{#if localizedBrandPanelTitle}
							<h2>{localizedBrandPanelTitle}</h2>
						{/if}
						{#if localizedBrandPanelText}
							<p>{localizedBrandPanelText}</p>
						{/if}
					{:else if !showBrandLogo}
						<h2>{brandingStore.brandName || $LL.app_title()}</h2>
					{/if}
				</div>
			</aside>
		{/if}

		<div class="auth-container" class:auth-container--wide={wide}>
			{#if loginUIPageStore.headerEnabled}
				<header class="auth-header">
					{#if showBrandLogo && brandingStore.logoUrl}
						<img
							src={brandingStore.logoUrl}
							alt={brandingStore.brandName || $LL.common_logoAlt()}
							class="auth-header__logo"
							onerror={(event) =>
								((event.currentTarget as HTMLImageElement).style.display = 'none')}
						/>
					{/if}
					{#if showBrandText}
						<h1 class="auth-header__title">
							{brandingStore.brandName || $LL.app_title()}
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
		</div>
	</div>

	<ConfiguredFooter class="auth-page-footer" />
</div>

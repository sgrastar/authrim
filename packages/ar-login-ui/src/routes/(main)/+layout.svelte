<script lang="ts">
	import 'virtual:uno.css';
	import '../../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { setLocale, getLocale } from '$i18n/i18n-svelte';
	import { initializeLoginUIStores } from '#lib/stores/login-ui-context.js';
	import {
		fetchAuthenticationMethods,
		type AuthenticationMethodsResponse
	} from '#lib/api/authentication-methods.js';
	import { page } from '$app/state';
	import EnvironmentBanner from '#lib/components/EnvironmentBanner.svelte';
	import { environmentBannerData, type EnvironmentBannerData } from '#lib/environment-banner.js';
	import { onMount, untrack } from 'svelte';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';
	import { isLoginUILocale, toDocumentDirection, toDocumentLanguage } from '#lib/i18n/locales.js';
	import { applyAuthenticationMethodsToLoginUI } from '#lib/stores/login-ui-configuration.js';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
	const initialPreferredLanguage = untrack(() => data.preferredLanguage);
	if (initialPreferredLanguage && isLoginUILocale(initialPreferredLanguage)) {
		setLocale(initialPreferredLanguage);
	}
	const { brandingStore, languageStore, loginUIPageStore, themeStore } = initializeLoginUIStores();
	const initialAuthenticationMethods = untrack(() => data.authenticationMethods);

	// Set language from server-provided data (from cookie)
	$effect.pre(() => {
		if (data.preferredLanguage && isLoginUILocale(data.preferredLanguage)) {
			setLocale(data.preferredLanguage);
		}

		// Sync html lang attribute with current locale
		if (typeof document !== 'undefined') {
			document.documentElement.lang = toDocumentLanguage(getLocale());
			document.documentElement.dir = toDocumentDirection(getLocale());
		}
	});

	function applyTenantBranding(authenticationMethods: AuthenticationMethodsResponse) {
		applyAuthenticationMethodsToLoginUI(authenticationMethods, {
			brandingStore,
			languageStore,
			loginUIPageStore,
			themeStore
		});
	}

	if (initialAuthenticationMethods) {
		applyTenantBranding(initialAuthenticationMethods);
	}
	// The environment banner of an answer fetched in the browser: the plain sign-in entry has none
	// on the server (no fetch there). Drawn here only when the page data has none, so never twice.
	let clientBanner = $state<EnvironmentBannerData | null>(null);
	// Read only once the browser has an answer (page data is not available to every SSR render).
	const showClientBanner = $derived(
		clientBanner !== null &&
			(page.data as { environmentBanner?: unknown }).environmentBanner == null
	);
	function setClientBanner(answer: AuthenticationMethodsResponse) {
		clientBanner = environmentBannerData(answer, getLocale());
	}

	// After the tenant's mode is known: a tenant that names none opens in the visitor's last mode.
	themeStore.primeFromHint(untrack(() => data.themeHint));
	// The colours of the mode the page opens in, from the first render (then kept in step below).
	loginUIPageStore.setColourMode(untrack(() => themeStore.mode));
	brandingStore.setColourMode(untrack(() => themeStore.mode));

	// Root layouts persist during client-side navigation. Apply newly embedded route data before
	// Svelte updates the page so login/signup transitions never retain the previous/default theme.
	$effect.pre(() => {
		if (data.authenticationMethods) {
			const authenticationMethods = data.authenticationMethods;
			untrack(() => applyTenantBranding(authenticationMethods));
		}
	});

	function getEmbeddedAuthenticationMethods(): AuthenticationMethodsResponse | null {
		const authenticationMethods = (
			page.data as {
				authenticationMethods?: AuthenticationMethodsResponse;
			}
		).authenticationMethods;
		return authenticationMethods ?? null;
	}

	// The tenant's colours are set per mode: show the ones of the mode the page is in.
	$effect(() => {
		loginUIPageStore.setColourMode(themeStore.mode);
		brandingStore.setColourMode(themeStore.mode);
	});

	// Initialize theme on mount
	// Resolution order: localStorage → tenant (API) → system → default
	onMount(async () => {
		if (data.shouldLoadTenantBranding) {
			const embeddedAuthenticationMethods = getEmbeddedAuthenticationMethods();
			if (embeddedAuthenticationMethods) {
				applyTenantBranding(embeddedAuthenticationMethods);
				document.documentElement.setAttribute('data-branding-loaded', '');
				themeStore.init();
				return;
			}

			// Fetch tenant theme defaults when route data does not already embed them.
			try {
				const { data: authenticationMethods } = await fetchAuthenticationMethods();
				if (authenticationMethods) {
					applyTenantBranding(authenticationMethods);
					setClientBanner(authenticationMethods);
				}
				document.documentElement.setAttribute('data-branding-loaded', '');
			} catch {
				// Theme defaults are optional, proceed with system/default
				document.documentElement.setAttribute('data-branding-loaded', '');
			}
		} else {
			document.documentElement.setAttribute('data-branding-loaded', '');
		}

		themeStore.init();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	{#if showClientBanner && clientBanner?.noindex}
		<meta name="robots" content="noindex, nofollow" />
	{/if}
</svelte:head>

{#if showClientBanner && clientBanner}
	<EnvironmentBanner
		text={clientBanner.text}
		textLocalizations={clientBanner.textLocalizations}
		locale={clientBanner.locale}
		follow
	/>
{/if}

<div
	class="login-ui-theme-boundary"
	data-theme={themeStore.mode}
	data-login-theme={loginUIPageStore.themeTemplate}
	data-login-template={loginUIPageStore.template}
	data-login-palette={loginUIPageStore.palette}
	data-form-frame={loginUIPageStore.formFrame}
	data-page-layout={loginUIPageStore.layout}
	data-font-family={loginUIPageStore.fontFamily}
	data-font-scale={loginUIPageStore.fontScale}
	data-language-switcher-position={loginUIPageStore.languageSwitcherPosition}
	data-topbar-position={loginUIPageStore.topbarPosition}
	data-header-style={loginUIPageStore.headerStyle}
	data-footer-style={loginUIPageStore.footerStyle}
	data-logo-layout={loginUIPageStore.logoLayout}
	data-split-frame={loginUIPageStore.splitFrame}
	data-split-panel-side={loginUIPageStore.splitPanelSide}
	data-split-panel-width={loginUIPageStore.splitPanelWidth}
	data-split-background-mode={loginUIPageStore.splitBackgroundMode}
	data-has-page-background-image={loginUIPageStore.backgroundImageUrl ? 'true' : 'false'}
	data-has-login-panel-background-image={loginUIPageStore.loginPanelBackgroundImageUrl
		? 'true'
		: 'false'}
	data-brand-content-mode={loginUIPageStore.brandContentMode}
	data-brand-position={loginUIPageStore.brandPosition}
	data-brand-align={loginUIPageStore.brandAlign}
	data-logo-display={loginUIPageStore.logoDisplay}
	data-brand-panel-logo-display={loginUIPageStore.brandPanelLogoDisplay}
	data-has-brand-panel-image={loginUIPageStore.brandPanelImageUrl ? 'true' : 'false'}
	data-page-background-grayscale={String(loginUIPageStore.backgroundImageGrayscale)}
	data-login-panel-background-grayscale={String(loginUIPageStore.loginPanelBackgroundGrayscale)}
	data-brand-panel-image-grayscale={String(loginUIPageStore.brandPanelImageGrayscale)}
	data-has-form-area-color={loginUIPageStore.formAreaColor ? 'true' : 'false'}
	data-has-brand-panel-background-color={loginUIPageStore.brandPanelBackgroundColor
		? 'true'
		: 'false'}
	data-has-accent-color={loginUIPageStore.accentColor ? 'true' : 'false'}
	data-branding-loaded={brandingStore.isLoaded ? '' : undefined}
	style:--login-page-background-color={loginUIPageStore.backgroundColor || undefined}
	style:--login-accent-color={loginUIPageStore.accentColor || undefined}
	style:--login-accent-text={loginUIPageStore.accentTextColor || undefined}
	style:--login-title-color={loginUIPageStore.titleColor || undefined}
	style:--login-text-color={loginUIPageStore.textColor || undefined}
	style:--login-copy-color={loginUIPageStore.copyColor || undefined}
	style:--login-page-background-layer={loginUIPageStore.backgroundImageLayer ?? undefined}
	style:--login-panel-background-layer={loginUIPageStore.loginPanelBackgroundLayer ?? undefined}
	style:--login-page-image-dim={loginUIPageStore.backgroundImageDimLayer ?? undefined}
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
	style:--login-page-background-opacity={String(loginUIPageStore.backgroundImageOpacity / 100)}
	style:--login-brand-panel-image-layer={loginUIPageStore.brandPanelImageLayer ?? undefined}
	style:--login-panel-background-filter={loginUIPageStore.loginPanelBackgroundFilter || undefined}
	style:--login-brand-panel-image-filter={loginUIPageStore.brandPanelImageFilter || undefined}
	style:--login-brand-panel-image-opacity={String(loginUIPageStore.brandPanelImageOpacity / 100)}
>
	{#if loginUIPageStore.customCss}
		<svelte:element this={'style'} id="authrim-login-ui-custom-css">
			{loginUIPageStore.customCss}
		</svelte:element>
	{/if}
	{@render children()}
</div>

<style>
	.login-ui-theme-boundary {
		display: contents;
	}
</style>

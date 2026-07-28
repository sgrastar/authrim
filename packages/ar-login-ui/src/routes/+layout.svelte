<script lang="ts">
	import 'virtual:uno.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setLocale, getLocale } from '$i18n/i18n-svelte';
	import { initializeLoginUIStores } from '$lib/stores/login-ui-context';
	import {
		fetchAuthenticationMethods,
		type AuthenticationMethodsResponse
	} from '$lib/api/authentication-methods';
	import { page } from '$app/stores';
	import { onMount, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';
	import { isLoginUILocale, toDocumentDirection, toDocumentLanguage } from '$lib/i18n/locales';
	import { applyAuthenticationMethodsToLoginUI } from '$lib/stores/login-ui-configuration';

	let { children, data } = $props<{ children: Snippet; data: LayoutData }>();
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
			get(page).data as {
				authenticationMethods?: AuthenticationMethodsResponse;
			}
		).authenticationMethods;
		return authenticationMethods ?? null;
	}

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
</svelte:head>

<div
	class="login-ui-theme-boundary"
	data-theme={themeStore.mode}
	data-variant={themeStore.currentVariant}
	data-login-theme={loginUIPageStore.themeTemplate}
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
	data-branding-loaded={brandingStore.isLoaded ? '' : undefined}
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

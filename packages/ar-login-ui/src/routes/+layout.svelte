<script lang="ts">
	import 'virtual:uno.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setLocale, getLocale } from '$i18n/i18n-svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import {
		fetchAuthenticationMethods,
		type AuthenticationMethodsResponse
	} from '$lib/api/authentication-methods';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';

	let { children, data } = $props<{ children: Snippet; data: LayoutData }>();

	// Set language from server-provided data (from cookie)
	$effect.pre(() => {
		if (
			data.preferredLanguage &&
			(data.preferredLanguage === 'en' || data.preferredLanguage === 'ja')
		) {
			setLocale(data.preferredLanguage);
		}

		// Sync html lang attribute with current locale
		if (typeof document !== 'undefined') {
			document.documentElement.lang = getLocale();
		}
	});

	function applyTenantBranding(authenticationMethods: AuthenticationMethodsResponse) {
		if (!authenticationMethods.ui) return;
		themeStore.setTenantDefaults(authenticationMethods.ui.theme, authenticationMethods.ui.variant);
		brandingStore.set(
			authenticationMethods.ui.branding.brandName || '',
			authenticationMethods.ui.branding.logoUrl || null
		);
	}

	function getEmbeddedAuthenticationMethods(): AuthenticationMethodsResponse | null {
		const authenticationMethods = (get(page).data as {
			authenticationMethods?: AuthenticationMethodsResponse;
		}).authenticationMethods;
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

{@render children()}

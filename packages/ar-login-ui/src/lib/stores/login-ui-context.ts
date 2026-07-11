import { getContext, setContext } from 'svelte';
import { createBrandingStore } from './branding.svelte';
import { createLoginUIPageStore } from './login-ui-page.svelte';
import { createThemeStore } from './theme.svelte';

const LOGIN_UI_CONTEXT = Symbol('authrim-login-ui-context');

export function initializeLoginUIStores() {
	const stores = {
		brandingStore: createBrandingStore(),
		loginUIPageStore: createLoginUIPageStore(),
		themeStore: createThemeStore()
	};
	setContext(LOGIN_UI_CONTEXT, stores);
	return stores;
}

export type LoginUIStores = ReturnType<typeof initializeLoginUIStores>;

export function useLoginUIStores(): LoginUIStores {
	return getContext<LoginUIStores>(LOGIN_UI_CONTEXT);
}

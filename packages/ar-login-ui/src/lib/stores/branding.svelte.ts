/**
 * Branding Store - Manages tenant branding state
 *
 * Provides brand name and logo URL from the authentication methods API
 * to all pages via a shared reactive store.
 *
 * Populated in +layout.svelte from fetchAuthenticationMethods() response.
 */

export function createBrandingStore() {
	let brandName = $state('');
	let logoUrl = $state<string | null>(null);
	let darkLogoUrl = $state<string | null>(null);
	let darkImagesSet = $state(false);
	let colourMode = $state<'light' | 'dark'>('light');
	let isLoaded = $state(false);

	function set(
		name: string,
		logo: string | null,
		darkLogo: string | null = null,
		hasDarkImages = false
	) {
		brandName = name;
		logoUrl = logo;
		darkLogoUrl = darkLogo;
		darkImagesSet = hasDarkImages;
		isLoaded = true;
	}

	return {
		get brandName() {
			return brandName;
		},
		get logoUrl() {
			return colourMode === 'dark' && darkImagesSet ? darkLogoUrl : logoUrl;
		},
		get isLoaded() {
			return isLoaded;
		},
		set,
		setColourMode(mode: 'light' | 'dark') {
			colourMode = mode;
		}
	};
}

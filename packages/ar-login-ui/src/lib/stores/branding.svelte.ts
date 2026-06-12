/**
 * Branding Store - Manages tenant branding state
 *
 * Provides brand name and logo URL from the authentication methods API
 * to all pages via a shared reactive store.
 *
 * Populated in +layout.svelte from fetchAuthenticationMethods() response.
 */

function createBrandingStore() {
	let brandName = $state('');
	let logoUrl = $state<string | null>(null);
	let isLoaded = $state(false);

	function set(name: string, logo: string | null) {
		brandName = name;
		logoUrl = logo;
		isLoaded = true;
	}

	return {
		get brandName() {
			return brandName;
		},
		get logoUrl() {
			return logoUrl;
		},
		get isLoaded() {
			return isLoaded;
		},
		set
	};
}

// Export singleton instance
export const brandingStore = createBrandingStore();

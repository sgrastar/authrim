import { browser } from '$app/environment';

export interface AdminBrand {
	name: string;
	adminLabel: string;
	logoUrl: string;
	logoAlt: string;
	key: 'default' | 'custom';
}

const DEFAULT_BRAND: AdminBrand = {
	name: 'Authrim',
	adminLabel: 'ADMIN',
	logoUrl: '',
	logoAlt: 'Authrim',
	key: 'default'
};

const STORAGE_KEY_NAME = 'authrim-admin-brand-name';
const STORAGE_KEY_ADMIN_LABEL = 'authrim-admin-brand-admin-label';
const STORAGE_KEY_LOGO_URL = 'authrim-admin-brand-logo-url';

function normalizeBrandName(value: string | null): string {
	const trimmed = value?.trim();
	return trimmed || DEFAULT_BRAND.name;
}

function normalizeAdminLabel(value: string | null): string {
	const trimmed = value?.trim();
	return trimmed || DEFAULT_BRAND.adminLabel;
}

function normalizeLogoUrl(value: string | null): string {
	return value?.trim() || DEFAULT_BRAND.logoUrl;
}

function brandKey(name: string, adminLabel: string, logoUrl: string): AdminBrand['key'] {
	return name === DEFAULT_BRAND.name &&
		adminLabel === DEFAULT_BRAND.adminLabel &&
		logoUrl === DEFAULT_BRAND.logoUrl
		? 'default'
		: 'custom';
}

function createAdminBrandStore() {
	let name = $state(DEFAULT_BRAND.name);
	let adminLabel = $state(DEFAULT_BRAND.adminLabel);
	let logoUrl = $state(DEFAULT_BRAND.logoUrl);
	let isInitialized = $state(false);

	const current = $derived<AdminBrand>({
		name,
		adminLabel,
		logoUrl,
		logoAlt: name,
		key: brandKey(name, adminLabel, logoUrl)
	});

	function applyBrand() {
		if (!browser) return;

		document.documentElement.setAttribute('data-admin-brand', current.key);
	}

	function persist() {
		if (!browser) return;

		localStorage.setItem(STORAGE_KEY_NAME, name);
		localStorage.setItem(STORAGE_KEY_ADMIN_LABEL, adminLabel);
		localStorage.setItem(STORAGE_KEY_LOGO_URL, logoUrl);
	}

	function init() {
		if (!browser) return;

		name = normalizeBrandName(localStorage.getItem(STORAGE_KEY_NAME));
		adminLabel = normalizeAdminLabel(localStorage.getItem(STORAGE_KEY_ADMIN_LABEL));
		logoUrl = normalizeLogoUrl(localStorage.getItem(STORAGE_KEY_LOGO_URL));
		applyBrand();
		isInitialized = true;
	}

	function setBrand(nextBrand: Partial<Pick<AdminBrand, 'name' | 'adminLabel' | 'logoUrl'>>) {
		name = normalizeBrandName(nextBrand.name ?? name);
		adminLabel = normalizeAdminLabel(nextBrand.adminLabel ?? adminLabel);
		logoUrl = normalizeLogoUrl(nextBrand.logoUrl ?? logoUrl);
		applyBrand();
		persist();
	}

	function resetBrand() {
		name = DEFAULT_BRAND.name;
		adminLabel = DEFAULT_BRAND.adminLabel;
		logoUrl = DEFAULT_BRAND.logoUrl;
		applyBrand();
		persist();
	}

	return {
		get current() {
			return current;
		},
		get name() {
			return name;
		},
		get adminLabel() {
			return adminLabel;
		},
		get logoUrl() {
			return logoUrl;
		},
		get logoAlt() {
			return current.logoAlt;
		},
		get key() {
			return current.key;
		},
		get isInitialized() {
			return isInitialized;
		},
		init,
		setBrand,
		resetBrand
	};
}

export const adminBrandStore = createAdminBrandStore();

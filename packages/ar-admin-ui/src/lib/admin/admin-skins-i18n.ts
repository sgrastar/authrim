import type { TranslationFunctions } from '$i18n/i18n-types';
import type { AdminSkin } from '$lib/stores/theme.svelte';

const ADMIN_SKIN_SWATCHES: Record<AdminSkin, string> = {
	classic: 'linear-gradient(135deg, #f9f8f3 0%, #234168 62%, #b58b3b 100%)',
	admin: 'linear-gradient(135deg, #f6f5f1 0%, #141412 56%, #c7512f 100%)',
	'paper-beige': 'linear-gradient(135deg, #f5f1e7 0%, #25332d 58%, #2f7a5a 100%)',
	frosted: 'linear-gradient(135deg, #eef3ff 0%, #d6e2ff 48%, #5b6ee1 100%)'
};

export function getAdminSkinSwatch(skin: AdminSkin): string {
	return ADMIN_SKIN_SWATCHES[skin];
}

export function formatAdminSkinName(skin: AdminSkin, LL: TranslationFunctions): string {
	switch (skin) {
		case 'classic':
			return LL.admin_account_skin_classic();
		case 'admin':
			return LL.admin_account_skin_swiss_grid();
		case 'paper-beige':
			return LL.admin_account_skin_paper_beige();
		case 'frosted':
			return LL.admin_account_skin_frosted();
	}
}

export function formatAdminSkinDescription(skin: AdminSkin, LL: TranslationFunctions): string {
	switch (skin) {
		case 'classic':
			return LL.admin_account_skin_classic_desc();
		case 'admin':
			return LL.admin_account_skin_swiss_grid_desc();
		case 'paper-beige':
			return LL.admin_account_skin_paper_beige_desc();
		case 'frosted':
			return LL.admin_account_skin_frosted_desc();
	}
}

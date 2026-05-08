import { AUTHRIM_MANAGED_BROWSER_SESSION_PROFILE } from '@authrim/core';

export {
	assertNoBrowserTokenMaterial,
	hasBrowserTokenMaterial,
	AUTHRIM_MANAGED_BROWSER_SESSION_PROFILE
} from '@authrim/core';

export type {
	AuthrimSessionProfile as AuthrimLoginUISessionProfile,
	AuthrimWebSdkProfile
} from '@authrim/core';

export const LOGIN_UI_SESSION_PROFILE = AUTHRIM_MANAGED_BROWSER_SESSION_PROFILE;

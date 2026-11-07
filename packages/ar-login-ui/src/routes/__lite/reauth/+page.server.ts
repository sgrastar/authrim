/**
 * The lite re-authentication page (lib/server/lite/reauth.ts).
 */
import type { Actions, PageServerLoad } from './$types';
import { liteReauthActions, liteReauthPage } from '#lib/server/lite/reauth.js';

export const load: PageServerLoad = (event) => liteReauthPage(event);
export const actions: Actions = liteReauthActions;

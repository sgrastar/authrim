/**
 * `/account/<path>`: the same lite account page (the path is only where a sign-in returns to).
 */
import type { Actions, PageServerLoad } from './$types';
import { liteAccountActions, liteAccountPage } from '#lib/server/lite/account.js';

export const load: PageServerLoad = (event) => liteAccountPage(event);
export const actions: Actions = liteAccountActions;

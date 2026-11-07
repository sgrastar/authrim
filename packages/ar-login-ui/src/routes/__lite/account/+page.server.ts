/**
 * The lite account page (lib/server/lite/account.ts).
 */
import type { Actions, PageServerLoad } from './$types';
import { liteAccountActions, liteAccountPage } from '#lib/server/lite/account.js';

export const load: PageServerLoad = (event) => liteAccountPage(event);
export const actions: Actions = liteAccountActions;

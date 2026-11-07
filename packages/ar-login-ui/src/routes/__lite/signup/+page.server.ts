/**
 * The lite sign-up page: the lite step page (lib/server/lite/step-page.ts) for a sign-up, its
 * registration Flow (PR6a: by email code, an invitation's included).
 */
import type { Actions, PageServerLoad } from './$types';
import { liteStepActions, liteStepPage } from '#lib/server/lite/step-page.js';

export const load: PageServerLoad = (event) => liteStepPage(event);
export const actions: Actions = liteStepActions;

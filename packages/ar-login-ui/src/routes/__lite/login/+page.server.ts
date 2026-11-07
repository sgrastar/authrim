/**
 * The lite sign-in page: the lite step page (lib/server/lite/step-page.ts) for sign-in.
 */
import type { Actions, PageServerLoad } from './$types';
import { liteStepActions, liteStepPage } from '#lib/server/lite/step-page.js';

export const load: PageServerLoad = (event) => liteStepPage(event);
export const actions: Actions = liteStepActions;

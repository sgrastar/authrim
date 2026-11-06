import type { PageServerLoad } from './$types';
import { signedOutPage } from '#lib/server/lite/signed-out.js';

export const load: PageServerLoad = (event) => signedOutPage(event.locals.locale);

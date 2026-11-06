import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** An in-scope page whose lite version is not built yet (only a pre-release can reach it). */
export const load: PageServerLoad = () => {
	error(503, 'temporarily_unavailable');
};

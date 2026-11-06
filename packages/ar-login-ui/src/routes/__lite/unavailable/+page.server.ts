import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The tenant's lite policy could not be read: neither UI is served (503), never a guess. */
export const load: PageServerLoad = () => {
	error(503, 'temporarily_unavailable');
};

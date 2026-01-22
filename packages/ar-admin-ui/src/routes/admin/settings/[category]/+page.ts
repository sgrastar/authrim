import { error } from '@sveltejs/kit';
import { CATEGORY_NAMES, type CategoryName } from '$lib/api/admin-settings';

/**
 * Page load function for dynamic category settings page
 *
 * Validates that the category parameter is a known category name.
 * Data fetching is done client-side in the Svelte component.
 */
export function load({ params }: { params: { category: string } }) {
	const { category } = params;

	// Validate category name
	if (!CATEGORY_NAMES.includes(category as CategoryName)) {
		throw error(404, {
			message: `Category '${category}' not found`
		});
	}

	return {
		category: category as CategoryName
	};
}

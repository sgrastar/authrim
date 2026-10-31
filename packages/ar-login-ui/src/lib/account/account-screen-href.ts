/** `#placement-id`: a jump to another placement on the same account page. */
const PLACEMENT_ANCHOR = /^#[a-zA-Z][\w-]*$/u;
/** `/path`, but not `//host` or `/\host`, which browsers resolve to another origin. */
const SAME_ORIGIN_PATH = /^\/(?![/\\])/u;

/**
 * Where a link block of a published account page may point, or null to leave the link out.
 *
 * Allowed: an anchor to a placement the page shows (`isPlacementShown` decides, so a link never
 * jumps to a hidden or disabled section), a same-origin path, or an absolute https URL. Anything
 * else (`javascript:`, `data:`, `http:`, protocol-relative URLs, unparsable text) is dropped.
 */
export function safeAccountScreenHref(
	value: string | null | undefined,
	isPlacementShown: (placementId: string) => boolean
): string | null {
	if (!value) return null;
	if (PLACEMENT_ANCHOR.test(value)) return isPlacementShown(value.slice(1)) ? value : null;
	if (SAME_ORIGIN_PATH.test(value)) return value;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

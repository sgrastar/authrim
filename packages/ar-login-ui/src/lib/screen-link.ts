/**
 * A screen's link part, as the Login UI draws it (the lite pages and the SPA alike).
 */

/**
 * A link's destination as the backend stores it (ar-management `readSafeLinkHref`), checked
 * again before it is drawn: an in-page anchor, a local path, or an https URL; nothing else.
 */
export function safeLinkHref(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const href = value.trim();
	if (!href || href.length > 2048) return null;
	// eslint-disable-next-line no-control-regex -- a control character is what it refuses
	if (/[\\\u0000-\u001f\u007f]/u.test(href)) return null;
	if (href.startsWith('#')) return /^#[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(href) ? href : null;
	if (href.startsWith('/')) return href.startsWith('//') ? null : href;
	try {
		const url = new URL(href);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
}

/** What a link part does (`link_action`; `url` when absent). */
export type ScreenLinkAction = 'url' | 'next' | 'back' | 'skip' | 'exit';

/** An exit's name, as the backend saves it (ar-lib-core `SCREEN_LINK_EXIT_PATTERN`). */
const EXIT_NAME = /^[a-z][a-z0-9_]{0,39}$/u;
const RESERVED_EXITS = new Set(['submitted', 'skipped', 'next']);

/**
 * What a link part does, and for one that leaves the screen by an exit the handle it submits with
 * (`skipped` for a skip, the exit's own name otherwise). Null for a part that cannot be drawn as
 * a working link (an action not known, an exit without a proper name).
 */
export function linkActionOf(part: {
	link_action?: unknown;
	link_exit?: unknown;
}): { action: ScreenLinkAction; exit: string | null } | null {
	const action = part.link_action ?? 'url';
	if (action === 'url' || action === 'next' || action === 'back') return { action, exit: null };
	if (action === 'skip') return { action, exit: 'skipped' };
	if (
		action === 'exit' &&
		typeof part.link_exit === 'string' &&
		EXIT_NAME.test(part.link_exit) &&
		!RESERVED_EXITS.has(part.link_exit)
	) {
		return { action, exit: part.link_exit };
	}
	return null;
}

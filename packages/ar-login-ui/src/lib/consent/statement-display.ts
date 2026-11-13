/**
 * How a consent statement asked on the consent step is shown:
 *
 * - `external`: its text is a document on another site (`document_url`): a link to it.
 * - `embedded`: its text is kept in Authrim: its statement page (`/statements/<slug>`), embedded in
 *   the screen as a scrolling frame (`/statements/<slug>/embed`), above the checkbox.
 * - `inline`: a text kept in Authrim whose key cannot be a page path: the text itself in a
 *   scrolling box (sanitized by the caller).
 * - `plain`: no text to show (only a title and description).
 *
 * The checkbox always says "I agree to <title>", so what is agreed to is never the text itself.
 * The version shown is the one asked (`?version=`), so a version published while the person reads
 * does not replace it.
 */
import { isValidLinkUrl } from '#lib/utils/url-validation.js';

export interface StatementDisplaySource {
	slug: string;
	title: string;
	version: string;
	document_url: string | null;
	inline_content: string | null;
}

export type StatementPresentation =
	| { kind: 'external'; href: string }
	| { kind: 'embedded'; src: string; pageHref: string }
	| { kind: 'inline'; content: string }
	| { kind: 'plain' };

const VERSION = /^\d{8}$/u;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;
/**
 * A key that is one plain path segment (no `/`, no space, not `.` or `..`, which a browser would
 * resolve away): a statement page can be linked to by it.
 */
const PAGE_SLUG = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,128}$/u;

export function isStatementPageSlug(slug: string): boolean {
	return PAGE_SLUG.test(slug);
}

function withQuery(path: string, version?: string | null, lang?: string | null): string {
	const query = new URLSearchParams();
	if (version && VERSION.test(version)) query.set('version', version);
	if (lang && LANGUAGE.test(lang)) query.set('lang', lang);
	const search = query.toString();
	return search ? `${path}?${search}` : path;
}

/** The public statement page of a version: on this host, so the tenant is the same. */
export function statementPageHref(
	slug: string,
	version?: string | null,
	lang?: string | null
): string {
	return withQuery(`/statements/${encodeURIComponent(slug)}`, version, lang);
}

/** The statement page's text alone, for a frame in the consent screen. */
export function statementEmbedHref(
	slug: string,
	version?: string | null,
	lang?: string | null
): string {
	return withQuery(`/statements/${encodeURIComponent(slug)}/embed`, version, lang);
}

/**
 * How an item is shown, in the language the consent step is drawn in (`lang`): the frame and the
 * page show the text in it too.
 */
export function statementPresentation(
	item: StatementDisplaySource,
	lang?: string | null
): StatementPresentation {
	if (item.document_url && isValidLinkUrl(item.document_url)) {
		return { kind: 'external', href: item.document_url };
	}
	if (item.inline_content && isStatementPageSlug(item.slug)) {
		return {
			kind: 'embedded',
			src: statementEmbedHref(item.slug, item.version, lang),
			pageHref: statementPageHref(item.slug, item.version, lang)
		};
	}
	if (item.inline_content) return { kind: 'inline', content: item.inline_content };
	return { kind: 'plain' };
}

/** A version (YYYYMMDD) as a date in the reader's language; the raw value when it is not one. */
export function formatStatementVersion(version: string, locale: string): string {
	const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(version);
	if (!match) return version;
	const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	if (Number.isNaN(date.getTime())) return version;
	try {
		return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
	} catch {
		return `${match[1]}-${match[2]}-${match[3]}`;
	}
}

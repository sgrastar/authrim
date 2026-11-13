/**
 * The public statement page's data: one consent statement's text from
 * `GET /api/v1/consent-statements/:slug` (ar-auth), read the same way by the normal page (in the
 * browser) and the lite page (on the server).
 */
import { API_BASE_URL } from '#lib/api/client.js';
import { isValidLinkUrl } from '#lib/utils/url-validation.js';

export interface StatementPageVersion {
	version: string;
	effectiveAt: number;
	isCurrent: boolean;
}

export interface StatementPageData {
	slug: string;
	title: string;
	description: string;
	language: string;
	/** The text to show (not yet sanitized): null for an external document. */
	inlineContent: string | null;
	/** The external document, when the text is kept on another site. */
	documentUrl: string | null;
	version: StatementPageVersion;
	/** The published versions, newest first. */
	versions: StatementPageVersion[];
}

export type StatementPageResult =
	| { ok: true; statement: StatementPageData }
	| { ok: false; reason: 'not_found' | 'unavailable' };

const SLUG = /^[^/?#\s]{1,128}$/u;
const VERSION = /^\d{8}$/u;

/** Whether a path segment can name a statement (anything else is not found, without a request). */
export function isStatementSlug(value: string): boolean {
	return SLUG.test(value);
}

/** The version a page asks for: a YYYYMMDD value, else none (the current version). */
export function requestedStatementVersion(value: string | null | undefined): string | null {
	return value && VERSION.test(value) ? value : null;
}

export function statementApiPath(slug: string, version: string | null, lang: string): string {
	const query = new URLSearchParams();
	if (version) query.set('version', version);
	if (lang) query.set('lang', lang);
	const search = query.toString();
	return `/api/v1/consent-statements/${encodeURIComponent(slug)}${search ? `?${search}` : ''}`;
}

function readVersion(value: unknown): StatementPageVersion | null {
	if (typeof value !== 'object' || value === null) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.version !== 'string' || !VERSION.test(row.version)) return null;
	return {
		version: row.version,
		effectiveAt: typeof row.effective_at === 'number' ? row.effective_at : 0,
		isCurrent: row.is_current === true
	};
}

/** The API's answer as page data; null when it is not one. */
export function readStatementPage(value: unknown): StatementPageData | null {
	if (typeof value !== 'object' || value === null) return null;
	const body = value as Record<string, unknown>;
	const version = readVersion(body.version);
	if (typeof body.slug !== 'string' || typeof body.title !== 'string' || !version) return null;
	const versions = Array.isArray(body.versions)
		? body.versions.map(readVersion).filter((row): row is StatementPageVersion => row !== null)
		: [];
	const documentUrl =
		typeof body.document_url === 'string' && isValidLinkUrl(body.document_url)
			? body.document_url
			: null;
	const inlineContent =
		body.content_type !== 'url' && typeof body.inline_content === 'string'
			? body.inline_content
			: null;
	return {
		slug: body.slug,
		title: body.title,
		description: typeof body.description === 'string' ? body.description : '',
		language: typeof body.language === 'string' ? body.language : 'en',
		inlineContent,
		documentUrl,
		version,
		versions
	};
}

/** The result of an answer (its status and JSON body). */
export function statementPageResult(status: number, json: unknown): StatementPageResult {
	if (status === 404 || status === 400) return { ok: false, reason: 'not_found' };
	const statement = status === 200 ? readStatementPage(json) : null;
	return statement ? { ok: true, statement } : { ok: false, reason: 'unavailable' };
}

/** Reads the statement from the browser (the normal page). */
export async function fetchStatementPage(
	slug: string,
	version: string | null,
	lang: string,
	fetchFn: typeof fetch = fetch,
	apiBaseUrl = API_BASE_URL
): Promise<StatementPageResult> {
	if (!isStatementSlug(slug)) return { ok: false, reason: 'not_found' };
	const base = apiBaseUrl.trim().replace(/\/$/u, '');
	try {
		const response = await fetchFn(`${base}${statementApiPath(slug, version, lang)}`, {
			method: 'GET',
			// The shared Login UI's tenant choice is a cookie the API proxy reads.
			credentials: 'include'
		});
		const json: unknown = await response.json().catch(() => null);
		return statementPageResult(response.status, json);
	} catch {
		return { ok: false, reason: 'unavailable' };
	}
}

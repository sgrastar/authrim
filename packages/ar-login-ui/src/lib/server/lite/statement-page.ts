/**
 * The statement page drawn on the server (the lite `/statements/<slug>`, and the text framed on the
 * consent step): the statement read through the public API for the request's tenant, drawn
 * without scripts. Its text goes through the SPA's consent
 * HTML sanitizer, as the normal page's does.
 */
import type { TranslationFunctions } from '$i18n/i18n-types';
import { sanitizeRuntimeConsentHtml } from '#lib/consent/runtime-consent-html.js';
import { formatStatementVersion, statementPageHref } from '#lib/consent/statement-display.js';
import {
	isStatementSlug,
	requestedStatementVersion,
	statementApiPath,
	statementPageResult
} from '#lib/api/statement-page.js';

/** Reads a public backend API path (fetchPublicApiForPageRequest); null when it cannot. */
export type StatementApiRead = (path: string) => Promise<{ status: number; json: unknown } | null>;

export type LiteStatementPage =
	| { kind: 'missing'; title: string; message: string | null }
	| {
			kind: 'statement';
			title: string;
			language: string;
			versionLabel: string;
			currentLabel: string;
			isCurrent: boolean;
			older: { message: string; href: string; label: string } | null;
			description: string;
			/** The text, sanitized; null for an external document. */
			html: string | null;
			external: { message: string; href: string; label: string } | null;
			versions: {
				title: string;
				items: Array<{ label: string; href: string | null; current: boolean }>;
			} | null;
	  };

export async function liteStatementPage(
	read: StatementApiRead,
	slug: string,
	versionParam: string | null,
	locale: string,
	LL: TranslationFunctions
): Promise<LiteStatementPage> {
	const unavailable: LiteStatementPage = {
		kind: 'missing',
		title: LL.error_title(),
		message: LL.statement_pageUnavailable()
	};
	if (!isStatementSlug(slug)) {
		return { kind: 'missing', title: LL.statement_pageNotFound(), message: null };
	}
	const version = requestedStatementVersion(versionParam);
	const answer = await read(statementApiPath(slug, version, locale)).catch(() => null);
	if (!answer) return unavailable;
	const result = statementPageResult(answer.status, answer.json);
	if (!result.ok) {
		return result.reason === 'not_found'
			? { kind: 'missing', title: LL.statement_pageNotFound(), message: null }
			: unavailable;
	}
	const statement = result.statement;
	const label = (value: string) =>
		LL.statement_pageVersion({ date: formatStatementVersion(value, locale) });
	return {
		kind: 'statement',
		title: statement.title,
		language: statement.language,
		versionLabel: label(statement.version.version),
		currentLabel: LL.statement_pageCurrent(),
		isCurrent: statement.version.isCurrent,
		older: statement.version.isCurrent
			? null
			: {
					message: LL.statement_pageOlder(),
					href: statementPageHref(statement.slug, null, locale),
					label: LL.statement_pageShowCurrent()
				},
		description: statement.description,
		html: statement.inlineContent ? sanitizeRuntimeConsentHtml(statement.inlineContent) : null,
		external:
			!statement.inlineContent && statement.documentUrl
				? {
						message: LL.statement_pageExternal(),
						href: statement.documentUrl,
						label: LL.consent_item_view_document()
					}
				: null,
		versions:
			statement.versions.length > 1
				? {
						title: LL.statement_pageVersions(),
						items: statement.versions.map((row) => ({
							label: label(row.version),
							href:
								row.version === statement.version.version
									? null
									: statementPageHref(statement.slug, row.isCurrent ? null : row.version, locale),
							current: row.isCurrent
						}))
					}
				: null
	};
}

/**
 * A statement's description as people asked to agree see it: the Login UI shows it as HTML with
 * only `a` (http, https, mailto or a relative link), `br`, `p`, `span` and `strong`, every other
 * tag as text, and line breaks as `<br>`. The same rules as the Login UI's
 * `sanitizeRuntimeConsentHtml`, so the console's preview reads as the sign-in screen does.
 */
export const STATEMENT_HTML_TAGS = ['a', 'br', 'p', 'span', 'strong'] as const;

function escapeHtml(value: string): string {
	return value
		.replace(/&/gu, '&amp;')
		.replace(/</gu, '&lt;')
		.replace(/>/gu, '&gt;')
		.replace(/"/gu, '&quot;')
		.replace(/'/gu, '&#39;');
}

function safeHref(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (/^(?:\/|\.\/|\.\.\/|#)/u.test(trimmed)) return trimmed;
	try {
		const { protocol } = new URL(trimmed);
		return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? trimmed : '';
	} catch {
		return '';
	}
}

function allowedTag(tag: string): string {
	if (/^<br\s*\/?>$/iu.test(tag)) return '<br>';
	const plain = tag.match(/^<(\/?)(p|span|strong)\s*>$/iu);
	if (plain) return `<${plain[1]}${plain[2].toLowerCase()}>`;
	if (/^<\/a\s*>$/iu.test(tag)) return '</a>';
	const anchor = tag.match(/^<a\s+([^>]*)>$/iu);
	if (!anchor) return escapeHtml(tag);
	const href = anchor[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu);
	const target = safeHref(href?.[1] ?? href?.[2] ?? href?.[3] ?? '');
	if (!target) return escapeHtml(tag);
	return `<a href="${escapeHtml(target).replace(/`/gu, '&#x60;')}" target="_blank" rel="noopener noreferrer">`;
}

export function statementDescriptionHtml(value: string | null | undefined): string {
	if (!value) return '';
	let output = '';
	let cursor = 0;
	for (const match of value.matchAll(/<[^>]*>/gu)) {
		output += escapeHtml(value.slice(cursor, match.index));
		output += allowedTag(match[0]);
		cursor = (match.index ?? 0) + match[0].length;
	}
	output += escapeHtml(value.slice(cursor));
	return output.replace(/\n/gu, '<br>');
}

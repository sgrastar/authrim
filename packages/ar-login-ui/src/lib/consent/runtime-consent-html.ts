import { escapeHtml } from '$lib/utils/sanitize';

export function sanitizeRuntimeConsentHtml(value: string | null | undefined): string {
	if (!value) return '';
	let output = '';
	let cursor = 0;
	const tagPattern = /<[^>]*>/g;
	for (const match of value.matchAll(tagPattern)) {
		output += escapeHtml(value.slice(cursor, match.index));
		output += sanitizeAllowedTag(match[0]);
		cursor = (match.index ?? 0) + match[0].length;
	}
	output += escapeHtml(value.slice(cursor));
	return output.replace(/\n/g, '<br>');
}

function sanitizeAllowedTag(tag: string): string {
	if (/^<br\s*\/?>$/i.test(tag)) return '<br>';
	if (/^<p\s*>$/i.test(tag)) return '<p>';
	if (/^<\/p\s*>$/i.test(tag)) return '</p>';
	if (/^<span\s*>$/i.test(tag)) return '<span>';
	if (/^<\/span\s*>$/i.test(tag)) return '</span>';
	if (/^<strong\s*>$/i.test(tag)) return '<strong>';
	if (/^<\/strong\s*>$/i.test(tag)) return '</strong>';
	if (/^<\/a\s*>$/i.test(tag)) return '</a>';
	const anchorMatch = tag.match(/^<a\s+([^>]*)>$/i);
	if (!anchorMatch) return escapeHtml(tag);
	const hrefMatch = anchorMatch[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
	const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
	const safeHref = sanitizeHref(href);
	if (!safeHref) return escapeHtml(tag);
	return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer">`;
}

function sanitizeHref(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (
		trimmed.startsWith('/') ||
		trimmed.startsWith('./') ||
		trimmed.startsWith('../') ||
		trimmed.startsWith('#')
	) {
		return trimmed;
	}
	try {
		const url = new URL(trimmed);
		return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
			? trimmed
			: '';
	} catch {
		return '';
	}
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/`/g, '&#x60;');
}
